import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult, RunQueryInput } from "../llm/llm-client.js";
import type {
  InboundThreadReply,
  RevisionHandler,
} from "../slack/inbound-router.js";
import {
  createRevisionCostGuard,
  type RevisionCostCaps,
} from "./revision-cost-guard.js";
import type { RevisionSlackClient } from "./revision-post.js";
import type { Session, SessionStore } from "./session-store.js";

/**
 * `revision-cost-guard.ts` tests (bd meal-planner-3e2.6, ADR-0007 D5/D6/D7,
 * SPEC §9.3). No real network / SQLite: `SessionStore` is narrowed to
 * `get`/`update` `vi.fn` mocks backed by an in-memory `Map` (matches
 * `revision-coordinator.test.ts`'s own convention), and the LLM client /
 * Slack client / `#agent-alerts` alerter are all fakes.
 */

function threadReply(
  overrides: Partial<InboundThreadReply> = {},
): InboundThreadReply {
  return {
    weekKey: "2026-07-12",
    threadTs: "1000.0001",
    event: {
      type: "message",
      channel: "C123",
      user: "U123",
      ts: "1000.0002",
      thread_ts: "1000.0001",
      text: "how about tacos instead",
    },
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    week_key: "2026-07-12",
    status: "suggested",
    thread_ts: "1000.0001",
    working_plan: { week_key: "2026-07-12", meals: [] },
    last_posted_plan: { week_key: "2026-07-12", meals: [] },
    turn_count: 0,
    token_spend: 0,
    cost_usd: 0,
    created_at: "2026-07-12T06:00:00.000Z",
    updated_at: "2026-07-12T06:00:00.000Z",
    ...overrides,
  };
}

/** A tiny in-memory `SessionStore` fake -- `get` reflects whatever `update` last wrote. */
function fakeSessionStore(rows: Record<string, Session>) {
  const table = new Map(Object.entries(rows));
  const update = vi.fn((weekKey: string, patch: Partial<Session>) => {
    const row = table.get(weekKey);
    if (!row) {
      return;
    }
    table.set(weekKey, { ...row, ...patch });
  });
  return {
    store: {
      get: (weekKey: string) => table.get(weekKey) ?? null,
      update,
    } as Pick<SessionStore, "get" | "update">,
    table,
    update,
  };
}

/** Rate chosen so `$1 == 1,000,000 input tokens`, output free -- trivial $ math. */
const RATE = { inputPerMTok: 1, outputPerMTok: 0 };

function fakeLlm(usage: { inputTokens: number; outputTokens: number }): {
  llm: LlmClient;
  runQuery: ReturnType<typeof vi.fn>;
} {
  const runQuery = vi.fn(
    async (_input: RunQueryInput): Promise<LlmResult> => ({
      text: "ok",
      usage: { ...usage },
    }),
  );
  return { llm: { runQuery }, runQuery };
}

function fakeSlack(): {
  slack: RevisionSlackClient;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const postMessage = vi.fn(async () => ({ ok: true, ts: "2000.0001" }));
  return { slack: { chat: { postMessage } }, postMessage };
}

/** A `buildHandler` factory that calls the injected `llm` exactly `calls` times, swallowing any error -- mirrors `createRevisionHandler`'s own "never let a mutation failure escape onReply" contract (`./revision.ts`). */
function buildHandlerCalling(
  calls: number,
): (llm: LlmClient) => RevisionHandler {
  return (llm) => ({
    async onReply(): Promise<void> {
      for (let i = 0; i < calls; i++) {
        await llm.runQuery({ prompt: `cycle call ${i + 1}` }).catch(() => {});
      }
    },
  });
}

const CAPS: RevisionCostCaps = {
  cycleTokenCap: 100,
  threadTurnCap: 3,
  threadDollarCap: 5,
};

function makeGuard(deps: {
  store: Pick<SessionStore, "get" | "update">;
  slack: RevisionSlackClient;
  caps?: RevisionCostCaps;
}) {
  const alert = vi.fn(async (_message: string) => {});
  const guard = createRevisionCostGuard({
    sessionStore: deps.store,
    caps: deps.caps ?? CAPS,
    rate: RATE,
    alert,
    slack: deps.slack,
    channelId: "C-meal-plan",
    now: () => new Date("2026-07-12T18:00:00.000Z"),
  });
  return { guard, alert };
}

describe("createRevisionCostGuard", () => {
  describe("wrapRevisionHandler", () => {
    it("a cycle exceeding the per-cycle token cap pauses, alerts, and posts the in-thread note", async () => {
      const { store, table } = fakeSessionStore({ "2026-07-12": session() });
      const { slack, postMessage } = fakeSlack();
      const { guard, alert } = makeGuard({ store, slack });
      // 80 tokens/call x 2 calls = 160 > the 100-token cycleTokenCap.
      const { llm } = fakeLlm({ inputTokens: 80, outputTokens: 0 });
      const buildHandler = vi.fn(buildHandlerCalling(2));

      const handler = guard.wrapRevisionHandler(buildHandler, llm);
      await handler.onReply(threadReply());

      const row = table.get("2026-07-12");
      expect(row?.status).toBe("paused_cost");
      expect(row?.turn_count).toBe(1);
      expect(row?.token_spend).toBe(160);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][0]).toMatch(/per-cycle token cap/);
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0][0]).toMatchObject({
        channel: "C-meal-plan",
        thread_ts: "1000.0001",
      });
      expect(postMessage.mock.calls[0][0].text).toMatch(/paused for cost/i);
    });

    it("the per-thread turn cap trips a pause WITHOUT running the cycle (pre-check)", async () => {
      const { store, table } = fakeSessionStore({
        "2026-07-12": session({ turn_count: 3 }), // == threadTurnCap
      });
      const { slack, postMessage } = fakeSlack();
      const { guard, alert } = makeGuard({ store, slack });
      const { llm, runQuery } = fakeLlm({ inputTokens: 10, outputTokens: 0 });
      const buildHandler = vi.fn(buildHandlerCalling(1));

      const handler = guard.wrapRevisionHandler(buildHandler, llm);
      await handler.onReply(threadReply());

      expect(buildHandler).not.toHaveBeenCalled();
      expect(runQuery).not.toHaveBeenCalled();
      expect(table.get("2026-07-12")?.status).toBe("paused_cost");
      expect(alert.mock.calls[0][0]).toMatch(/thread turn cap/);
      expect(postMessage).toHaveBeenCalledTimes(1);
    });

    it("the per-thread dollar budget trips a pause once a cycle's spend pushes cumulative cost over cap", async () => {
      // Simulates prior GENERATION spend already on the row (D5's shared
      // pool): $4.90 already spent, well under the $5 cap on its own.
      const { store, table } = fakeSessionStore({
        "2026-07-12": session({ cost_usd: 4.9, token_spend: 4_900_000 }),
      });
      const { slack, postMessage } = fakeSlack();
      // A generous cycleTokenCap here -- this test targets the $ cap
      // specifically, not the per-cycle token cap.
      const { guard, alert } = makeGuard({
        store,
        slack,
        caps: { ...CAPS, cycleTokenCap: 1_000_000 },
      });
      // 200,000 input tokens @ $1/MTok == $0.20 -- pushes cumulative to $5.10.
      const { llm } = fakeLlm({ inputTokens: 200_000, outputTokens: 0 });
      const buildHandler = vi.fn(buildHandlerCalling(1));

      const handler = guard.wrapRevisionHandler(buildHandler, llm);
      await handler.onReply(threadReply());

      const row = table.get("2026-07-12");
      expect(row?.status).toBe("paused_cost");
      expect(row?.cost_usd).toBeCloseTo(5.1, 10);
      expect(alert.mock.calls[0][0]).toMatch(/thread dollar budget/);
      expect(postMessage).toHaveBeenCalledTimes(1);
    });

    it("generation and revision spend share ONE pool -- a cycle's spend is ADDED to whatever generation already recorded", async () => {
      const { store, table } = fakeSessionStore({
        "2026-07-12": session({
          cost_usd: 1.5,
          token_spend: 1_500_000,
          turn_count: 0,
        }),
      });
      const { slack } = fakeSlack();
      const { guard, alert } = makeGuard({
        store,
        slack,
        caps: { ...CAPS, cycleTokenCap: 1_000_000 },
      });
      // 10,000 tokens @ $1/MTok == $0.01 -- stays comfortably under every cap.
      const { llm } = fakeLlm({ inputTokens: 10_000, outputTokens: 0 });
      const buildHandler = vi.fn(buildHandlerCalling(1));

      const handler = guard.wrapRevisionHandler(buildHandler, llm);
      await handler.onReply(threadReply());

      const row = table.get("2026-07-12");
      expect(row?.status).toBe("suggested"); // unchanged -- no cap tripped
      expect(row?.turn_count).toBe(1);
      expect(row?.token_spend).toBe(1_510_000); // 1.5M (generation) + 10k (this cycle)
      expect(row?.cost_usd).toBeCloseTo(1.51, 10); // $1.50 (generation) + $0.01 (this cycle)
      expect(alert).not.toHaveBeenCalled();
    });

    it("an already-paused revision does not proceed", async () => {
      const { store, table } = fakeSessionStore({
        "2026-07-12": session({
          status: "paused_cost",
          turn_count: 5,
          cost_usd: 6,
        }),
      });
      const { slack, postMessage } = fakeSlack();
      const { guard, alert } = makeGuard({ store, slack });
      const { llm, runQuery } = fakeLlm({ inputTokens: 10, outputTokens: 0 });
      const buildHandler = vi.fn(buildHandlerCalling(1));

      const handler = guard.wrapRevisionHandler(buildHandler, llm);
      await handler.onReply(threadReply());

      expect(buildHandler).not.toHaveBeenCalled();
      expect(runQuery).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
      // Row is untouched -- still paused, no re-pause / re-alert churn.
      const row = table.get("2026-07-12");
      expect(row?.status).toBe("paused_cost");
      expect(row?.turn_count).toBe(5);
    });

    it("with no session row, runs the cycle unmetered and never throws", async () => {
      const { store } = fakeSessionStore({});
      const { slack } = fakeSlack();
      const { guard, alert } = makeGuard({ store, slack });
      const { llm, runQuery } = fakeLlm({ inputTokens: 10, outputTokens: 0 });
      const buildHandler = vi.fn(buildHandlerCalling(1));

      const handler = guard.wrapRevisionHandler(buildHandler, llm);
      await expect(handler.onReply(threadReply())).resolves.toBeUndefined();

      expect(buildHandler).toHaveBeenCalledTimes(1);
      expect(runQuery).toHaveBeenCalledTimes(1);
      expect(alert).not.toHaveBeenCalled();
    });
  });

  describe("resetPause", () => {
    it("operator reset clears the pause and zeroes the shared budget", () => {
      const { store, table } = fakeSessionStore({
        "2026-07-12": session({
          status: "paused_cost",
          turn_count: 4,
          token_spend: 5_000_000,
          cost_usd: 5.2,
        }),
      });
      const { slack } = fakeSlack();
      const { guard } = makeGuard({ store, slack });

      guard.resetPause("2026-07-12");

      const row = table.get("2026-07-12");
      expect(row?.status).toBe("suggested");
      expect(row?.turn_count).toBe(0);
      expect(row?.token_spend).toBe(0);
      expect(row?.cost_usd).toBe(0);
    });

    it("is a no-op when the week is not currently paused_cost", () => {
      const { store, table } = fakeSessionStore({
        "2026-07-12": session({ status: "suggested", turn_count: 1 }),
      });
      const { slack } = fakeSlack();
      const { guard } = makeGuard({ store, slack });

      guard.resetPause("2026-07-12");

      const row = table.get("2026-07-12");
      expect(row?.status).toBe("suggested");
      expect(row?.turn_count).toBe(1); // untouched
    });

    it("is a no-op when there is no row for the week", () => {
      const { store, update } = fakeSessionStore({});
      const { slack } = fakeSlack();
      const { guard } = makeGuard({ store, slack });

      expect(() => guard.resetPause("2099-01-01")).not.toThrow();
      expect(update).not.toHaveBeenCalled();
    });
  });
});
