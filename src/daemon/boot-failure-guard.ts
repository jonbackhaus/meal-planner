import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendLog } from "../ops/local-log.js";

/**
 * Crash-loop guard for the top-level boot catch (bd meal-planner-dx2): before
 * this existed, ANY error thrown before `main()` reaches `runDaemon` (most
 * notably `loadSecrets()` timing out under `withTimeout`, src/index.ts) hit a
 * bare `console.error` + `process.exit(1)` -- invisible to `#agent-alerts`
 * (no durable record beyond the untimestamped launchd err-log) and, under
 * `KeepAlive=true` with no `ThrottleInterval`, relaunched immediately,
 * producing an unbounded crash loop (the 2026-08 outage: ~93k err-log lines;
 * 2026-09-23: an endless stream of macOS `op` consent dialogs).
 *
 * This module is deliberately secrets-free: the exact bug it targets (a
 * `loadSecrets()` timeout) means a real `Secrets` object -- and therefore a
 * Slack bot token -- may not exist yet, so it can NEVER assume a Slack
 * transport is available. Its alert is the durable local log (`appendLog`,
 * same file `buildAlert` writes to), which is sufficient per the bead's
 * acceptance criteria ("alerts once ... (agent-alert/Slack or log)"); a
 * caller that DOES have a working alert transport may still pass one in.
 *
 * State survives across relaunches in a small on-disk JSON file
 * (`statePath`) -- an in-memory counter would NOT work here, since each
 * launchd relaunch is a brand-new process with no memory of the last one.
 *
 * Two independent mitigations, applied together (belt-and-suspenders with
 * the launchd plist's `ThrottleInterval`, deploy/launchd):
 *   1. An in-process exponential backoff (`sleep` before `exit(1)`) so a
 *      failing process itself never relaunches faster than a bounded rate,
 *      even on a `ThrottleInterval`-less or hand-rolled invocation.
 *   2. Alert-dedup: a rapid back-to-back failure streak alerts ONCE per
 *      `alertCooldownMs`, not on every single relaunch attempt -- every
 *      individual failure is still ALWAYS appended to the plain local log,
 *      just not re-escalated to the distinctly-tagged alert line each time.
 *
 * A streak resets on its own once `resetWindowMs` passes without a new
 * failure -- a rare, isolated boot failure is never treated as a "repeat"
 * and never accumulates backoff, so there is no separate "boot succeeded"
 * signal to wire in.
 */

/** Gitignored under `data/`, like the daemon's other on-disk stores (`DEFAULT_LOG_PATH`, `SessionStore`, `VectorStore`). Overridable via the `statePath` dep for tests. */
export const DEFAULT_BOOT_FAILURE_STATE_PATH = "./data/boot-failure-state.json";

/** A failure streak resets once this much time passes without a new failure. */
export const DEFAULT_RESET_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Minimum gap between two escalated "repeated boot failure" alerts within one streak. */
export const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** In-process backoff before `exit(1)`: base delay, doubled per consecutive failure. */
export const DEFAULT_BASE_BACKOFF_MS = 1_000;

/** In-process backoff cap -- bounds the exponential growth above. */
export const DEFAULT_MAX_BACKOFF_MS = 60_000;

export interface BootFailureState {
  /** Failures seen back-to-back within `resetWindowMs` of each other. */
  consecutiveFailures: number;
  /** ISO timestamp of this failure. */
  lastFailureAt: string;
  /** ISO timestamp of the last time this streak actually alerted (dedup gate); absent if the current streak hasn't alerted yet. */
  lastAlertAt?: string;
}

export interface PlanBootFailureOptions {
  resetWindowMs?: number;
  alertCooldownMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface BootFailurePlan {
  nextState: BootFailureState;
  shouldAlert: boolean;
  backoffMs: number;
}

/**
 * Pure decision core -- no I/O, so it's cheaply testable without touching
 * disk or fake timers. See the module doc comment for the streak/dedup/
 * backoff semantics.
 */
export function planBootFailureResponse(
  previous: BootFailureState | undefined,
  now: Date,
  options: PlanBootFailureOptions = {},
): BootFailurePlan {
  const {
    resetWindowMs = DEFAULT_RESET_WINDOW_MS,
    alertCooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  } = options;

  const nowMs = now.getTime();
  const withinStreak =
    previous !== undefined &&
    nowMs - Date.parse(previous.lastFailureAt) <= resetWindowMs;

  const consecutiveFailures = withinStreak
    ? previous.consecutiveFailures + 1
    : 1;

  // Only carry the streak's lastAlertAt forward when we're actually
  // continuing that streak -- a fresh streak (or a first-ever failure) must
  // always alert once, regardless of when some earlier, unrelated streak
  // last alerted.
  const carriedLastAlertAt = withinStreak ? previous.lastAlertAt : undefined;
  const shouldAlert =
    carriedLastAlertAt === undefined ||
    nowMs - Date.parse(carriedLastAlertAt) > alertCooldownMs;

  const backoffMs = Math.min(
    baseBackoffMs * 2 ** (consecutiveFailures - 1),
    maxBackoffMs,
  );

  return {
    nextState: {
      consecutiveFailures,
      lastFailureAt: now.toISOString(),
      lastAlertAt: shouldAlert ? now.toISOString() : carriedLastAlertAt,
    },
    shouldAlert,
    backoffMs,
  };
}

/**
 * Best-effort read; NEVER throws. A missing, corrupt, or unreadable file is
 * treated as "no previous failure" (a fresh streak) rather than blocking the
 * boot-failure handler itself -- state-file bookkeeping must never be able
 * to sink the crash-loop guard it supports.
 */
export function readBootFailureState(
  path: string,
): BootFailureState | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>).consecutiveFailures !==
        "number" ||
      typeof (raw as Record<string, unknown>).lastFailureAt !== "string"
    ) {
      return undefined;
    }
    return raw as BootFailureState;
  } catch {
    return undefined;
  }
}

/** Persists state; throws propagate to the caller, which (in `handleBootFailure`) treats this as best-effort and logs+swallows rather than letting bookkeeping block boot-failure handling. */
export function writeBootFailureState(
  path: string,
  state: BootFailureState,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state), "utf8");
}

export interface HandleBootFailureDeps {
  /** Durable local log path (same file `buildAlert`/`DEFAULT_LOG_PATH` writes to). */
  logPath: string;
  /** Defaults to {@link DEFAULT_BOOT_FAILURE_STATE_PATH}. */
  statePath?: string;
  /** Injectable clock; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable delay; defaults to a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** `process.exit`, injected so a test can assert the exit code without terminating the runner. */
  exit: (code: number) => void;
  /**
   * OPTIONAL best-effort alert transport for the escalated, deduped
   * "repeated boot failure" notice (e.g. Slack) -- omit when none is
   * available yet (the exact scenario this module targets, a pre-secrets
   * boot failure). The durable local log always records the escalation
   * either way, so omitting this still satisfies "alerts once ... or log".
   */
  alert?: (message: string) => Promise<void>;
  logger?: Pick<Console, "error">;
  options?: PlanBootFailureOptions;
}

/**
 * Installed at the top-level `main().catch(...)` boundary (src/index.ts) in
 * place of the old bare `console.error` + `process.exit(1)`. See the module
 * doc comment for the full mitigation this implements.
 */
export async function handleBootFailure(
  error: unknown,
  deps: HandleBootFailureDeps,
): Promise<void> {
  const {
    logPath,
    statePath = DEFAULT_BOOT_FAILURE_STATE_PATH,
    now = () => new Date(),
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    exit,
    alert,
    logger = console,
    options,
  } = deps;

  const message = `FATAL: boot failed; exiting for launchd to restart: ${String(error)}`;

  try {
    appendLog(logPath, message, now);
  } catch (err) {
    logger.error(`[boot-failure] local log append failed: ${String(err)}`);
  }

  const previous = readBootFailureState(statePath);
  const plan = planBootFailureResponse(previous, now(), options);

  try {
    writeBootFailureState(statePath, plan.nextState);
  } catch (err) {
    logger.error(`[boot-failure] state write failed: ${String(err)}`);
  }

  if (plan.shouldAlert) {
    const alertMessage = `[boot-failure-alert] repeated boot failure (${plan.nextState.consecutiveFailures} in a row, most recent below) -- see docs/RUNBOOK.md: ${message}`;
    try {
      appendLog(logPath, alertMessage, now);
    } catch (err) {
      logger.error(`[boot-failure] alert log append failed: ${String(err)}`);
    }
    if (alert) {
      try {
        await alert(alertMessage);
      } catch (err) {
        logger.error(`[boot-failure] alert transport failed: ${String(err)}`);
      }
    }
  }

  if (plan.backoffMs > 0) {
    await sleep(plan.backoffMs);
  }

  exit(1);
}
