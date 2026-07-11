import type { Config } from "../config/config.js";
import type { Secrets } from "../secrets/secrets.js";
import { type OnTriggerHook, Scheduler } from "./scheduler.js";
import { checkSystemSleepDisabled } from "./system-check.js";

/**
 * Resident-daemon host (SPEC §3.2, §9.4). Wires config + secrets + the
 * in-process Scheduler together and owns the process lifecycle: runs the
 * injected startup catch-up hook once, starts the weekly Scheduler, and
 * handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Scope boundary: the real plan-generation (`generateForWeek`) and
 * startup-catch-up decision logic belong to E3 (ADR 0002), not this module.
 * Both are injected here as `onTrigger` / `onStartup` so E3 can plug in
 * without changing this file.
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
  /** If true, fires `onTrigger` once immediately after startup + scheduling begins (SPEC §9.4 "do one real test-fire"). Does not alter the weekly schedule itself. */
  fireOnStart?: boolean;
  /** Injectable process object (for SIGINT/SIGTERM signal wiring in tests); defaults to the real `process`. */
  process?: NodeJS.Process;
  /** Injectable logger; defaults to `console`. */
  logger?: DaemonLogger;
}

export interface DaemonHandle {
  /** Resolves once the daemon has fully shut down (scheduler stopped, signal handled or `shutdown()` called). */
  readonly stopped: Promise<void>;
  /** Test-fire affordance: invokes `onTrigger` once immediately, independent of the weekly schedule. */
  triggerNow(): Promise<void>;
  /** Stops the scheduler and resolves `stopped`. Idempotent. Also invoked automatically by SIGINT/SIGTERM. */
  shutdown(): Promise<void>;
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

  await options.onStartup();

  const scheduler = new Scheduler({
    timezone: options.config.timezone,
    triggerTime: options.config.triggerTime,
    onTrigger: options.onTrigger,
    onOverlap: () =>
      logger.warn(
        "Scheduler: a trigger fired while a previous onTrigger run was still in progress; skipping the overlapping run.",
      ),
    logger,
  });
  scheduler.start();

  if (options.fireOnStart) {
    await scheduler.triggerNow();
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
  };
}
