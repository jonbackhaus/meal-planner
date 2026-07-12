import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import { expirePriorIfUncommitted, generateForWeek } from "./generate.js";
import { SessionStore } from "./session-store.js";

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

  it("post succeeds and a transient write failure recovers within the retry budget -> row ends `suggested`, but the original error still propagates", async () => {
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
    ).rejects.toThrow("transient disk hiccup");

    updateSpy.mockRestore();
    const row = store.get(WEEK);
    expect(row?.status).toBe("suggested");
    expect(row?.thread_ts).toBe("1699999999.000100");
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
    store = makeStore();
    expect(() =>
      expirePriorIfUncommitted(WEEK, { store, now: fakeNow() }),
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
});
