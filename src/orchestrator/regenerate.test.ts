import { describe, expect, it, vi } from "vitest";
import { CostMeter } from "../cost/cost-meter.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import { createRegenerateHandler, regenerateWeek } from "./regenerate.js";
import { createRevisionCoordinator } from "./revision-coordinator.js";
import type { RevisionSlackClient } from "./revision-post.js";
import type { Session, SessionStore } from "./session-store.js";

/**
 * `regenerate.ts` tests (bd meal-planner-8u6, RATIFIED design, ADR-0007
 * D2/D4). No real network / SQLite: `SessionStore` is narrowed to
 * `get`/`update` `vi.fn` mocks (matches `revision.test.ts`'s/
 * `approval-handler.test.ts`'s own narrowing convention), and the
 * `RevisionCoordinator` + Slack client are plain fakes.
 */

const WEEK = "2026-07-12";
const RATE = { inputPerMTok: 2, outputPerMTok: 10 };

function session(overrides: Partial<Session> = {}): Session {
  return {
    week_key: WEEK,
    status: "suggested",
    thread_ts: "1000.0001",
    working_plan: { week_key: WEEK, meals: [] },
    turn_count: 0,
    token_spend: 0,
    cost_usd: 0,
    created_at: "2026-07-12T06:00:00.000Z",
    updated_at: "2026-07-12T06:00:00.000Z",
    ...overrides,
  };
}

/** A tiny in-memory `SessionStore` fake -- `get` reflects whatever `update` last wrote. */
function fakeSessionStore(rows: Record<string, Session>): {
  store: Pick<SessionStore, "get" | "update">;
  update: ReturnType<typeof vi.fn>;
} {
  const table = new Map(Object.entries(rows));
  const update = vi.fn((weekKey: string, patch: Partial<Session>) => {
    const row = table.get(weekKey);
    if (!row) {
      throw new Error(`no row for ${weekKey}`);
    }
    table.set(weekKey, { ...row, ...patch });
  });
  return {
    store: {
      get: vi.fn((weekKey: string) => table.get(weekKey) ?? null),
      update,
    },
    update,
  };
}

/**
 * The REAL `RevisionCoordinator` (`./revision-coordinator.js`), with
 * `supersede` wrapped in a `vi.fn` spy and `runExclusive` calls recorded into
 * `runExclusiveCalls` (a plain `vi.fn` around a GENERIC method loses its
 * generic signature -- TS then rejects assigning it back to
 * `RevisionCoordinator["runExclusive"]` -- so this records calls by hand
 * instead) -- avoids re-implementing the coordinator's FIFO-mutex/supersede
 * semantics in a hand-rolled fake.
 */
function spiedCoordinator() {
  const real = createRevisionCoordinator();
  const supersede = vi.fn(real.supersede);
  const runExclusiveCalls: string[] = [];
  return {
    supersede,
    runExclusive<T>(weekKey: string, fn: () => Promise<T>): Promise<T> {
      runExclusiveCalls.push(weekKey);
      return real.runExclusive(weekKey, fn);
    },
    runExclusiveCalls,
    isSuperseded: real.isSuperseded,
  };
}

function fakeSlack(
  response: { ok?: boolean; ts?: string; error?: string } = {
    ok: true,
    ts: "2000.0001",
  },
): { slack: RevisionSlackClient; postMessage: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn(async () => response);
  return { slack: { chat: { postMessage } }, postMessage };
}

function plan(): EnrichedWeekPlan {
  return { week_key: WEEK, meals: [] };
}

describe("regenerateWeek", () => {
  it("full-replace regenerates a suggested week: calls buildPlan, posts a NEW thread reply (thread_ts preserved), writes working_plan, and stays suggested", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();
    const buildPlan = vi.fn(async () => plan());
    const alert = vi.fn(async () => {});

    await regenerateWeek(WEEK, {
      sessionStore: store,
      coordinator,
      buildPlan,
      slack,
      channelId: "C123",
      alert,
      now: () => new Date("2026-07-12T07:00:00.000Z"),
    });

    expect(buildPlan).toHaveBeenCalledWith(WEEK);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C123",
      thread_ts: "1000.0001",
    });

    const row = store.get(WEEK);
    expect(row?.status).toBe("suggested");
    expect(row?.working_plan).toEqual(plan());
    expect(row?.updated_at).toBe("2026-07-12T07:00:00.000Z");
    expect(alert).not.toHaveBeenCalled();
  });

  it("supersedes any in-flight targeted revision as its first action (ADR-0007 D4-style)", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await regenerateWeek(WEEK, {
      sessionStore: store,
      coordinator,
      buildPlan: vi.fn(async () => plan()),
      slack,
      channelId: "C123",
      alert: vi.fn(async () => {}),
    });

    expect(coordinator.supersede).toHaveBeenCalledWith(WEEK);
  });

  it("goes through the coordinator's single-writer serialization (runExclusive keyed by weekKey)", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await regenerateWeek(WEEK, {
      sessionStore: store,
      coordinator,
      buildPlan: vi.fn(async () => plan()),
      slack,
      channelId: "C123",
      alert: vi.fn(async () => {}),
    });

    expect(coordinator.runExclusiveCalls).toEqual([WEEK]);
  });

  it("allows regenerating a COMMITTED week: transitions back to suggested (re-approval required)", async () => {
    const { store } = fakeSessionStore({
      [WEEK]: session({ status: "committed" }),
    });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await regenerateWeek(WEEK, {
      sessionStore: store,
      coordinator,
      buildPlan: vi.fn(async () => plan()),
      slack,
      channelId: "C123",
      alert: vi.fn(async () => {}),
    });

    expect(store.get(WEEK)?.status).toBe("suggested");
  });

  it("refuses to regenerate a paused_cost week: no buildPlan call, no post, row left untouched", async () => {
    const { store, update } = fakeSessionStore({
      [WEEK]: session({ status: "paused_cost" }),
    });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();
    const buildPlan = vi.fn(async () => plan());
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await regenerateWeek(WEEK, {
      sessionStore: store,
      coordinator,
      buildPlan,
      slack,
      channelId: "C123",
      alert: vi.fn(async () => {}),
      logger,
    });

    expect(buildPlan).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(store.get(WEEK)?.status).toBe("paused_cost");
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("paused"));
  });

  it("no-ops (no throw) when there is no session row for weekKey", async () => {
    const { store, update } = fakeSessionStore({});
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();
    const buildPlan = vi.fn(async () => plan());

    await expect(
      regenerateWeek(WEEK, {
        sessionStore: store,
        coordinator,
        buildPlan,
        slack,
        channelId: "C123",
        alert: vi.fn(async () => {}),
      }),
    ).resolves.toBeUndefined();

    expect(buildPlan).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("alerts and rethrows when buildPlan fails, without transitioning the row", async () => {
    const { store, update } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();
    const buildPlan = vi.fn(async () => {
      throw new Error("insufficient pool");
    });
    const alert = vi.fn(async () => {});

    await expect(
      regenerateWeek(WEEK, {
        sessionStore: store,
        coordinator,
        buildPlan,
        slack,
        channelId: "C123",
        alert,
      }),
    ).rejects.toThrow("insufficient pool");

    expect(postMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining("insufficient pool"),
    );
    expect(store.get(WEEK)?.status).toBe("suggested");
  });

  it("with a meter supplied, folds this cycle's spend ADDITIVELY onto the row's existing turn_count/token_spend/cost_usd (ADR-0007 D5 shared pool)", async () => {
    const { store } = fakeSessionStore({
      [WEEK]: session({ turn_count: 2, token_spend: 500, cost_usd: 0.01 }),
    });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();
    const meter = new CostMeter(RATE);
    const buildPlan = vi.fn(async () => {
      // Simulate buildPlan's internal LLM call(s) recording usage onto the
      // SAME meter this cycle was given.
      meter.record({ inputTokens: 1000, outputTokens: 200 });
      return plan();
    });

    await regenerateWeek(WEEK, {
      sessionStore: store,
      coordinator,
      buildPlan,
      slack,
      channelId: "C123",
      alert: vi.fn(async () => {}),
      meter,
    });

    const row = store.get(WEEK);
    expect(row?.turn_count).toBe(3);
    expect(row?.token_spend).toBe(500 + 1200);
    expect(row?.cost_usd).toBeCloseTo(
      0.01 + (1000 / 1e6) * 2 + (200 / 1e6) * 10,
    );
  });

  it("without a meter, still advances turn_count by 1 and leaves token_spend/cost_usd unchanged", async () => {
    const { store } = fakeSessionStore({
      [WEEK]: session({ turn_count: 1, token_spend: 100, cost_usd: 0.02 }),
    });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await regenerateWeek(WEEK, {
      sessionStore: store,
      coordinator,
      buildPlan: vi.fn(async () => plan()),
      slack,
      channelId: "C123",
      alert: vi.fn(async () => {}),
    });

    const row = store.get(WEEK);
    expect(row?.turn_count).toBe(2);
    expect(row?.token_spend).toBe(100);
    expect(row?.cost_usd).toBe(0.02);
  });
});

describe("createRegenerateHandler", () => {
  it("builds a RegenerateHandler that forwards command.weekKey into regenerateWeek", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();
    const buildPlan = vi.fn(async () => plan());

    const handler = createRegenerateHandler({
      sessionStore: store,
      coordinator,
      buildPlan,
      slack,
      channelId: "C123",
      alert: vi.fn(async () => {}),
    });

    await handler.onRegenerate({
      weekKey: WEEK,
      threadTs: "1000.0001",
      command: { command: "/mp-regenerate" },
    });

    expect(buildPlan).toHaveBeenCalledWith(WEEK);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
