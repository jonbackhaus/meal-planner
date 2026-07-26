import { describe, expect, it, vi } from "vitest";
import { createResetHandler, resetWeek } from "./reset.js";
import { createRevisionCoordinator } from "./revision-coordinator.js";
import type { RevisionSlackClient } from "./revision-post.js";
import type { Session, SessionStore } from "./session-store.js";

/**
 * `reset.ts` tests (bd meal-planner-2b2, RATIFIED design 2026-07-26,
 * `/mp-reset`). No real network / SQLite: `SessionStore` is narrowed to
 * `get`/`update` `vi.fn` mocks (matches `regenerate.test.ts`'s own narrowing
 * convention), and the `RevisionCoordinator` + Slack client are plain fakes.
 */

const WEEK = "2026-07-12";
const LAST_POSTED = { week_key: WEEK, meals: [{ recipe_id: "posted" }] };
const IN_FLIGHT = { week_key: WEEK, meals: [{ recipe_id: "in-flight" }] };

function session(overrides: Partial<Session> = {}): Session {
  return {
    week_key: WEEK,
    status: "suggested",
    thread_ts: "1000.0001",
    working_plan: IN_FLIGHT,
    last_posted_plan: LAST_POSTED,
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
 * `supersede` wrapped in a `vi.fn` spy and `runExclusive` calls recorded --
 * mirrors `regenerate.test.ts`'s `spiedCoordinator` exactly.
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

describe("resetWeek", () => {
  it("reverts working_plan to last_posted_plan, posts an in-thread confirmation, and stays suggested", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
      now: () => new Date("2026-07-12T07:00:00.000Z"),
    });

    const row = store.get(WEEK);
    expect(row?.working_plan).toEqual(LAST_POSTED);
    expect(row?.status).toBe("suggested");
    expect(row?.updated_at).toBe("2026-07-12T07:00:00.000Z");

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C123",
      thread_ts: "1000.0001",
    });
  });

  it("supersedes any in-flight targeted revision as its first action (reuses B4 RevisionCoordinator)", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
    });

    expect(coordinator.supersede).toHaveBeenCalledWith(WEEK);
  });

  it("goes through the coordinator's single-writer serialization (runExclusive keyed by weekKey)", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
    });

    expect(coordinator.runExclusiveCalls).toEqual([WEEK]);
  });

  it("from under_revision: cancels the in-flight cycle, reverts the plan, and transitions back to suggested", async () => {
    const { store } = fakeSessionStore({
      [WEEK]: session({ status: "under_revision" }),
    });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
    });

    const row = store.get(WEEK);
    expect(row?.status).toBe("suggested");
    expect(row?.working_plan).toEqual(LAST_POSTED);
  });

  it("from paused_cost: ALSO clears the pause (operator action) back to suggested, reverting the plan", async () => {
    const { store } = fakeSessionStore({
      [WEEK]: session({ status: "paused_cost" }),
    });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
    });

    const row = store.get(WEEK);
    expect(row?.status).toBe("suggested");
    expect(row?.working_plan).toEqual(LAST_POSTED);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("from committed with no in-flight revision: reverts working_plan but stays committed (no re-approval forced)", async () => {
    const { store } = fakeSessionStore({
      [WEEK]: session({ status: "committed" }),
    });
    const coordinator = spiedCoordinator();
    const { slack } = fakeSlack();

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
    });

    const row = store.get(WEEK);
    expect(row?.status).toBe("committed");
    expect(row?.working_plan).toEqual(LAST_POSTED);
  });

  it("no-ops (no throw, no post) when there is no session row for weekKey", async () => {
    const { store, update } = fakeSessionStore({});
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();

    await expect(
      resetWeek(WEEK, {
        sessionStore: store,
        coordinator,
        slack,
        channelId: "C123",
      }),
    ).resolves.toBeUndefined();

    expect(update).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("no-ops when the row has no thread_ts yet (still generating)", async () => {
    const { store, update } = fakeSessionStore({
      [WEEK]: session({ status: "generating", thread_ts: null }),
    });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
      logger,
    });

    expect(update).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("thread_ts"),
    );
  });

  it("no-ops when there is no last_posted_plan checkpoint yet (nothing to revert to)", async () => {
    const { store, update } = fakeSessionStore({
      [WEEK]: session({ last_posted_plan: null }),
    });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
      logger,
    });

    expect(update).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("last_posted_plan"),
    );
  });

  it("makes no LLM/buildPlan call and no Todoist write -- ResetWeekDeps has no such dependency at all", async () => {
    const { store, update } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();

    // Type-level guarantee: ResetWeekDeps below compiles with ONLY
    // sessionStore/coordinator/slack/channelId/now/logger -- no buildPlan, no
    // meter, no todoist client. Behaviorally: exactly one store write and one
    // Slack post -- no extra side effects.
    await resetWeek(WEEK, {
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(store.get(WEEK)?.working_plan).toEqual(LAST_POSTED);
  });
});

describe("createResetHandler", () => {
  it("builds a ResetHandler that forwards command.weekKey into resetWeek", async () => {
    const { store } = fakeSessionStore({ [WEEK]: session() });
    const coordinator = spiedCoordinator();
    const { slack, postMessage } = fakeSlack();

    const handler = createResetHandler({
      sessionStore: store,
      coordinator,
      slack,
      channelId: "C123",
    });

    await handler.onReset({
      weekKey: WEEK,
      threadTs: "1000.0001",
      command: { command: "/mp-reset" },
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(store.get(WEEK)?.working_plan).toEqual(LAST_POSTED);
  });
});
