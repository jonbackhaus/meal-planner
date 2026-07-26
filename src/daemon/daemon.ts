import type { Config } from "../config/config.js";
import type { SessionStore } from "../orchestrator/session-store.js";
import type { Secrets } from "../secrets/secrets.js";
import {
  attachEventRouter,
  type RevisionHandler,
} from "../slack/inbound-router.js";
import {
  type ApprovalHandler,
  attachSlashCommandRouter,
  type RegenerateHandler,
  type ResetHandler,
  type ResetPauseHandler,
} from "../slack/slash-commands.js";
import {
  openSocketModeConnection,
  type SocketModeConnectionHandle,
  type SocketModeConnectionOptions,
} from "../slack/socket-connection.js";
import { type OnTriggerHook, Scheduler } from "./scheduler.js";
import { checkSystemSleepDisabled } from "./system-check.js";

/**
 * Resident-daemon host (SPEC §3.2, §9.4). Wires config + secrets + the
 * in-process Scheduler together and owns the process lifecycle: runs the
 * injected startup catch-up hook once, starts the weekly Scheduler, opens
 * the v3.0 Socket Mode connection when `secrets.slackAppToken` is present
 * (bd meal-planner-4u4.3), attaches the inbound event router to it when a
 * `sessionStore` is supplied (bd meal-planner-4u4.4), and handles graceful
 * shutdown on SIGINT/SIGTERM.
 *
 * Scope boundary: the real plan-generation (`generateForWeek`) and
 * startup-catch-up decision logic belong to E3 (ADR 0002), not this module.
 * Both are injected here as `onTrigger` / `onStartup` so E3 can plug in
 * without changing this file. Likewise, this file only ATTACHES the router
 * (`../slack/inbound-router.js`) when the connection opens -- routing
 * decisions live entirely in that module, and revision itself (B1, bd
 * meal-planner-3e2.2) is injected as `revisionHandler` so it can plug in
 * later without changing this file either.
 */

/** Injected hook run once, before the Scheduler starts. E3 supplies the real startup catch-up decision logic later. */
export type OnStartupHook = () => Promise<void>;

/** Minimal logger surface accepted by runDaemon; defaults to `console`. */
export type DaemonLogger = Pick<Console, "log" | "warn" | "error">;

export interface RunDaemonOptions {
  config: Config;
  secrets: Secrets;
  /** Injected async hook run once before scheduling starts. E3 supplies the real startup catch-up logic. */
  onStartup: OnStartupHook;
  /** Injected async hook invoked at each weekly trigger (and by `triggerNow()`). E3 supplies the real `generateForWeek` call. */
  onTrigger: OnTriggerHook;
  /** The never-throwing `alert` composite (from `buildAlert`). Used by the Scheduler's trigger watchdog to surface a hung run through the existing alert mechanism (bd meal-planner-bd6.11). */
  alert: (message: string) => Promise<void>;
  /** If true, fires `onTrigger` once immediately after startup + scheduling begins (SPEC §9.4 "do one real test-fire"). Does not alter the weekly schedule itself. */
  fireOnStart?: boolean;
  /** Injectable process object (for SIGINT/SIGTERM signal wiring in tests); defaults to the real `process`. */
  process?: NodeJS.Process;
  /** Injectable logger; defaults to `console`. */
  logger?: DaemonLogger;
  /**
   * Injectable Socket Mode connection opener (v3.0, bd meal-planner-4u4.3);
   * defaults to the real `openSocketModeConnection`
   * (`../slack/socket-connection.js`). Only invoked when
   * `secrets.slackAppToken` is present -- v1.0/v2.0 boot paths (and dev
   * without the app token) never attempt a connection, so existing
   * generation flows are unaffected. Tests inject a fake here instead of
   * letting the real implementation open a network connection.
   */
  openSocketMode?: (
    opts: SocketModeConnectionOptions,
  ) => Promise<SocketModeConnectionHandle>;
  /**
   * Session store lookup the inbound event router needs (bd
   * meal-planner-4u4.4). When a Socket Mode connection opens successfully
   * AND this is supplied, `runDaemon` attaches the router to
   * `socketMode.client` before returning. Omitting this (v1.0/v2.0 boot
   * paths, or any test not exercising A4) leaves the connection with no
   * inbound handlers attached, exactly as before this task.
   */
  sessionStore?: Pick<SessionStore, "getByThreadTs" | "get">;
  /** Forwarded to the router as-is; defaults to a no-op (B1, bd meal-planner-3e2.2, supplies the real one later). */
  revisionHandler?: RevisionHandler;
  /**
   * Forwarded AS-IS to `attachEventRouter`'s `EventRouterOptions.redirect`
   * (A5, bd meal-planner-4u4.5): the Slack client + channelId used to post
   * the one-time expired-thread redirect reply. Omitted (the default) means
   * an expired-thread reply falls back to a log-only drop, exactly as before
   * this option existed. Wired by bd meal-planner-uo1.
   */
  redirect?: NonNullable<Parameters<typeof attachEventRouter>[1]>["redirect"];
  /** Forwarded to the slash-command router as-is (bd meal-planner-4u4.6); defaults to a no-op (C1, bd meal-planner-iu7.2, supplies the real commit handler later). */
  approvalHandler?: ApprovalHandler;
  /** Forwarded to the slash-command router as-is (bd meal-planner-m49, ADR-0007 D6); defaults to a no-op until the real operator pause-reset handler is wired in `index.ts`. */
  resetPauseHandler?: ResetPauseHandler;
  /** Forwarded to the slash-command router as-is (bd meal-planner-8u6, wired by cny); defaults to a no-op until the real full-replace regenerate handler is wired in `index.ts`. */
  regenerateHandler?: RegenerateHandler;
  /** Forwarded to the slash-command router as-is (bd meal-planner-2b2, wired by cny); defaults to a no-op until the real reset handler is wired in `index.ts`. */
  resetHandler?: ResetHandler;
  /** Injectable clock for the router (called fresh per inbound reply, not once at attach time); defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable router attacher, for tests; defaults to the real `attachEventRouter` (`../slack/inbound-router.js`). */
  attachEventRouter?: typeof attachEventRouter;
  /** Injectable slash-command router attacher, for tests; defaults to the real `attachSlashCommandRouter` (`../slack/slash-commands.js`). */
  attachSlashCommandRouter?: typeof attachSlashCommandRouter;
}

export interface DaemonHandle {
  /** Resolves once the daemon has fully shut down (scheduler stopped, signal handled or `shutdown()` called). */
  readonly stopped: Promise<void>;
  /** Test-fire affordance: invokes `onTrigger` once immediately, independent of the weekly schedule. */
  triggerNow(): Promise<void>;
  /** Stops the scheduler and resolves `stopped`. Idempotent. Also invoked automatically by SIGINT/SIGTERM. */
  shutdown(): Promise<void>;
  /**
   * The v3.0 Socket Mode connection handle, present only when
   * `secrets.slackAppToken` was set and the connection opened successfully.
   * Exposes `.client` -- the inbound event router (bd meal-planner-4u4.4) is
   * attached to it automatically when `options.sessionStore` was supplied
   * (see `runDaemon`). `undefined` on v1.0/v2.0 boot paths, when the app
   * token is unset, or if the boot-time connection attempt failed (logged,
   * non-fatal -- see `runDaemon`).
   */
  readonly socketMode?: SocketModeConnectionHandle;
}

/**
 * Boots the resident daemon: warns (never throws) if system sleep is not
 * confirmed disabled, runs `onStartup` once, starts the weekly Scheduler,
 * and wires graceful shutdown on SIGINT/SIGTERM.
 */
export async function runDaemon(
  options: RunDaemonOptions,
): Promise<DaemonHandle> {
  const logger = options.logger ?? console;
  const proc = options.process ?? process;

  const sleepStatus = await checkSystemSleepDisabled();
  if (!sleepStatus.disabled) {
    logger.warn(
      `checkSystemSleepDisabled: system sleep is not confirmed disabled (pmset -g: ${
        sleepStatus.raw ?? "unavailable"
      }); the in-process Scheduler requires this machine to stay awake (SPEC §9.4).`,
    );
  }

  // v3.0 Socket Mode (bd meal-planner-4u4.3, SPEC §3.2/§9.2): gated on the
  // app-level token's presence. A boot-time connection FAILURE is logged and
  // treated as non-fatal (proceeds without Socket Mode) -- the weekly
  // generate/post flow does not depend on it.
  let socketMode: SocketModeConnectionHandle | undefined;
  if (options.secrets.slackAppToken) {
    const openSocketMode = options.openSocketMode ?? openSocketModeConnection;
    try {
      socketMode = await openSocketMode({
        appToken: options.secrets.slackAppToken,
        logger,
      });
    } catch (err) {
      logger.error(
        `[socket-mode] failed to open the Socket Mode connection at boot; continuing without it: ${String(err)}`,
      );
    }
  } else {
    logger.log(
      "[socket-mode] slackAppToken not set; skipping Socket Mode connection (v1.0/v2.0 boot path)",
    );
  }

  // Inbound event router (bd meal-planner-4u4.4): only attached when the
  // connection actually opened AND a sessionStore was supplied -- callers
  // (tests, and any future boot path) that don't pass sessionStore get the
  // exact same connection-with-no-handlers behavior as before this task.
  if (socketMode && options.sessionStore) {
    const attach = options.attachEventRouter ?? attachEventRouter;
    attach(socketMode.client, {
      sessionStore: options.sessionStore,
      weekKeyConfig: options.config,
      revisionHandler: options.revisionHandler,
      redirect: options.redirect,
      now: options.now,
      logger,
    });

    // Slash-command transport (bd meal-planner-4u4.6): attached alongside
    // the A4 router above, on the same connection -- gated identically (only
    // once the socket is open AND a sessionStore is supplied).
    const attachSlash =
      options.attachSlashCommandRouter ?? attachSlashCommandRouter;
    attachSlash(socketMode.client, {
      sessionStore: options.sessionStore,
      weekKeyConfig: options.config,
      approvalHandler: options.approvalHandler,
      resetPauseHandler: options.resetPauseHandler,
      regenerateHandler: options.regenerateHandler,
      resetHandler: options.resetHandler,
      now: options.now,
      logger,
    });
  }

  await options.onStartup();

  const scheduler = new Scheduler({
    timezone: options.config.timezone,
    triggerTime: options.config.triggerTime,
    triggerTimeoutMs: options.config.triggerTimeoutMs,
    onTrigger: options.onTrigger,
    onTimeout: () =>
      options.alert(
        `Scheduler watchdog: a weekly trigger run exceeded the ${options.config.triggerTimeoutMs}ms timeout and was abandoned (alert-only, no state change — the post window is undecidable, cf. startup catch-up D4). The underlying run may still be in flight; a manual re-run may be required.`,
      ),
    onOverlap: () =>
      logger.warn(
        "Scheduler: a trigger fired while a previous onTrigger run was still in progress; skipping the overlapping run.",
      ),
    logger,
  });
  scheduler.start();

  if (options.fireOnStart) {
    // CONTAIN a failing test-fire (bd meal-planner-bd6.12): scheduler.triggerNow()
    // deliberately propagates onTrigger's error to its caller (unlike the
    // scheduled fire, whose croner `catch` contains it). Left unguarded, that
    // rejection rejects runDaemon -> main() -> process.exit(1); with
    // MP_FIRE_ON_START persisted in launchd env (+ dev forceRegenerate
    // re-firing into a PK-insert throw) that's a tight restart loop. Contain
    // it: log + alert (reusing the never-throwing `alert` composite, bd6.11),
    // and keep the already-scheduled daemon running.
    try {
      await scheduler.triggerNow();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `fireOnStart: the startup test-fire failed; the daemon keeps running and the weekly schedule stays active: ${message}`,
      );
      await options.alert(
        `Startup test-fire (fireOnStart) failed: ${message}. The weekly schedule is still active; a manual re-run may be required.`,
      );
    }
  }

  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return stopped;
    }
    shuttingDown = true;
    scheduler.stop();
    if (socketMode) {
      try {
        await socketMode.disconnect();
      } catch (err) {
        logger.error(
          `[socket-mode] disconnect failed during shutdown: ${String(err)}`,
        );
      }
    }
    resolveStopped();
    return stopped;
  }

  const handleSignal = (): void => {
    void shutdown();
  };
  proc.once("SIGINT", handleSignal);
  proc.once("SIGTERM", handleSignal);

  return {
    stopped,
    triggerNow: () => scheduler.triggerNow(),
    shutdown,
    socketMode,
  };
}
