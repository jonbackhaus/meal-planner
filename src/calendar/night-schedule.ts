import { DateTime } from "luxon";
import type { CalendarConfig } from "../config/config.js";
import type { WeekKey } from "../orchestrator/week-key.js";
import type { CalendarEvent } from "./calendar-reader.js";
import {
  type Capacity,
  classifyNightCapacity,
  cookingWindowInstants,
  fullyCoversWindow,
  overlapsWindow,
} from "./capacity-classifier.js";

/**
 * NightSchedule assembler (ADR-0004 D4, bead r0o.4).
 *
 * This is the ADR-0004 <-> bead-824 seam: "here are the 7 nights and each
 * one's cooking capacity, and why" (blocking_events). It orchestrates
 * read -> per-night classify -> product, but the *read* itself is NOT this
 * module's job: `assembleNightSchedule` takes already-read `CalendarEvent[]`
 * as a parameter rather than calling `readCalendarEvents` internally. This
 * keeps it a pure, synchronous, fully unit-testable function with no live
 * calendar/EventKit dependency — the same shape choice `capacity-classifier.ts`
 * made one layer down. The live read + degrade-to-static fallback (ADR-0004
 * D6) is the caller's job (sibling bead r0o.6), which decides what event list
 * (real or empty/fallback) to hand in here.
 *
 * **Week alignment:** the caller passes `weekKey` (`orchestrator/week-key.ts`'s
 * `WeekKey` — the anchor Sunday, `YYYY-MM-DD`, in the pinned `timezone`). This
 * module does NOT re-derive the week boundary; it anchors the 7 nights to
 * whatever `weekKey` the orchestrator already computed (ADR 0002's
 * `currentPlanWeek`), so the NightSchedule always lines up with the plan
 * week it feeds.
 *
 * **Capacity vs. blocking_events:** the authoritative FULL/QUICK/NONE call for
 * each night is delegated to `classifyNightCapacity` (capacity-classifier.ts,
 * unmodified) — this module never re-derives that decision. `blocking_events`
 * is additional detail this module derives itself: which of that night's
 * events actually drove the QUICK/NONE result, so the render can show why.
 * This uses the same `cookingWindowInstants`/`overlapsWindow`/
 * `fullyCoversWindow` helpers `capacity-classifier.ts` uses internally
 * (exported from there, bead r0o.9) rather than a separate copy of that
 * window-overlap math.
 *
 * **Bucketing events into nights (DST/tz-safety):** a timed (non-all-day)
 * event never needs date-bucketing — `classifyNightCapacity`'s window-overlap
 * check is exact-instant, so handing it the full event list and letting it
 * filter by real overlap against each night's absolute cooking-window instants
 * already buckets timed events correctly (including a cross-midnight event
 * that might overlap two different nights' windows). An **all-day** event is
 * different: `capacity-classifier.ts` treats `allDay: true` as "always
 * overlaps" unconditionally (by design — it expects the caller to have
 * already scoped events to "that day"), so this module explicitly resolves
 * which local calendar date(s) (in `timezone`) an all-day event's
 * `[start, end)` span covers, via `luxon`'s DST-aware zoned arithmetic (never
 * a bare-`Date` offset), and only hands that event to a given night's
 * classify/blocking call when the night's date falls in that span.
 */

export type { Capacity };

/**
 * A single event that contributed to a night being QUICK or NONE (ADR-0004
 * D4 interface sketch). `effect` mirrors the classifier's own decision:
 * `"removes-cook"` for a `cook`-role event that fully covers the cooking
 * window (drives NONE), `"pulls-cook-away"` for a partial `cook` overlap or
 * any `logistics` overlap (drives QUICK).
 */
export interface BlockingEvent {
  calendar: string;
  role: "cook" | "logistics";
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  effect: "removes-cook" | "pulls-cook-away";
}

/** One night's assembled cooking-capacity record (ADR-0004 D4). */
export interface Night {
  /** ISO calendar date (`YYYY-MM-DD`), in `timezone`. */
  date: string;
  /** Full local weekday name (e.g. `"Monday"`), in `timezone`. */
  weekday: string;
  capacity: Capacity;
  blocking_events: BlockingEvent[];
}

/** Exactly 7 nights (Sunday..Saturday of the anchored plan week). */
export type NightSchedule = Night[];

export interface AssembleNightScheduleOptions {
  /**
   * The anchor Sunday (`orchestrator/week-key.ts`'s `WeekKey`) this schedule
   * covers — reused, never re-derived, so the 7 nights line up with the
   * plan week.
   */
  weekKey: WeekKey;
  /** IANA timezone the schedule's dates/weekdays/cookingWindow are anchored in. */
  timezone: string;
  calendarConfig: CalendarConfig;
  /**
   * Already-read, unfiltered `CalendarEvent[]` spanning (at least) the 7
   * nights — typically the output of `readCalendarEvents` for that range, or
   * an empty array on the ADR-0004 D6 degrade path. Allow-listing by
   * calendar name/role and window-overlap filtering happen inside this
   * function; the caller does not need to pre-filter.
   */
  events: CalendarEvent[];
}

const NIGHTS_PER_WEEK = 7;

/** `date`'s calendar date, in `timezone`, as `YYYY-MM-DD`. */
function localDateKey(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat("yyyy-MM-dd");
}

/**
 * Whether all-day `event`'s `[start, end)` span (in `timezone`-local
 * calendar days) includes `date`'s local calendar date. Walks day-by-day via
 * `luxon` zoned arithmetic (DST-safe) rather than diffing raw millis, since a
 * DST transition can make a calendar day 23 or 25 hours long.
 */
function allDaySpanIncludesDate(
  event: CalendarEvent,
  date: Date,
  timezone: string,
): boolean {
  const targetKey = localDateKey(date, timezone);
  const endBoundary = DateTime.fromJSDate(event.end, { zone: timezone });
  let cursor = DateTime.fromJSDate(event.start, { zone: timezone }).startOf(
    "day",
  );
  // Bounded: an all-day event spans a finite, small number of calendar days;
  // this loop only walks the event's own span, not the whole schedule range.
  while (cursor < endBoundary) {
    if (cursor.toFormat("yyyy-MM-dd") === targetKey) {
      return true;
    }
    cursor = cursor.plus({ days: 1 });
  }
  return false;
}

/**
 * Scopes `events` to those that can possibly affect the night dated `date`
 * (see module doc — "Bucketing events into nights"): a timed event is always
 * included (the window-overlap check downstream does the real filtering); an
 * all-day event is included only if its local-date span covers this night.
 */
function eventsForNight(
  events: CalendarEvent[],
  date: Date,
  timezone: string,
): CalendarEvent[] {
  return events.filter((event) =>
    event.allDay ? allDaySpanIncludesDate(event, date, timezone) : true,
  );
}

function toBlockingEvent(
  event: CalendarEvent,
  role: "cook" | "logistics",
  effect: BlockingEvent["effect"],
): BlockingEvent {
  return {
    calendar: event.calendarName,
    role,
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    allDay: event.allDay,
    effect,
  };
}

/**
 * Computes the events that drove a night's actual `capacity` (ADR-0004 D4):
 * for a NONE night, only the fully-window-covering `cook` event(s)
 * (`"removes-cook"`) — any co-occurring partial/`logistics` events didn't
 * independently cause NONE. For a QUICK night, every qualifying event
 * (`"pulls-cook-away"`) — by construction none of them fully cover the
 * window as `cook`, else `capacity` would be NONE instead. For a FULL night,
 * always empty.
 */
function blockingEventsForNight(
  nightEvents: CalendarEvent[],
  date: Date,
  timezone: string,
  calendarConfig: CalendarConfig,
  capacity: Capacity,
): BlockingEvent[] {
  if (capacity === "FULL") {
    return [];
  }

  const { start: windowStart, end: windowEnd } = cookingWindowInstants(
    date,
    timezone,
    calendarConfig.cookingWindow,
  );
  const roleByCalendarName = new Map(
    calendarConfig.include.map((entry) => [entry.name, entry.role] as const),
  );

  const qualifying: BlockingEvent[] = [];
  for (const event of nightEvents) {
    if (event.status === "canceled") {
      continue;
    }
    const role = roleByCalendarName.get(event.calendarName);
    if (role === undefined) {
      continue;
    }
    if (!overlapsWindow(event, windowStart, windowEnd)) {
      continue;
    }
    if (role === "cook" && fullyCoversWindow(event, windowStart, windowEnd)) {
      qualifying.push(toBlockingEvent(event, role, "removes-cook"));
      continue;
    }
    qualifying.push(toBlockingEvent(event, role, "pulls-cook-away"));
  }

  return capacity === "NONE"
    ? qualifying.filter((be) => be.effect === "removes-cook")
    : qualifying; // QUICK: every qualifying entry here is pulls-cook-away
}

/**
 * Assembles the 7-night `NightSchedule` (ADR-0004 D4) for the plan week
 * anchored at `options.weekKey`: Sunday..Saturday, each with its
 * `classifyNightCapacity` verdict and `blocking_events`.
 */
export function assembleNightSchedule(
  options: AssembleNightScheduleOptions,
): NightSchedule {
  const { weekKey, timezone, calendarConfig, events } = options;
  const sunday = DateTime.fromISO(weekKey, { zone: timezone });

  const nights: Night[] = [];
  for (let i = 0; i < NIGHTS_PER_WEEK; i++) {
    const local = sunday.plus({ days: i });
    const date = local.toJSDate();

    const nightEvents = eventsForNight(events, date, timezone);
    const capacity = classifyNightCapacity(
      date,
      timezone,
      calendarConfig,
      nightEvents,
    );
    const blocking_events = blockingEventsForNight(
      nightEvents,
      date,
      timezone,
      calendarConfig,
      capacity,
    );

    nights.push({
      date: local.toFormat("yyyy-MM-dd"),
      weekday: local.toFormat("cccc"),
      capacity,
      blocking_events,
    });
  }

  return nights;
}
