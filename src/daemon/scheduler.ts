import { Cron } from "croner";
import { TimeoutError, withTimeout } from "./with-timeout.js";

/**
 * In-process weekly Sunday-trigger scheduler (SPEC §3.2, §9.4).
 *
 * The daemon runs permanently on a machine that never sleeps; `launchd` owns
 * only boot-launch + KeepAlive (see deploy/launchd/). There is NO launchd
 * calendar job — this Scheduler is the sole owner of weekly trigger timing,
 * running inside the resident process at the Sunday `triggerTime` slot in the
 * pinned `timezone`, DST-correct (via `croner`, a zero-dependency
 * timezone-aware cron library).
 *
 * Scope boundary: this module does NOT know about plan generation or
 * startup catch-up. Both are injected:
 *  - `onTrigger`: the async callback invoked at each weekly trigger (and by
 *    `triggerNow()`). E3 (ADR 0002) supplies the real `generateForWeek`
 *    implementation; this scheduler only owns *when* it runs, not *what* it
 *    does.
 *  - `onOverlap` (optional): called instead of `onTrigger` when a trigger
 *    fires while a previous `onTrigger` run is still in progress. Default
 *    behavior if omitted: silently skip (still guarded; just no callback).
 */

/**
 * Injected hook invoked at each weekly trigger (and by `triggerNow()`).
 *
 * Error containment differs by call path:
 *  - SCHEDULED trigger (the weekly Sunday fire): if this throws/rejects, the
 *    Scheduler contains the error — catches it (via croner's `catch` option)
 *    and logs it through `SchedulerOptions.logger` — so a single failing
 *    generation run can never crash the resident daemon; the weekly schedule
 *    keeps running.
 *  - `triggerNow()` / `fireOnStart` (the explicit test-fire path): the error
 *    is NOT contained here — it propagates to the awaiting caller so a test
 *    fire's failure can be observed directly.
 */
export type OnTriggerHook = () => Promise<void>;

/** Minimal logger surface the Scheduler needs; defaults to `console`. */
export type SchedulerLogger = Pick<Console, "warn">;

export interface SchedulerOptions {
  /** IANA timezone (e.g. "America/Chicago") the weekly trigger is pinned to. */
  timezone: string;
  /** 24h "HH:MM" time-of-day (local to `timezone`) the weekly Sunday trigger fires at. */
  triggerTime: string;
  /** Injected async callback invoked at each weekly trigger and by `triggerNow()`. E3 supplies the real plan-generation call later; this module never implements it. */
  onTrigger: OnTriggerHook;
  /** Called (synchronously) when a trigger fires while a previous `onTrigger` run is still in-flight; the overlapping run is skipped, not queued. Wired both to the in-process re-entrant guard AND to croner's own scheduled-overlap `protect` path. */
  onOverlap?: () => void;
  /**
   * Watchdog cap (ms) for a single `onTrigger` run (bd meal-planner-bd6.11).
   * When set, a run that hasn't settled within this many ms stops being
   * WAITED ON: the re-entrant `busy` flag is released (so future triggers
   * aren't skipped for the life of the process) and `onTimeout` fires. The
   * underlying run is NOT cancelled — it may still be in flight; this is
   * alert-only, no state change (the post window is undecidable, cf. D4).
   * Omit to disable the watchdog entirely.
   */
  triggerTimeoutMs?: number;
  /** Invoked once when a run exceeds `triggerTimeoutMs`. Wired by the daemon to the never-throwing `alert` composite so the timeout surfaces through the existing alert mechanism. Ignored if `triggerTimeoutMs` is unset. */
  onTimeout?: () => void | Promise<void>;
  /** Invoked with any error `onTrigger` throws/rejects with during a SCHEDULED fire (never for `triggerNow()`, which rejects to its caller instead); defaults to `console`. Never receives or logs secret values — only the error itself. */
  logger?: SchedulerLogger;
}

const TRIGGER_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTriggerTime(triggerTime: string): {
  hour: number;
  minute: number;
} {
  const match = TRIGGER_TIME_PATTERN.exec(triggerTime);
  if (!match) {
    throw new Error(
      `Scheduler: triggerTime "${triggerTime}" is invalid: must be a 24h HH:MM time (e.g. "06:00")`,
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Builds a 5-part cron pattern for "every Sunday at HH:MM" (croner: 0 = Sunday). */
function buildWeeklySundayPattern(triggerTime: string): string {
  const { hour, minute } = parseTriggerTime(triggerTime);
  return `${minute} ${hour} * * 0`;
}

export class Scheduler {
  private readonly pattern: string;
  private readonly timezone: string;
  private readonly onTrigger: OnTriggerHook;
  private readonly onOverlap?: () => void;
  private readonly triggerTimeoutMs?: number;
  private readonly onTimeout?: () => void | Promise<void>;
  private readonly logger: SchedulerLogger;
  private job: Cron | null = null;
  private busy = false;

  constructor(options: SchedulerOptions) {
    this.pattern = buildWeeklySundayPattern(options.triggerTime);
    this.timezone = options.timezone;
    this.onTrigger = options.onTrigger;
    this.onOverlap = options.onOverlap;
    this.triggerTimeoutMs = options.triggerTimeoutMs;
    this.onTimeout = options.onTimeout;
    this.logger = options.logger ?? console;
  }

  /**
   * Computes the next weekly Sunday-trigger Date after `from` (default: now),
   * in the pinned timezone. Pure/side-effect-free: constructing the probe
   * Cron used here does NOT start any timer (no function is attached to it),
   * so this is safe to call repeatedly in tests without leaking timers.
   */
  nextRun(from?: Date): Date | null {
    const probe = new Cron(this.pattern, { timezone: this.timezone });
    return probe.nextRun(from);
  }

  /** Whether `start()` has been called and `stop()` has not since. */
  isActive(): boolean {
    return this.job !== null;
  }

  /**
   * Starts the weekly schedule. Idempotent: calling `start()` again while
   * already active is a no-op (does not double-schedule).
   */
  start(): void {
    if (this.job) {
      return;
    }
    this.job = new Cron(
      this.pattern,
      {
        timezone: this.timezone,
        // A protect CALLBACK, not a boolean (bd meal-planner-bd6.11): croner
        // still skips a scheduled fire that overlaps a previous still-running
        // one, but with `protect: true` it skips BEFORE invoking our callback,
        // so `guardedTrigger` is never entered and the skip is fully silent.
        // Passing a function makes croner notify us on that skip; we route it
        // to the same `onOverlap` warn the in-process re-entrant guard uses.
        // (In practice the watchdog usually releases the run before the next
        // weekly fire, so this is a belt-and-suspenders signal for the rare
        // case a run outlives a whole week.)
        protect: () => {
          this.onOverlap?.();
        },
        // Contains errors from SCHEDULED fires only: croner wraps its call to
        // our callback in its own try/catch when `catch` is set, so a
        // throwing/rejecting `onTrigger` is logged here instead of becoming
        // an unhandled rejection that would crash the resident daemon. This
        // does NOT apply to `triggerNow()`, which calls `guardedTrigger()`
        // directly (bypassing croner's own trigger path) and so still
        // rejects to its caller.
        catch: (error: unknown) => {
          this.logger.warn(
            `Scheduler: onTrigger threw during a scheduled fire; the error is contained (logged, not rethrown) so the daemon keeps running and the weekly schedule stays active: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      },
      () => this.guardedTrigger(),
    );
  }

  /** Cancels the schedule. Guaranteed to leave no pending timer. Safe to call even if never started. */
  stop(): void {
    this.job?.stop();
    this.job = null;
  }

  /**
   * Test-fire affordance (SPEC §9.4 "do one real test-fire"): invokes
   * `onTrigger` once, immediately, independent of the weekly schedule. Still
   * subject to the same re-entrant guard as scheduled triggers.
   */
  async triggerNow(): Promise<void> {
    await this.guardedTrigger();
  }

  private async guardedTrigger(): Promise<void> {
    if (this.busy) {
      this.onOverlap?.();
      return;
    }
    this.busy = true;
    try {
      await this.runWithWatchdog();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Runs `onTrigger` under the optional watchdog (`triggerTimeoutMs`). On a
   * genuine timeout it stops WAITING on the (still-running) run and fires
   * `onTimeout` — alert-only, no state change — then returns normally so the
   * enclosing `finally` releases the `busy` flag and future fires still run.
   * Any NON-timeout rejection propagates unchanged, preserving the existing
   * containment (croner's `catch` on scheduled fires; the caller on
   * `triggerNow()`). With no `triggerTimeoutMs`, `onTrigger` is awaited
   * directly (unchanged behavior).
   */
  private async runWithWatchdog(): Promise<void> {
    const run = this.onTrigger();
    if (this.triggerTimeoutMs === undefined) {
      await run;
      return;
    }
    try {
      await withTimeout(run, {
        timeoutMs: this.triggerTimeoutMs,
        message: `Scheduler: onTrigger did not settle within its ${this.triggerTimeoutMs}ms watchdog timeout`,
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        // Watchdog expiry: alert only, NO state change. The underlying run is
        // deliberately left in flight (withTimeout keeps a rejection handler
        // attached to it, so a later failure can't become an unhandled
        // rejection); we only stop waiting so `busy` releases.
        await this.onTimeout?.();
        return;
      }
      throw error;
    }
  }
}
