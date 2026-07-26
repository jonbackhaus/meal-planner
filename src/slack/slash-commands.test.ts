import { EventEmitter } from "node:events";
import type { SocketModeClient } from "@slack/socket-mode";
import { describe, expect, it, vi } from "vitest";
import type { Session, SessionStore } from "../orchestrator/session-store.js";
import type { WeekKeyConfig } from "../orchestrator/week-key.js";
import {
  type ApprovedMealPlanCommand,
  attachSlashCommandRouter,
  type SlackSlashCommandPayload,
} from "./slash-commands.js";

/**
 * `attachSlashCommandRouter` tests (bd meal-planner-4u4.6). Mocks the socket
 * client (a plain `node:events` `EventEmitter`, matching
 * `inbound-router.test.ts`'s `FakeSocketModeClient` pattern) and the session
 * store (`vi.fn` stand-in for `get`). No real network, no real SQLite.
 */

const cfg: WeekKeyConfig = {
  timezone: "America/Chicago",
  triggerTime: "06:00",
};

// 2026-07-12T13:00:00Z = 08:00 America/Chicago (CDT), after the 06:00
// trigger -> currentPlanWeek(NOW, cfg) === ACTIVE_WEEK (matches
// inbound-router.test.ts's own fixtures).
const NOW = new Date("2026-07-12T13:00:00Z");
const ACTIVE_WEEK = "2026-07-12";

class FakeSocketModeClient extends EventEmitter {}

function fakeSessionStore(
  impl: (weekKey: string) => Session | null,
): Pick<SessionStore, "get"> {
  return { get: vi.fn(impl) };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    week_key: ACTIVE_WEEK,
    status: "suggested",
    thread_ts: "1000.0001",
    working_plan: null,
    turn_count: 0,
    token_spend: 0,
    cost_usd: 0,
    created_at: "2026-07-12T06:00:00.000Z",
    updated_at: "2026-07-12T06:00:00.000Z",
    ...overrides,
  };
}

function slashCommandPayload(
  overrides: Partial<SlackSlashCommandPayload> = {},
): SlackSlashCommandPayload {
  return {
    command: "/mealplan-approved",
    text: "",
    user_id: "U123",
    user_name: "jon",
    channel_id: "C123",
    team_id: "T123",
    response_url: "https://hooks.slack.com/commands/T123/xyz",
    trigger_id: "trigger.123",
    ...overrides,
  };
}

function emitSlashCommand(
  client: FakeSocketModeClient,
  body: SlackSlashCommandPayload,
  ack: () => Promise<void> = vi.fn(async () => {}),
) {
  return new Promise<void>((resolve) => {
    client.emit("slash_commands", { body, ack });
    // Handlers are async; let their microtasks flush.
    setImmediate(resolve);
  });
}

describe("attachSlashCommandRouter", () => {
  it("acks within the handler synchronously before any work (Slack's <3s requirement)", async () => {
    const client = new FakeSocketModeClient();
    const sessionStore = fakeSessionStore(() => null);
    const ack = vi.fn(async () => {});

    attachSlashCommandRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await emitSlashCommand(client, slashCommandPayload(), ack);

    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("resolves an active-week command to the active thread and dispatches it to the approvalHandler seam", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore((weekKey) =>
      weekKey === ACTIVE_WEEK ? session : null,
    );
    const onApprove = vi.fn<(cmd: ApprovedMealPlanCommand) => void>();
    const ack = vi.fn(async () => {});

    attachSlashCommandRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      approvalHandler: { onApprove },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const body = slashCommandPayload();
    await emitSlashCommand(client, body, ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({
      weekKey: ACTIVE_WEEK,
      threadTs: "1000.0001",
      command: body,
    });
  });

  it("does NOT dispatch a commit when there is no active-week session (stale/absent week cannot be approved)", async () => {
    const client = new FakeSocketModeClient();
    const sessionStore = fakeSessionStore(() => null);
    const onApprove = vi.fn();
    const ack = vi.fn(async () => {});
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    attachSlashCommandRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      approvalHandler: { onApprove },
      now: () => NOW,
      logger,
    });

    await emitSlashCommand(client, slashCommandPayload(), ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("no active thread"),
    );
  });

  it("does NOT dispatch a commit when the active-week session has no thread_ts yet (still generating)", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      status: "generating",
      thread_ts: null,
    });
    const sessionStore = fakeSessionStore((weekKey) =>
      weekKey === ACTIVE_WEEK ? session : null,
    );
    const onApprove = vi.fn();
    const ack = vi.fn(async () => {});

    attachSlashCommandRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      approvalHandler: { onApprove },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await emitSlashCommand(client, slashCommandPayload(), ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("ignores a slash command other than /mealplan-approved (still acks, does not dispatch)", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore((weekKey) =>
      weekKey === ACTIVE_WEEK ? session : null,
    );
    const onApprove = vi.fn();
    const ack = vi.fn(async () => {});

    attachSlashCommandRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      approvalHandler: { onApprove },
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await emitSlashCommand(
      client,
      slashCommandPayload({ command: "/grocerylist-approved" }),
      ack,
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("defaults to a no-op approvalHandler when none is injected (never throws)", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore((weekKey) =>
      weekKey === ACTIVE_WEEK ? session : null,
    );
    const ack = vi.fn(async () => {});

    attachSlashCommandRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      now: () => NOW,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      emitSlashCommand(client, slashCommandPayload(), ack),
    ).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("still acks and does not throw when the approvalHandler itself rejects", async () => {
    const client = new FakeSocketModeClient();
    const session = fakeSession({
      week_key: ACTIVE_WEEK,
      thread_ts: "1000.0001",
    });
    const sessionStore = fakeSessionStore((weekKey) =>
      weekKey === ACTIVE_WEEK ? session : null,
    );
    const onApprove = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ack = vi.fn(async () => {});

    attachSlashCommandRouter(client as unknown as SocketModeClient, {
      sessionStore,
      weekKeyConfig: cfg,
      approvalHandler: { onApprove },
      now: () => NOW,
      logger,
    });

    await emitSlashCommand(client, slashCommandPayload(), ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
