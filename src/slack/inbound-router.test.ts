import { EventEmitter } from "node:events";
import type { SocketModeClient } from "@slack/socket-mode";
import { describe, expect, it, vi } from "vitest";
import type { Session, SessionStore } from "../orchestrator/session-store.js";
import type { WeekKeyConfig } from "../orchestrator/week-key.js";
import {
  attachEventRouter,
  type InboundThreadReply,
  type SlackMessageEvent,
} from "./inbound-router.js";

/**
 * `attachEventRouter` tests (bd meal-planner-4u4.4). Mocks the socket client
 * (a plain `node:events` `EventEmitter`, matching `daemon.test.ts`'s
 * `FakeProcess` pattern -- `attachEventRouter` only ever calls `.on(...)` on
 * it) and the session store (`vi.fn` stand-ins for `getByThreadTs`). No real
 * network, no real SQLite.
 */

const cfg: WeekKeyConfig = {
  timezone: "America/Chicago",
  triggerTime: "06:00",
};

// 2026-07-12T13:00:00Z = 08:00 America/Chicago (CDT), after the 06:00
// trigger -> currentPlanWeek(NOW, cfg) === ACTIVE_WEEK (matches
// week-key.test.ts's own fixtures).
const NOW = new Date("2026-07-12T13:00:00Z");
const ACTIVE_WEEK = "2026-07-12";
const PRIOR_WEEK = "2026-07-05";

class FakeSocketModeClient extends EventEmitter {}

function fakeSessionStore(
  impl: (threadTs: string) => Session | null,
  getImpl: (weekKey: string) => Session | null = () => null,
): Pick<SessionStore, "getByThreadTs" | "get"> {
  return { getByThreadTs: vi.fn(impl), get: vi.fn(getImpl) };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    week_key: ACTIVE_WEEK,
    status: "suggested",
    thread_ts: "1000.0001",
    working_plan: null,
    last_posted_plan: null,
    turn_count: 0,
    token_spend: 0,
    cost_usd: 0,
    created_at: "2026-07-12T06:00:00.000Z",
    updated_at: "2026-07-12T06:00:00.000Z",
    ...overrides,
  };
}

function threadReplyEvent(
  overrides: Partial<SlackMessageEvent> = {},
): SlackMessageEvent {
  return {
    type: "message",
    channel: "C123",
    user: "U123",
    ts: "1000.0002",
    thread_ts: "1000.0001",
    text: "how about tacos instead of the stir fry",
    ...overrides,
  };
}

function emitMessage(
  client: FakeSocketModeClient,
  event: SlackMessageEvent,
  ack: () => Promise<void> = vi.fn(async () => {}),
) {
  return new Promise<void>((resolve) => {
    client.emit("message", { event, ack });
    // Handlers are async; let their microtasks flush.
    setImmediate(resolve);
  });
}

describe("attachEventRouter", () => {
  it("forwards an active-week thread reply to the revisionHandler seam with the resolved weekKey + threadTs", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore((threadTs) =>
      threadTs === "1000.0001" ? session : null,
    );
    const onReply = vi.fn<(reply: InboundThreadReply) => void>();
    const ack = vi.fn(async () => {});

    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      revisionHandler: { onReply },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const event = threadReplyEvent();
    await emitMessage(client, event, ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith({
      weekKey: ACTIVE_WEEK,
      threadTs: "1000.0001",
      event,
    });
  });

  it("drops a reply whose thread maps to a PRIOR (non-active) week -- does not forward to the revisionHandler", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: PRIOR_WEEK,
      thread_ts: "900.0001",
    });
    const sessionStore = fakeSessionStore((threadTs) =>
      threadTs === "900.0001" ? session : null,
    );
    const onReply = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ack = vi.fn(async () => {});

    // No `redirect` Slack client injected -- falls back to the log-only drop.
    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      revisionHandler: { onReply },
      now: () => NOW,
      logger,
    });

    await emitMessage(
      client,
      threadReplyEvent({ thread_ts: "900.0001", ts: "900.0002" }),
      ack,
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("no redirect Slack client injected"),
    );
  });

  it("posts a ONE-TIME expired-thread redirect on the first reply to a prior-week thread, linking the active week's thread", async () => {
    const client = new FakeSocketModeClient();
    const expiredSession = fakeSession({
      week_key: PRIOR_WEEK,
      thread_ts: "900.0001",
    });
    const activeSession = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore(
      (threadTs) => (threadTs === "900.0001" ? expiredSession : null),
      (weekKey) => (weekKey === ACTIVE_WEEK ? activeSession : null),
    );
    const onReply = vi.fn();
    const postMessage = vi.fn(async () => ({ ok: true, ts: "900.0003" }));
    const ack = vi.fn(async () => {});

    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      revisionHandler: { onReply },
      redirect: { slack: { chat: { postMessage } }, channelId: "C123" },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await emitMessage(
      client,
      threadReplyEvent({ thread_ts: "900.0001", ts: "900.0002" }),
      ack,
    );

    expect(onReply).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "900.0001",
        mrkdwn: true,
        text: expect.stringContaining("1000.0001".replace(".", "")),
      }),
    );

    // A SECOND reply to the SAME expired thread must NOT redirect again.
    await emitMessage(
      client,
      threadReplyEvent({ thread_ts: "900.0001", ts: "900.0004" }),
      ack,
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("posts a redirect with no link when the active week has no session/thread yet", async () => {
    const client = new FakeSocketModeClient();
    const expiredSession = fakeSession({
      week_key: PRIOR_WEEK,
      thread_ts: "900.0001",
    });
    const sessionStore = fakeSessionStore(
      (threadTs) => (threadTs === "900.0001" ? expiredSession : null),
      () => null,
    );
    const postMessage = vi.fn(async () => ({ ok: true, ts: "900.0003" }));
    const ack = vi.fn(async () => {});

    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      redirect: { slack: { chat: { postMessage } }, channelId: "C123" },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await emitMessage(
      client,
      threadReplyEvent({ thread_ts: "900.0001", ts: "900.0002" }),
      ack,
    );

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "900.0001",
        text: expect.stringContaining("hasn't posted yet"),
      }),
    );
  });

  it("drops a reply whose thread_ts matches NO known session -- does not forward", async () => {
    const client = new FakeSocketModeClient();
    const sessionStore = fakeSessionStore(() => null);
    const onReply = vi.fn();
    const ack = vi.fn(async () => {});

    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      revisionHandler: { onReply },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await emitMessage(
      client,
      threadReplyEvent({ thread_ts: "unknown.0001" }),
      ack,
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("drops a stray channel message (no thread_ts) -- does not forward", async () => {
    const client = new FakeSocketModeClient();
    const sessionStore = fakeSessionStore(() => {
      throw new Error(
        "getByThreadTs should not be called for a non-threaded message",
      );
    });
    const onReply = vi.fn();
    const ack = vi.fn(async () => {});

    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      revisionHandler: { onReply },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const { thread_ts: _omit, ...strayEvent } = threadReplyEvent();
    await emitMessage(client, strayEvent, ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("defaults to a no-op revisionHandler when none is injected (never throws)", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore((threadTs) =>
      threadTs === "1000.0001" ? session : null,
    );
    const ack = vi.fn(async () => {});

    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      emitMessage(client, threadReplyEvent(), ack),
    ).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("still acks and does not throw when the revisionHandler itself rejects", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore((threadTs) =>
      threadTs === "1000.0001" ? session : null,
    );
    const onReply = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ack = vi.fn(async () => {});

    attachEventRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      revisionHandler: { onReply },
      now: () => NOW,
      logger,
    });

    await emitMessage(client, threadReplyEvent(), ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
