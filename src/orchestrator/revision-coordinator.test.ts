import { describe, expect, it, vi } from "vitest";
import type { InboundThreadReply } from "../slack/inbound-router.js";
import type { RevisionResult } from "./revision.js";
import {
  createRevisionCoordinator,
  guardOnRevised,
  serializeRevisionHandler,
} from "./revision-coordinator.js";
import type { Session, SessionStore } from "./session-store.js";

/**
 * `revision-coordinator.ts` tests (bd meal-planner-3e2.5, ADR 0007 D4). No
 * real network / SQLite: `SessionStore` is narrowed to `get`/`update`
 * `vi.fn` mocks (matches `revision.test.ts`/`approval-handler.test.ts`'s own
 * narrowing convention); a tiny in-memory `Map`-backed fake stands in for
 * the store's row.
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
    turn_count: 0,
    token_spend: 0,
    cost_usd: 0,
    created_at: "2026-07-12T06:00:00.000Z",
    updated_at: "2026-07-12T06:00:00.000Z",
    ...overrides,
  };
}

/** A tiny in-memory `SessionStore` fake -- `get` reflects whatever `update` last wrote, so tests can assert live status transitions. */
function fakeSessionStore(rows: Record<string, Session>): {
  store: Pick<SessionStore, "get" | "update">;
  update: ReturnType<typeof vi.fn>;
} {
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
    },
    update,
  };
}

function revisionResult(
  overrides: Partial<RevisionResult> = {},
): RevisionResult {
  return {
    weekKey: "2026-07-12",
    threadTs: "1000.0001",
    sourcePlan: { week_key: "2026-07-12", meals: [] },
    revisedPlan: {
      week_key: "2026-07-12",
      meals: [
        {
          slot_type: "constrained",
          recipe_id: "recipe-9",
          title: "Bean Tacos",
          day: "2026-07-14",
          veg: { kind: "inherent" },
          flags: [],
          rationale: "swapped per request",
        },
      ],
    },
    messages: ["how about tacos instead"],
    ...overrides,
  };
}

/** Resolves after all pending microtasks flush -- used to interleave two concurrent `runExclusive` calls deterministically. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createRevisionCoordinator", () => {
  it("isSuperseded reflects supersede(), per weekKey", () => {
    const coordinator = createRevisionCoordinator();
    expect(coordinator.isSuperseded("2026-07-12")).toBe(false);
    coordinator.supersede("2026-07-12");
    expect(coordinator.isSuperseded("2026-07-12")).toBe(true);
    // A different week is untouched.
    expect(coordinator.isSuperseded("2026-07-19")).toBe(false);
  });

  it("serializes two concurrent runExclusive calls on the SAME key -- no interleaving", async () => {
    const coordinator = createRevisionCoordinator();
    const events: string[] = [];

    const first = coordinator.runExclusive("wk-1", async () => {
      events.push("first:start");
      await flushMicrotasks();
      events.push("first:end");
    });
    const second = coordinator.runExclusive("wk-1", async () => {
      events.push("second:start");
      await flushMicrotasks();
      events.push("second:end");
    });

    await Promise.all([first, second]);

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("runs runExclusive calls for DIFFERENT keys independently (no cross-key blocking)", async () => {
    const coordinator = createRevisionCoordinator();
    const events: string[] = [];

    const a = coordinator.runExclusive("wk-a", async () => {
      events.push("a:start");
      await flushMicrotasks();
      events.push("a:end");
    });
    const b = coordinator.runExclusive("wk-b", async () => {
      events.push("b:start");
      await flushMicrotasks();
      events.push("b:end");
    });

    await Promise.all([a, b]);

    // Both started before either finished -- proof they ran in parallel,
    // not serialized behind one another.
    expect(events.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
  });

  it("a rejection from one queued call does not wedge the next call for the same key", async () => {
    const coordinator = createRevisionCoordinator();

    await expect(
      coordinator.runExclusive("wk-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      coordinator.runExclusive("wk-1", async () => "ok"),
    ).resolves.toBe("ok");
  });
});

describe("serializeRevisionHandler", () => {
  it("drives status suggested -> under_revision -> suggested around a revision", async () => {
    const { store } = fakeSessionStore({ "2026-07-12": session() });
    const coordinator = createRevisionCoordinator();
    const statusDuringDownstream: (string | undefined)[] = [];

    const downstream = {
      onReply: vi.fn(async () => {
        statusDuringDownstream.push(store.get("2026-07-12")?.status);
      }),
    };

    const handler = serializeRevisionHandler(downstream, {
      sessionStore: store,
      coordinator,
      now: () => new Date("2026-07-12T08:00:00.000Z"),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(store.get("2026-07-12")?.status).toBe("suggested");

    await handler.onReply(threadReply());

    expect(statusDuringDownstream).toEqual(["under_revision"]);
    expect(store.get("2026-07-12")?.status).toBe("suggested");
    expect(downstream.onReply).toHaveBeenCalledTimes(1);
  });

  it("still resets status to suggested when downstream throws", async () => {
    const { store } = fakeSessionStore({ "2026-07-12": session() });
    const coordinator = createRevisionCoordinator();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const downstream = {
      onReply: vi.fn(async () => {
        throw new Error("mutation failed");
      }),
    };

    const handler = serializeRevisionHandler(downstream, {
      sessionStore: store,
      coordinator,
      logger,
    });

    await expect(handler.onReply(threadReply())).resolves.toBeUndefined();

    expect(store.get("2026-07-12")?.status).toBe("suggested");
    expect(logger.error).toHaveBeenCalled();
  });

  it("serializes two concurrent revisions on ONE session -- no interleaving of downstream calls", async () => {
    const { store } = fakeSessionStore({ "2026-07-12": session() });
    const coordinator = createRevisionCoordinator();
    const events: string[] = [];

    const downstream = {
      onReply: vi.fn(async (reply: InboundThreadReply) => {
        events.push(`start:${reply.event.text}`);
        await flushMicrotasks();
        events.push(`end:${reply.event.text}`);
      }),
    };

    const handler = serializeRevisionHandler(downstream, {
      sessionStore: store,
      coordinator,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const first = handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "reply-1" } }),
    );
    const second = handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "reply-2" } }),
    );

    await Promise.all([first, second]);

    expect(events).toEqual([
      "start:reply-1",
      "end:reply-1",
      "start:reply-2",
      "end:reply-2",
    ]);
  });

  it("runs revisions for DISTINCT sessions independently", async () => {
    const { store } = fakeSessionStore({
      "2026-07-12": session({ week_key: "2026-07-12" }),
      "2026-07-19": session({ week_key: "2026-07-19", thread_ts: "2000.0001" }),
    });
    const coordinator = createRevisionCoordinator();
    const events: string[] = [];

    const downstream = {
      onReply: vi.fn(async (reply: InboundThreadReply) => {
        events.push(`start:${reply.weekKey}`);
        await flushMicrotasks();
        events.push(`end:${reply.weekKey}`);
      }),
    };

    const handler = serializeRevisionHandler(downstream, {
      sessionStore: store,
      coordinator,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const a = handler.onReply(threadReply({ weekKey: "2026-07-12" }));
    const b = handler.onReply(
      threadReply({ weekKey: "2026-07-19", threadTs: "2000.0001" }),
    );

    await Promise.all([a, b]);

    expect(events.slice(0, 2).sort()).toEqual([
      "start:2026-07-12",
      "start:2026-07-19",
    ]);
    expect(store.get("2026-07-12")?.status).toBe("suggested");
    expect(store.get("2026-07-19")?.status).toBe("suggested");
  });

  it("skips downstream entirely once the week has been superseded", async () => {
    const { store } = fakeSessionStore({
      "2026-07-12": session({ status: "committed" }),
    });
    const coordinator = createRevisionCoordinator();
    coordinator.supersede("2026-07-12");
    const downstream = { onReply: vi.fn() };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const handler = serializeRevisionHandler(downstream, {
      sessionStore: store,
      coordinator,
      logger,
    });

    await handler.onReply(threadReply());

    expect(downstream.onReply).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("superseded"),
    );
    // A superseded/committed row's status is left alone -- never forced
    // back to `suggested`.
    expect(store.get("2026-07-12")?.status).toBe("committed");
  });

  it("does not clobber a status that supersede moved away from under_revision while downstream ran", async () => {
    const { store } = fakeSessionStore({ "2026-07-12": session() });
    const coordinator = createRevisionCoordinator();

    const downstream = {
      onReply: vi.fn(async () => {
        // Simulate approval landing (and committing) WHILE this revision is
        // in flight.
        coordinator.supersede("2026-07-12");
        store.update("2026-07-12", { status: "committed" });
      }),
    };

    const handler = serializeRevisionHandler(downstream, {
      sessionStore: store,
      coordinator,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.onReply(threadReply());

    // Must stay `committed` -- not reset to `suggested` by the revision
    // wrapper's finally block.
    expect(store.get("2026-07-12")?.status).toBe("committed");
  });
});

describe("guardOnRevised", () => {
  it("writes working_plan back onto the session row when not superseded", async () => {
    const { store, update } = fakeSessionStore({ "2026-07-12": session() });
    const coordinator = createRevisionCoordinator();
    const downstream = vi.fn(async () => {});

    const guarded = guardOnRevised(downstream, {
      sessionStore: store,
      coordinator,
      now: () => new Date("2026-07-12T09:00:00.000Z"),
    });

    const result = revisionResult();
    await guarded(result);

    expect(downstream).toHaveBeenCalledWith(result);
    expect(update).toHaveBeenCalledWith("2026-07-12", {
      working_plan: result.revisedPlan,
      updated_at: "2026-07-12T09:00:00.000Z",
    });
  });

  it("drops the result WITHOUT calling downstream when already superseded before it runs", async () => {
    const { store, update } = fakeSessionStore({ "2026-07-12": session() });
    const coordinator = createRevisionCoordinator();
    coordinator.supersede("2026-07-12");
    const downstream = vi.fn(async () => {});
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const guarded = guardOnRevised(downstream, {
      sessionStore: store,
      coordinator,
      logger,
    });

    await guarded(revisionResult());

    expect(downstream).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("superseded"),
    );
  });

  it("lets an in-flight downstream (validate+post) finish but does NOT overwrite working_plan when superseded mid-flight (approval wins)", async () => {
    const { store, update } = fakeSessionStore({
      "2026-07-12": session({
        working_plan: { week_key: "2026-07-12", meals: [], approved: true },
      }),
    });
    const coordinator = createRevisionCoordinator();
    let downstreamRan = false;

    const downstream = vi.fn(async () => {
      // Approval lands WHILE the revision's validate+post is in flight.
      coordinator.supersede("2026-07-12");
      downstreamRan = true;
    });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const guarded = guardOnRevised(downstream, {
      sessionStore: store,
      coordinator,
      logger,
    });

    await guarded(revisionResult());

    expect(downstreamRan).toBe(true);
    // The late revision result must NOT overwrite whatever approval
    // committed.
    expect(update).not.toHaveBeenCalled();
    expect(
      (store.get("2026-07-12")?.working_plan as { approved?: boolean })
        ?.approved,
    ).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("superseded"),
    );
  });
});
