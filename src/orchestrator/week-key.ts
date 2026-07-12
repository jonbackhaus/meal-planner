import { DateTime } from "luxon";

/**
 * Clock-derived plan-week anchor (ADR 0002 D1 + D3). `week_key` is the
 * anchor Sunday's calendar date, in the pinned timezone, formatted
 * `YYYY-MM-DD` (e.g. `"2026-07-12"`). All generation gates on it; "active
 * week" is COMPUTED (`row.week_key === currentPlanWeek(now, cfg)`), never
 * stored.
 *
 * A wrong timezone silently mis-keys every week, so tz correctness
 * (including DST) is the whole point of this module. All wall-clock-in-a-
 * timezone math is done via `luxon` (DST-aware) — no hand-rolled offset
 * arithmetic on bare `Date`.
 *
 * Clock policy: every function here takes `now` (or a week_key) as an
 * explicit parameter. Nothing in this module calls `Date.now()` / argless
 * `new Date()` — the caller (the daemon) owns the clock, keeping this pure
 * and deterministic.
 *
 * Scope: pure date logic only. No DB, no Slack, no state machine — see
 * src/orchestrator/session-store.ts (storage) and later tasks (state
 * machine / generateForWeek / startup catch-up) for what's layered on top.
 */

/** The anchor Sunday's date (in the pinned tz), formatted `YYYY-MM-DD`. */
export type WeekKey = string;

/** The subset of Config this module needs. */
export interface WeekKeyConfig {
  /** IANA timezone (e.g. "America/Chicago") the week_key is pinned to. */
  timezone: string;
  /** 24h "HH:MM" time-of-day (local to `timezone`) the weekly trigger fires at. */
  triggerTime: string;
}

const TRIGGER_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTriggerTime(triggerTime: string): {
  hour: number;
  minute: number;
} {
  const match = TRIGGER_TIME_PATTERN.exec(triggerTime);
  if (!match) {
    throw new Error(
      `week-key: triggerTime "${triggerTime}" is invalid: must be a 24h HH:MM time (e.g. "06:00")`,
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Formats a DateTime's calendar date (in whatever zone it's already in) as a WeekKey. */
function dateKey(dt: DateTime): WeekKey {
  return dt.toFormat("yyyy-MM-dd");
}

/**
 * The most recent Sunday on/before `local` (start-of-day, same zone as
 * `local`) — `local` itself if it's already Sunday.
 *
 * Luxon uses ISO weekdays (Monday = 1 ... Sunday = 7), so `weekday % 7`
 * yields the day-count back to the most recent Sunday: Sunday -> 0,
 * Monday -> 1, ..., Saturday -> 6.
 */
function mostRecentSundayOnOrBefore(local: DateTime): DateTime {
  const daysSinceSunday = local.weekday % 7;
  return local.startOf("day").minus({ days: daysSinceSunday });
}

/** The absolute trigger instant (as a DateTime, in the same zone as `sunday`) for that anchor Sunday. */
function triggerInstantFor(sunday: DateTime, cfg: WeekKeyConfig): DateTime {
  const { hour, minute } = parseTriggerTime(cfg.triggerTime);
  return sunday.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * The currently-active plan week, computed from `now` (per ADR 0002's
 * pseudocode): the most recent Sunday on/before `now` (in the pinned tz),
 * UNLESS that Sunday's trigger hasn't fired yet — in which case the prior
 * week is still active.
 */
export function currentPlanWeek(now: Date, cfg: WeekKeyConfig): WeekKey {
  const local = DateTime.fromJSDate(now, { zone: cfg.timezone });
  const sunday = mostRecentSundayOnOrBefore(local);
  const trigger = triggerInstantFor(sunday, cfg);
  return local.toMillis() >= trigger.toMillis()
    ? dateKey(sunday)
    : dateKey(sunday.minus({ days: 7 }));
}

/**
 * The Sunday 7 calendar days before `wk`. Pure calendar arithmetic (no
 * timezone dependency): `wk` is a date-only string, so this is computed in
 * UTC to stay deterministic regardless of the host system's local zone.
 */
export function previousPlanWeek(wk: WeekKey): WeekKey {
  return dateKey(DateTime.fromISO(wk, { zone: "utc" }).minus({ days: 7 }));
}

/**
 * The absolute instant (as a UTC `Date`) of `wk`'s trigger: the anchor
 * Sunday at `cfg.triggerTime` local wall-clock time, in the pinned tz.
 * DST-correct — the same wall-clock time can resolve to a different UTC
 * offset depending on the date (e.g. CST vs CDT for America/Chicago).
 */
export function triggerMoment(wk: WeekKey, cfg: WeekKeyConfig): Date {
  const sunday = DateTime.fromISO(wk, { zone: cfg.timezone });
  return triggerInstantFor(sunday, cfg).toJSDate();
}

/** Whether `wk` is the currently-active plan week, given `now`. */
export function isActiveWeek(
  wk: WeekKey,
  now: Date,
  cfg: WeekKeyConfig,
): boolean {
  return wk === currentPlanWeek(now, cfg);
}
