import { DateTime } from "luxon";
import type { CalendarConfig, CookNights } from "../config/config.js";
import type { WeekKey } from "../orchestrator/week-key.js";
import type {
  CalendarEvent,
  CalendarReaderOptions,
} from "./calendar-reader.js";
import {
  assembleNightSchedule,
  type Night,
  type NightSchedule,
} from "./night-schedule.js";

/**
 * Live-read + degrade-to-static provider for the week's `NightSchedule`
 * (ADR-0004 D6, bead r0o.6).
 *
 * This is the caller `assembleNightSchedule`'s own doc comment describes as
 * "the sibling bead r0o.6" job: decide what event list (real, or the static
 * v1.0 fallback) to hand to the pure assembler, and never let a calendar
 * outage fail the week (bead `a9e`'s degrade-don't-fail stance, matching the
 * existing recipe-sync/index.ts alert-once-and-proceed idiom).
 *
 * **Degrade triggers (this function never throws):**
 *   - `config.calendar.enabled === false` (the D6 master switch).
 *   - `readEvents` rejects (TCC not granted, `osascript` timeout/failure,
 *     malformed output — anything `calendar-reader.ts` can throw).
 *
 * **NOT a degrade trigger — a genuinely free week:** a *successful* read
 * that happens to return zero events (or whose 7 assembled nights all land
 * FULL) is a legitimately free week, not an unavailable calendar. ADR-0004
 * D6 lists "empty schedule" among the fallback triggers, but degrading a
 * real, successful read of a quiet week would produce a LESS accurate
 * schedule than just trusting the read — and `assembleNightSchedule` already
 * returns all-FULL nights for an empty `events` array (see
 * `night-schedule.test.ts`), which correctly reflects that no cook is
 * blocked. So this function does not special-case "empty" as its own
 * trigger; only "did the read happen at all" (enabled + succeeded) decides
 * real-vs-fallback. See FOLLOW-UPS in the delivering task for this
 * intentional narrowing of D6's "empty schedule" wording.
 *
 * **On degrade:** returns a STATIC fallback `NightSchedule` sized to the
 * v1.0 `cookNights` counts (`constrained` weeknights + `relaxed` weekend
 * nights, ADR-0004 D6's "3-4 weeknight + 2 weekend"), every included night
 * FULL with no `blocking_events` — then alerts `#agent-alerts` exactly ONCE
 * via the injected `alert` (never re-derives its own Slack transport; reuses
 * the composite already wired in `src/index.ts`/`src/ops/alerter.ts`) and
 * proceeds. The alert call is itself guarded (try/catch, `logger.warn` on
 * failure) so a broken alerter can never sink an otherwise-successful
 * degrade, mirroring `makeBuildPlanWithSync`'s existing proceed+alert calls.
 *
 * This function is standalone: it is not yet wired into `build-plan.ts`
 * (that integration is the next task, bead r0o.5) — every dependency here is
 * injected so it is fully unit-testable without a live calendar or Slack.
 */

/** The subset of `Config` this provider needs, injected for testability. */
export interface WeekNightScheduleConfig {
  timezone: string;
  calendar: CalendarConfig;
  cookNights: CookNights;
}

export interface GetWeekNightScheduleDeps {
  /** The plan week to build a `NightSchedule` for (anchor Sunday). */
  weekKey: WeekKey;
  config: WeekNightScheduleConfig;
  /** Injected so tests never touch the live `osascript` calendar reader. */
  readEvents: (options: CalendarReaderOptions) => Promise<CalendarEvent[]>;
  /** The never-throwing `#agent-alerts` composite (`src/ops/alerter.ts`'s `makeAlert`). */
  alert: (message: string) => Promise<void>;
  /** Injectable for tests; defaults to `console`. */
  logger?: Pick<Console, "warn" | "error">;
}

/** Offsets (days from the anchor Sunday) treated as weeknights (Mon-Fri). */
const WEEKNIGHT_OFFSETS = [1, 2, 3, 4, 5];
/** Offsets (days from the anchor Sunday) treated as weekend nights (Sun, Sat). */
const WEEKEND_OFFSETS = [0, 6];

function nightAt(weekKey: WeekKey, timezone: string, offset: number): Night {
  const local = DateTime.fromISO(weekKey, { zone: timezone }).plus({
    days: offset,
  });
  return {
    date: local.toFormat("yyyy-MM-dd"),
    weekday: local.toFormat("cccc"),
    capacity: "FULL",
    blocking_events: [],
  };
}

/**
 * The static v1.0 fallback (ADR-0004 D6): `cookNights.constrained` weeknights
 * + `cookNights.relaxed` weekend nights, every one FULL with no
 * `blocking_events` — sized to the historical static count rather than the
 * full 7-real-calendar-night structure a live read produces, so a downstream
 * consumer deriving slot counts from "count of non-NONE nights" (ADR-0004 D4)
 * recovers exactly the configured `cookNights` values.
 */
function buildStaticFallbackSchedule(
  weekKey: WeekKey,
  timezone: string,
  cookNights: CookNights,
): NightSchedule {
  const weeknightCount = Math.min(
    cookNights.constrained,
    WEEKNIGHT_OFFSETS.length,
  );
  const weekendCount = Math.min(cookNights.relaxed, WEEKEND_OFFSETS.length);

  return [
    ...WEEKNIGHT_OFFSETS.slice(0, weeknightCount).map((offset) =>
      nightAt(weekKey, timezone, offset),
    ),
    ...WEEKEND_OFFSETS.slice(0, weekendCount).map((offset) =>
      nightAt(weekKey, timezone, offset),
    ),
  ];
}

/** `[start, end)` covering the plan week's 7 nights, for `readEvents`. */
function planWeekRange(
  weekKey: WeekKey,
  timezone: string,
): { start: Date; end: Date } {
  const sunday = DateTime.fromISO(weekKey, { zone: timezone }).startOf("day");
  return {
    start: sunday.toJSDate(),
    end: sunday.plus({ days: 7 }).toJSDate(),
  };
}

async function degradeToStatic(
  deps: GetWeekNightScheduleDeps,
  reason: string,
): Promise<NightSchedule> {
  const { weekKey, config, alert, logger = console } = deps;
  const message =
    `calendar unavailable for week ${weekKey}: ${reason}. Falling back to ` +
    `the static v1.0 night count (${config.cookNights.constrained} weeknight ` +
    `+ ${config.cookNights.relaxed} weekend, all FULL) and proceeding ` +
    "(ADR-0004 D6).";
  logger.warn(`[calendar-degrade] ${message}`);
  try {
    await alert(message);
  } catch (err) {
    logger.error(`[calendar-degrade] alert failed: ${String(err)}`);
  }
  return buildStaticFallbackSchedule(
    weekKey,
    config.timezone,
    config.cookNights,
  );
}

/**
 * Returns the plan week's `NightSchedule`: the real, live-read schedule when
 * the calendar is enabled and readable, else the static v1.0 fallback (see
 * module doc). Never throws.
 */
export async function getWeekNightSchedule(
  deps: GetWeekNightScheduleDeps,
): Promise<NightSchedule> {
  const { weekKey, config, readEvents } = deps;

  if (!config.calendar.enabled) {
    return degradeToStatic(deps, "calendar.enabled is false");
  }

  let events: CalendarEvent[];
  try {
    const { start, end } = planWeekRange(weekKey, config.timezone);
    events = await readEvents({
      start,
      end,
      calendarNames: config.calendar.include.map((entry) => entry.name),
    });
  } catch (err) {
    return degradeToStatic(deps, `calendar read failed: ${String(err)}`);
  }

  return assembleNightSchedule({
    weekKey,
    timezone: config.timezone,
    calendarConfig: config.calendar,
    events,
  });
}
