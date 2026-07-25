import type { Config } from "../config/config.js";
import type { Secrets } from "../secrets/secrets.js";
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
 * (bd meal-planner-4u4.3), and handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Scope boundary: the real plan-generation (`generateForWeek`) and
 * startup-catch-up decision logic belong to E3 (ADR 0002), not this module.
 * Both are injected here as `onTrigger` / `onStartup` so E3 can plug in
 * without changing this file. Likewise, Socket Mode CONNECTION LIFECYCLE is
 * this file's concern; routing inbound events (bd meal-planner-4u4.4) is
 * not -- `DaemonHandle.socketMode.client` is the attach seam for that
 * follow-up.
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
   * Exposes `.client` as the seam for the inbound event router (bd
   * meal-planner-4u4.4, out of scope here) to attach handlers.
   * `undefined` on v1.0/v2.0 boot paths, when the app token is unset, or if
   * the boot-time connection attempt failed (logged, non-fatal -- see
   * `runDaemon`).
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
  // generate/post flow does not depend on it, and there is no inbound
  // handling to lose yet (bd meal-planner-4u4.4 lands separately).
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
