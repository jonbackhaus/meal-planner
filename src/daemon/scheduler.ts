import { Cron } from "croner";

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

/** Injected hook invoked at each weekly trigger. Must not throw persistent process-crashing errors uncaught; the Scheduler awaits it but does not catch errors itself (callers/E3 own their own error handling). */
export type OnTriggerHook = () => Promise<void>;

export interface SchedulerOptions {
  /** IANA timezone (e.g. "America/Chicago") the weekly trigger is pinned to. */
  timezone: string;
  /** 24h "HH:MM" time-of-day (local to `timezone`) the weekly Sunday trigger fires at. */
  triggerTime: string;
  /** Injected async callback invoked at each weekly trigger and by `triggerNow()`. E3 supplies the real plan-generation call later; this module never implements it. */
  onTrigger: OnTriggerHook;
  /** Called (synchronously) when a trigger fires while a previous `onTrigger` run is still in-flight; the overlapping run is skipped, not queued. */
  onOverlap?: () => void;
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
  private job: Cron | null = null;
  private busy = false;

  constructor(options: SchedulerOptions) {
    this.pattern = buildWeeklySundayPattern(options.triggerTime);
    this.timezone = options.timezone;
    this.onTrigger = options.onTrigger;
    this.onOverlap = options.onOverlap;
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
      { timezone: this.timezone, protect: true },
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
      await this.onTrigger();
    } finally {
      this.busy = false;
    }
  }
}
