import { DateTime } from "luxon";
import type { CalendarConfig } from "../config/config.js";
import type { CalendarEvent } from "./calendar-reader.js";

/**
 * Event→capacity classifier (ADR-0004 D3, bead r0o.3).
 *
 * A **pure** function: given a single night's date, the household's
 * `CalendarConfig` (D2 include-list + roles, D3 cookingWindow), and that
 * day's raw `CalendarEvent[]` (from `calendar-reader.ts`, unfiltered), it
 * computes that night's cooking `Capacity`. No I/O, no live calendar read —
 * this only reasons over already-read events, which is what makes it fully
 * unit-testable and independent of EventKit/osascript.
 *
 * Assembling the full 7-night `NightSchedule` (with each night's
 * `blocking_events` for the render) is the *next* bead (r0o.4) — this module
 * only owns the FULL/QUICK/NONE decision.
 *
 * **Algorithm (ADR-0004 D3, + bead 7o5's status ruling):**
 * 1. Ignore `canceled` events; count `confirmed` and `tentative` (bead 7o5).
 * 2. Ignore events whose `calendarName` doesn't match a `CalendarConfig`
 *    `include[]` entry (D2 — allow-list fails safe; an unlisted calendar
 *    never marks a night busy).
 * 3. Keep only events that overlap the night's `cookingWindow` (D3) — an
 *    event outside the window has no effect on that night. All-day events
 *    are assumed to cover the window.
 * 4. A `cook`-role event that **fully covers** the window (or is all-day)
 *    blocks the entire window → **NONE**. A `cook`-role event that only
 *    **partially** overlaps the window, or a `logistics`-role event that
 *    overlaps at all (full or partial — D3's "any logistics event
 *    overlapping the window pulls a cook" is deterministic and doesn't
 *    distinguish degree), → **QUICK**. No overlapping capacity-reducing
 *    event → **FULL**.
 *
 * `NONE` is checked first/short-circuits per event since it's the most
 * severe outcome and can't be downgraded by another event.
 */
export type Capacity = "FULL" | "QUICK" | "NONE";

function parseHhMm(value: string): { hour: number; minute: number } {
  const [hourStr, minuteStr] = value.split(":");
  return { hour: Number(hourStr), minute: Number(minuteStr) };
}

/**
 * Resolves `cookingWindow` (household-local wall-clock `HH:MM` strings) to
 * absolute instants for `date`, interpreted in `timezone` — mirrors the
 * `luxon`-based, explicit-timezone pattern used elsewhere for wall-clock math
 * (`orchestrator/week-key.ts`, `planner/season.ts`) rather than hand-rolled
 * offset arithmetic on a bare `Date`.
 */
export function cookingWindowInstants(
  date: Date,
  timezone: string,
  cookingWindow: CalendarConfig["cookingWindow"],
): { start: Date; end: Date } {
  const local = DateTime.fromJSDate(date, { zone: timezone });
  const startTime = parseHhMm(cookingWindow.start);
  const endTime = parseHhMm(cookingWindow.end);
  const start = local.set({
    hour: startTime.hour,
    minute: startTime.minute,
    second: 0,
    millisecond: 0,
  });
  const end = local.set({
    hour: endTime.hour,
    minute: endTime.minute,
    second: 0,
    millisecond: 0,
  });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** Standard half-open-interval overlap; all-day events always overlap (D3). */
export function overlapsWindow(
  event: CalendarEvent,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  if (event.allDay) {
    return true;
  }
  return event.start < windowEnd && event.end > windowStart;
}

/** Whether `event` covers the *entire* window (blocks it, not just part). */
export function fullyCoversWindow(
  event: CalendarEvent,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  if (event.allDay) {
    return true;
  }
  return event.start <= windowStart && event.end >= windowEnd;
}

/**
 * Classifies a single night's cooking capacity from that day's raw
 * `CalendarEvent[]` (see module doc for the algorithm).
 *
 * @param date the night's calendar date (any instant on that local day —
 *   only its `timezone`-local Y/M/D is used to anchor `cookingWindow`).
 * @param timezone IANA zone the `cookingWindow`'s wall-clock times are
 *   interpreted in (the household's pinned `Config.timezone`).
 * @param calendarConfig `CalendarConfig` — `include[]` (D2 allow-list +
 *   roles) and `cookingWindow` (D3) are consumed; `enabled` is a
 *   degrade-to-static concern owned by a sibling bead (r0o.6), not this
 *   classifier.
 * @param events that day's raw, unfiltered `CalendarEvent[]`.
 */
export function classifyNightCapacity(
  date: Date,
  timezone: string,
  calendarConfig: CalendarConfig,
  events: CalendarEvent[],
): Capacity {
  const { start: windowStart, end: windowEnd } = cookingWindowInstants(
    date,
    timezone,
    calendarConfig.cookingWindow,
  );

  const roleByCalendarName = new Map(
    calendarConfig.include.map((entry) => [entry.name, entry.role] as const),
  );

  let sawQuickTrigger = false;

  for (const event of events) {
    if (event.status === "canceled") {
      continue; // bead 7o5 — canceled events never count
    }

    const role = roleByCalendarName.get(event.calendarName);
    if (role === undefined) {
      continue; // D2 — unmatched calendar is not on the allow-list, ignored
    }

    if (!overlapsWindow(event, windowStart, windowEnd)) {
      continue; // D3 — an event outside the cooking window has no effect
    }

    if (role === "cook" && fullyCoversWindow(event, windowStart, windowEnd)) {
      return "NONE"; // entire window blocked for the available cook(s)
    }

    // A partial `cook` overlap, or ANY `logistics` overlap (full or
    // partial — the heuristic is deterministic on presence, not degree),
    // downgrades to QUICK.
    sawQuickTrigger = true;
  }

  return sawQuickTrigger ? "QUICK" : "FULL";
}
