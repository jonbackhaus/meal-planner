import { SocketModeClient } from "@slack/socket-mode";

/**
 * Opens (and cleanly tears down) the v3.0 Socket Mode connection (SPEC
 * §3.2/§9.2: a persistent OUTBOUND websocket, no public endpoint) via
 * `@slack/socket-mode`'s `SocketModeClient`. This module is CONNECTION
 * LIFECYCLE ONLY -- it never attaches inbound event handlers; routing a
 * thread reply to a session row (bd meal-planner-4u4.4) is a separate,
 * later concern. `SocketModeConnectionHandle.client` is the seam that
 * follow-up work attaches `.on(...)` listeners to.
 *
 * `SocketModeClient` only needs the app-level token (`xapp-...`): its
 * `apps.connections.open` handshake authenticates with that token alone, not
 * the bot token -- the bot token is used solely by the existing outbound
 * `chat.postMessage` path (`slack-poster.ts`/`slack-alerter.ts`), which this
 * module does not touch.
 */

export interface SocketModeConnectionOptions {
  /** Slack app-level token (xapp-...). Used ONLY to construct the internal `SocketModeClient` -- never logged. */
  appToken: string;
  /**
   * Injectable client for tests (mirrors `daemon.test.ts`'s `FakeProcess`
   * pattern: pass a fake cast `as unknown as SocketModeClient`) -- when
   * omitted, a real `SocketModeClient({ appToken })` is constructed.
   * Auto-reconnect on disruption is the SDK's own default
   * (`autoReconnectEnabled` defaults to `true`); not reimplemented here.
   */
  client?: SocketModeClient;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface SocketModeConnectionHandle {
  /**
   * The Socket Mode client instance -- seam for the inbound event router
   * (bd meal-planner-4u4.4, out of scope here) to attach `.on(...)`
   * handlers later. No handlers are attached by this module.
   */
  readonly client: SocketModeClient;
  /** Cleanly ends the Socket Mode session (`client.disconnect()`). */
  disconnect(): Promise<void>;
}

/**
 * Constructs (or reuses the injected) `SocketModeClient` and starts the
 * session. Throws if `client.start()` rejects -- the caller (`runDaemon`)
 * decides whether a failed boot-time connection attempt is fatal or merely
 * logged.
 */
export async function openSocketModeConnection(
  opts: SocketModeConnectionOptions,
): Promise<SocketModeConnectionHandle> {
  const logger = opts.logger ?? console;
  const client =
    opts.client ?? new SocketModeClient({ appToken: opts.appToken });

  await client.start();
  logger.log("[socket-mode] connection opened");

  return {
    client,
    disconnect: async () => {
      await client.disconnect();
      logger.log("[socket-mode] connection closed");
    },
  };
}
