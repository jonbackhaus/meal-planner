import { afterEach, describe, expect, it, vi } from "vitest";
import { CostMeter, costUsd } from "../cost/cost-meter.js";
import { meteredLlmClient } from "../cost/metered-llm-client.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import { expirePriorIfUncommitted, generateForWeek } from "./generate.js";
import { SessionStore } from "./session-store.js";

const RATE = { inputPerMTok: 2, outputPerMTok: 10 };

function makeStore() {
  return new SessionStore({ path: ":memory:" });
}

let store: SessionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

const WEEK = "2026-07-12";
const PRIOR_WEEK = "2026-07-05";

function plan(): EnrichedWeekPlan {
  return {
    week_key: WEEK,
    meals: [],
  };
}

function fakeNow(iso = "2026-07-12T06:00:00.000Z") {
  return vi.fn(() => iso);
}

describe("generateForWeek", () => {
  it("idempotency gate: an existing row causes a skip without calling buildPlan/post", async () => {
    store = makeStore();
    store.insert({
      week_key: WEEK,
      status: "generating",
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const buildPlan = vi.fn(async () => plan());
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const alert = vi.fn(async () => {});

    const result = await generateForWeek(
      WEEK,
      {},
      { store, buildPlan, post, alert, now: fakeNow() },
    );

    expect(result).toBe("skipped");
    expect(buildPlan).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("force:true bypasses the gate when no row exists yet (still generates normally)", async () => {
    store = makeStore();
    const buildPlan = vi.fn(async () => plan());
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const alert = vi.fn(async () => {});

    const result = await generateForWeek(
      WEEK,
      { force: true },
      { store, buildPlan, post, alert, now: fakeNow() },
    );

    expect(result).toBe("generated");
    expect(buildPlan).toHaveBeenCalledWith(WEEK);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("force:true past the gate still hits the store's PK constraint if a row already exists (bd6.6 owns clean-overwrite)", async () => {
    store = makeStore();
    store.insert({
      week_key: WEEK,
      status: "failed",
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const buildPlan = vi.fn(async () => plan());
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const alert = vi.fn(async () => {});

    await expect(
      generateForWeek(
        WEEK,
        { force: true },
        { store, buildPlan, post, alert, now: fakeNow() },
      ),
    ).rejects.toThrow();

    // buildPlan/post are never reached -- the PK constraint fires at insert,
    // before either is called.
    expect(buildPlan).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("happy path: inserts `generating` BEFORE post is called, then ends `suggested` with thread_ts + working_plan", async () => {
    store = makeStore();
    const theStore = store;
    const builtPlan = plan();
    const buildPlan = vi.fn(async () => builtPlan);
    // The post fake is the ordering proof: it asserts the row is already
    // `generating` at the moment it's called, i.e. the insert truly
    // happened before the (irreversible) post side effect.
    const post = vi.fn(async (p: EnrichedWeekPlan) => {
      const row = theStore.get(WEEK);
      expect(row).not.toBeNull();
      expect(row?.status).toBe("generating");
      expect(row?.thread_ts).toBeNull();
      expect(p).toBe(builtPlan);
      return { ts: "1699999999.000100" };
    });
    const alert = vi.fn(async () => {});

    const result = await generateForWeek(
      WEEK,
      {},
      { store, buildPlan, post, alert, now: fakeNow() },
    );

    expect(result).toBe("generated");
    expect(post).toHaveBeenCalledTimes(1);
    const row = store.get(WEEK);
    expect(row?.status).toBe("suggested");
    expect(row?.thread_ts).toBe("1699999999.000100");
    expect(row?.working_plan).toEqual(builtPlan);
  });

  it("buildPlan throws -> row ends `failed`, alert called, no thread_ts written, error propagates", async () => {
    store = makeStore();
    const buildPlan = vi.fn(async () => {
      throw new Error("recipe sync exploded");
    });
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const alert = vi.fn(async () => {});

    await expect(
      generateForWeek(
        WEEK,
        {},
        { store, buildPlan, post, alert, now: fakeNow() },
      ),
    ).rejects.toThrow("recipe sync exploded");

    expect(post).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    const row = store.get(WEEK);
    expect(row?.status).toBe("failed");
    expect(row?.thread_ts).toBeNull();
  });

  it("post throws -> row ends `failed`, alert called, no thread_ts written, error propagates", async () => {
    store = makeStore();
    const buildPlan = vi.fn(async () => plan());
    const post = vi.fn(async () => {
      throw new Error("slack unreachable");
    });
    const alert = vi.fn(async () => {});

    await expect(
      generateForWeek(
        WEEK,
        {},
        { store, buildPlan, post, alert, now: fakeNow() },
      ),
    ).rejects.toThrow("slack unreachable");

    expect(alert).toHaveBeenCalledTimes(1);
    const row = store.get(WEEK);
    expect(row?.status).toBe("failed");
    expect(row?.thread_ts).toBeNull();
  });

  it("post succeeds but the suggested-update throws every time -> after bounded retries the row stays `generating`, error propagates, never left half-written", async () => {
    store = makeStore();
    const buildPlan = vi.fn(async () => plan());
    const post = vi.fn(async () => ({ ts: "1699999999.000100" }));
    const alert = vi.fn(async () => {});
    // Force every store.update call to throw, simulating a faltering local
    // write AFTER the (irreversible) post already succeeded.
    const updateSpy = vi.spyOn(store, "update").mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(
      generateForWeek(
        WEEK,
        {},
        { store, buildPlan, post, alert, now: fakeNow() },
      ),
    ).rejects.toThrow("disk full");

    // Bounded retry: more than one attempt, but not unbounded.
    expect(updateSpy.mock.calls.length).toBeGreaterThan(1);
    expect(updateSpy.mock.calls.length).toBeLessThan(10);

    updateSpy.mockRestore();
    const row = store.get(WEEK);
    // Never left half-written: still `generating`, no thread_ts, no plan.
    expect(row?.status).toBe("generating");
    expect(row?.thread_ts).toBeNull();
    expect(row?.working_plan).toBeNull();
    // alert() is NOT called on this path -- startup catch-up (bd6.4) owns
    // resolving a stale `generating` row, not this bounded-retry path.
    expect(alert).not.toHaveBeenCalled();
  });

  it("post succeeds and a transient write failure recovers within the retry budget -> resolves `generated`, row ends `suggested`, no alert", async () => {
    store = makeStore();
    const buildPlan = vi.fn(async () => plan());
    const post = vi.fn(async () => ({ ts: "1699999999.000100" }));
    const alert = vi.fn(async () => {});
    const realUpdate = store.update.bind(store);
    let calls = 0;
    const updateSpy = vi
      .spyOn(store, "update")
      .mockImplementation((wk, patch) => {
        calls += 1;
        if (calls < 2) {
          throw new Error("transient disk hiccup");
        }
        return realUpdate(wk, patch);
      });

    await expect(
      generateForWeek(
        WEEK,
        {},
        { store, buildPlan, post, alert, now: fakeNow() },
      ),
    ).resolves.toBe("generated");

    updateSpy.mockRestore();
    expect(alert).not.toHaveBeenCalled();
    const row = store.get(WEEK);
    expect(row?.status).toBe("suggested");
    expect(row?.thread_ts).toBe("1699999999.000100");
    expect(row?.working_plan).toEqual(plan());
  });

  describe("cost tracking (bd meal-planner-fkg.1)", () => {
    it("with a meter, persists the SUM of usage across multiple LLM calls within one run onto the suggested row", async () => {
      store = makeStore();
      const meter = new CostMeter(RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 100_000, outputTokens: 50_000 },
        })),
      };
      const llm = meteredLlmClient(inner, meter);
      // Simulates buildPlan's own several Agent SDK calls (selection + a
      // possible repair) within a single run -- SPEC §9.3's "run" aggregates
      // across ALL of them, not per-call.
      const buildPlan = vi.fn(async () => {
        await llm.runQuery({ prompt: "select" });
        await llm.runQuery({ prompt: "repair" });
        return plan();
      });
      const post = vi.fn(async () => ({ ts: "1.1" }));
      const alert = vi.fn(async () => {});

      await generateForWeek(
        WEEK,
        {},
        { store, buildPlan, post, alert, now: fakeNow(), meter },
      );

      const row = store.get(WEEK);
      expect(row?.status).toBe("suggested");
      expect(row?.token_spend).toBe(300_000); // 2 calls x (100k in + 50k out)
      expect(row?.cost_usd).toBeCloseTo(costUsd(200_000, 100_000, RATE), 10);
    });

    it("resets the meter at the START of each run -- a prior run's leftover spend is not carried into this run's persisted total", async () => {
      store = makeStore();
      const meter = new CostMeter(RATE);
      // A prior generateForWeek cycle's leftover usage still sitting in the
      // shared meter, simulating what would happen if reset-per-run were
      // missing.
      meter.record({ inputTokens: 999_000, outputTokens: 999_000 });

      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 10_000, outputTokens: 5_000 },
        })),
      };
      const llm = meteredLlmClient(inner, meter);
      const buildPlan = vi.fn(async () => {
        await llm.runQuery({ prompt: "select" });
        return plan();
      });
      const post = vi.fn(async () => ({ ts: "1.1" }));
      const alert = vi.fn(async () => {});

      await generateForWeek(
        WEEK,
        {},
        { store, buildPlan, post, alert, now: fakeNow(), meter },
      );

      const row = store.get(WEEK);
      expect(row?.token_spend).toBe(15_000);
      expect(row?.cost_usd).toBeCloseTo(costUsd(10_000, 5_000, RATE), 10);
    });

    it("a failed run (buildPlan throws after some LLM calls already recorded usage) still persists the partial spend on the failed row", async () => {
      store = makeStore();
      const meter = new CostMeter(RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 40_000, outputTokens: 10_000 },
        })),
      };
      const llm = meteredLlmClient(inner, meter);
      const buildPlan = vi.fn(async () => {
        await llm.runQuery({ prompt: "select" });
        throw new Error("repair step exploded");
      });
      const post = vi.fn(async () => ({ ts: "1.1" }));
      const alert = vi.fn(async () => {});

      await expect(
        generateForWeek(
          WEEK,
          {},
          { store, buildPlan, post, alert, now: fakeNow(), meter },
        ),
      ).rejects.toThrow("repair step exploded");

      const row = store.get(WEEK);
      expect(row?.status).toBe("failed");
      expect(row?.token_spend).toBe(50_000);
      expect(row?.cost_usd).toBeCloseTo(costUsd(40_000, 10_000, RATE), 10);
    });

    it("without a meter in deps, counters stay 0 -- unchanged pre-fkg.1 behavior", async () => {
      store = makeStore();
      const buildPlan = vi.fn(async () => plan());
      const post = vi.fn(async () => ({ ts: "1.1" }));
      const alert = vi.fn(async () => {});

      await generateForWeek(
        WEEK,
        {},
        { store, buildPlan, post, alert, now: fakeNow() },
      );

      const row = store.get(WEEK);
      expect(row?.token_spend).toBe(0);
      expect(row?.cost_usd).toBe(0);
    });
  });
});

describe("expirePriorIfUncommitted", () => {
  it("expires a prior week that is `suggested`", () => {
    store = makeStore();
    store.insert({
      week_key: PRIOR_WEEK,
      status: "suggested",
      thread_ts: "old.ts",
      created_at: "2026-07-05T06:00:00.000Z",
      updated_at: "2026-07-05T06:00:00.000Z",
    });

    expirePriorIfUncommitted(WEEK, { store, now: fakeNow() });

    expect(store.get(PRIOR_WEEK)?.status).toBe("expired");
  });

  it("expires a prior week that is `under_revision`", () => {
    store = makeStore();
    store.insert({
      week_key: PRIOR_WEEK,
      status: "under_revision",
      created_at: "2026-07-05T06:00:00.000Z",
      updated_at: "2026-07-05T06:00:00.000Z",
    });

    expirePriorIfUncommitted(WEEK, { store, now: fakeNow() });

    expect(store.get(PRIOR_WEEK)?.status).toBe("expired");
  });

  it.each([
    "committed",
    "failed",
    "expired",
  ] as const)("leaves a prior week that is already `%s` untouched", (status) => {
    store = makeStore();
    store.insert({
      week_key: PRIOR_WEEK,
      status,
      created_at: "2026-07-05T06:00:00.000Z",
      updated_at: "2026-07-05T06:00:00.000Z",
    });

    expirePriorIfUncommitted(WEEK, { store, now: fakeNow() });

    expect(store.get(PRIOR_WEEK)?.status).toBe(status);
  });

  it("no-ops when there is no prior row at all", () => {
    const s = makeStore();
    expect(() =>
      expirePriorIfUncommitted(WEEK, { store: s, now: fakeNow() }),
    ).not.toThrow();
  });

  it("is piggybacked inside generateForWeek: a prior `suggested` week is expired when the new week generates", async () => {
    store = makeStore();
    store.insert({
      week_key: PRIOR_WEEK,
      status: "suggested",
      thread_ts: "old.ts",
      created_at: "2026-07-05T06:00:00.000Z",
      updated_at: "2026-07-05T06:00:00.000Z",
    });
    const buildPlan = vi.fn(async () => plan());
    const post = vi.fn(async () => ({ ts: "new.ts" }));
    const alert = vi.fn(async () => {});

    await generateForWeek(
      WEEK,
      {},
      { store, buildPlan, post, alert, now: fakeNow() },
    );

    expect(store.get(PRIOR_WEEK)?.status).toBe("expired");
  });

  it("a failing (cosmetic) prior-week expiry does not abort current-week generation", async () => {
    store = makeStore();
    store.insert({
      week_key: PRIOR_WEEK,
      status: "suggested",
      thread_ts: "old.ts",
      created_at: "2026-07-05T06:00:00.000Z",
      updated_at: "2026-07-05T06:00:00.000Z",
    });
    // Simulate a store fault specifically while expiring the PRIOR week --
    // the current week's own writes (later in the same run) must still
    // succeed normally.
    const realUpdate = store.update.bind(store);
    const updateSpy = vi
      .spyOn(store, "update")
      .mockImplementation((wk, patch) => {
        if (wk === PRIOR_WEEK) {
          throw new Error("expiry store fault");
        }
        return realUpdate(wk, patch);
      });
    const builtPlan = plan();
    const buildPlan = vi.fn(async () => builtPlan);
    const post = vi.fn(async () => ({ ts: "new.ts" }));
    const alert = vi.fn(async () => {});

    const result = await generateForWeek(
      WEEK,
      {},
      { store, buildPlan, post, alert, now: fakeNow() },
    );

    updateSpy.mockRestore();

    expect(result).toBe("generated");
    expect(post).toHaveBeenCalledTimes(1);
    const row = store.get(WEEK);
    expect(row?.status).toBe("suggested");
    expect(row?.thread_ts).toBe("new.ts");
    expect(row?.working_plan).toEqual(builtPlan);
    // The prior row is untouched (its expiry-write faulted) -- not this
    // function's problem to recover, only not to crash on.
    expect(store.get(PRIOR_WEEK)?.status).toBe("suggested");
  });
});
