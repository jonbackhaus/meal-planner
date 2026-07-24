import { describe, expect, it } from "vitest";
import type { CalendarConfig } from "../config/config.js";
import type { CalendarEvent } from "./calendar-reader.js";
import {
  assembleNightSchedule,
  type BlockingEvent,
  toNightCapacitySchedule,
} from "./night-schedule.js";

/**
 * ADR-0004 D4 NightSchedule assembler tests (bead r0o.4).
 *
 * Matches the fixture style of `capacity-classifier.test.ts`: explicit UTC
 * ISO `Date`s with a comment giving the local-time equivalent, never a
 * hand-rolled offset. `America/Chicago` throughout.
 *
 * Main week: `weekKey` "2026-08-02" (a Sunday) -> nights Aug 2 (Sun) .. Aug 8
 * (Sat). Aug 3 is a Monday (matches `capacity-classifier.test.ts`'s fixture
 * day), cookingWindow 16:30-19:30 local == 21:30Z-00:30Z(+1) on a non-DST
 * date (CDT, UTC-5).
 */

const TIMEZONE = "America/Chicago";

const CALENDAR_CONFIG: CalendarConfig = {
  enabled: true,
  include: [
    { name: "Jonathan", role: "cook" },
    { name: "Family", role: "cook" },
    { name: "Kids", role: "logistics" },
  ],
  cookingWindow: { start: "16:30", end: "19:30" },
};

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarName: "Jonathan",
    title: "Test event",
    start: new Date("2026-08-04T21:30:00Z"), // 16:30 CDT Tue Aug 4 (window start)
    end: new Date("2026-08-04T22:30:00Z"), // 17:30 CDT Tue Aug 4
    allDay: false,
    status: "confirmed",
    ...overrides,
  };
}

const EXPECTED_DATES = [
  ["2026-08-02", "Sunday"],
  ["2026-08-03", "Monday"],
  ["2026-08-04", "Tuesday"],
  ["2026-08-05", "Wednesday"],
  ["2026-08-06", "Thursday"],
  ["2026-08-07", "Friday"],
  ["2026-08-08", "Saturday"],
];

describe("assembleNightSchedule", () => {
  it("produces exactly 7 nights with correct date/weekday mapping, all FULL, for an empty week", () => {
    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [],
    });

    expect(schedule).toHaveLength(7);
    expect(schedule.map((n) => [n.date, n.weekday])).toEqual(EXPECTED_DATES);
    for (const night of schedule) {
      expect(night.capacity).toBe("FULL");
      expect(night.blocking_events).toEqual([]);
    }
  });

  it("buckets a timed event into only its own night, leaving neighboring nights FULL", () => {
    // Tuesday Aug 4, cook-role, fully covers the window -> that night NONE.
    const fullyCovers = event({
      calendarName: "Jonathan",
      start: new Date("2026-08-04T20:00:00Z"), // 15:00 CDT
      end: new Date("2026-08-05T01:00:00Z"), // 20:00 CDT
    });

    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [fullyCovers],
    });

    const byDate = new Map(schedule.map((n) => [n.date, n]));
    expect(byDate.get("2026-08-03")?.capacity).toBe("FULL"); // Monday: untouched
    expect(byDate.get("2026-08-04")?.capacity).toBe("NONE"); // Tuesday: blocked
    expect(byDate.get("2026-08-05")?.capacity).toBe("FULL"); // Wednesday: untouched
  });

  it("populates blocking_events (effect removes-cook) only on the NONE night the event drove", () => {
    const fullyCovers = event({
      calendarName: "Family",
      title: "Family thing",
      start: new Date("2026-08-04T20:00:00Z"), // 15:00 CDT Tue
      end: new Date("2026-08-05T01:00:00Z"), // 20:00 CDT Tue
    });

    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [fullyCovers],
    });

    const byDate = new Map(schedule.map((n) => [n.date, n]));
    const tuesday = byDate.get("2026-08-04");
    expect(tuesday?.capacity).toBe("NONE");
    const expected: BlockingEvent = {
      calendar: "Family",
      role: "cook",
      title: "Family thing",
      start: "2026-08-04T20:00:00.000Z",
      end: "2026-08-05T01:00:00.000Z",
      allDay: false,
      effect: "removes-cook",
    };
    expect(tuesday?.blocking_events).toEqual([expected]);

    // Every other night: FULL, no blocking events.
    for (const [date, night] of byDate) {
      if (date === "2026-08-04") continue;
      expect(night.capacity).toBe("FULL");
      expect(night.blocking_events).toEqual([]);
    }
  });

  it("populates blocking_events (effect pulls-cook-away) for a QUICK night driven by a logistics event", () => {
    const logisticsRun = event({
      calendarName: "Kids",
      title: "Soccer practice",
      start: new Date("2026-08-04T22:00:00Z"), // 17:00 CDT Tue
      end: new Date("2026-08-04T22:30:00Z"), // 17:30 CDT Tue
    });

    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [logisticsRun],
    });

    const tuesday = schedule.find((n) => n.date === "2026-08-04");
    expect(tuesday?.capacity).toBe("QUICK");
    expect(tuesday?.blocking_events).toEqual([
      {
        calendar: "Kids",
        role: "logistics",
        title: "Soccer practice",
        start: "2026-08-04T22:00:00.000Z",
        end: "2026-08-04T22:30:00.000Z",
        allDay: false,
        effect: "pulls-cook-away",
      },
    ]);
  });

  it("excludes a co-occurring non-driving event from a NONE night's blocking_events", () => {
    // A logistics run overlaps the same Tuesday window, but a separate
    // fully-covering cook event already makes the night NONE — the
    // logistics event didn't independently drive that outcome, so it's
    // excluded from blocking_events (only the removes-cook event(s) drove
    // NONE).
    const fullyCoveringCook = event({
      calendarName: "Jonathan",
      title: "Blocks everything",
      start: new Date("2026-08-04T20:00:00Z"),
      end: new Date("2026-08-05T01:00:00Z"),
    });
    const coOccurringLogistics = event({
      calendarName: "Kids",
      title: "Soccer practice",
      start: new Date("2026-08-04T22:00:00Z"),
      end: new Date("2026-08-04T22:30:00Z"),
    });

    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [fullyCoveringCook, coOccurringLogistics],
    });

    const tuesday = schedule.find((n) => n.date === "2026-08-04");
    expect(tuesday?.capacity).toBe("NONE");
    expect(tuesday?.blocking_events).toHaveLength(1);
    expect(tuesday?.blocking_events[0]?.title).toBe("Blocks everything");
  });

  it("ignores an event on a calendar not in CalendarConfig.include[] (D2 allow-list)", () => {
    const unmatched = event({
      calendarName: "US Holidays",
      start: new Date("2026-08-04T20:00:00Z"),
      end: new Date("2026-08-05T01:00:00Z"),
    });

    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [unmatched],
    });

    const tuesday = schedule.find((n) => n.date === "2026-08-04");
    expect(tuesday?.capacity).toBe("FULL");
    expect(tuesday?.blocking_events).toEqual([]);
  });

  it("buckets an all-day event into only the single local calendar date it covers", () => {
    // All-day event for Tuesday Aug 4 only: local midnight Aug4 -> local
    // midnight Aug5, both CDT (no DST transition in play).
    const allDay = event({
      calendarName: "Family",
      title: "Out of town",
      allDay: true,
      start: new Date("2026-08-04T05:00:00Z"), // 00:00 CDT Tue Aug 4
      end: new Date("2026-08-05T05:00:00Z"), // 00:00 CDT Wed Aug 5
    });

    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [allDay],
    });

    const byDate = new Map(schedule.map((n) => [n.date, n]));
    expect(byDate.get("2026-08-03")?.capacity).toBe("FULL"); // Monday: untouched
    expect(byDate.get("2026-08-04")?.capacity).toBe("NONE"); // Tuesday: covered
    expect(byDate.get("2026-08-05")?.capacity).toBe("FULL"); // Wednesday: untouched
  });

  it("buckets an all-day event correctly across a DST fall-back boundary (2026-11-01, America/Chicago)", () => {
    // DST ends 2026-11-01 (clocks fall back 2am CDT -> 1am CST), making that
    // local calendar day 25 hours long. weekKey "2026-11-01" is itself a
    // Sunday, so night 0 == the transition day.
    // Local midnight Nov1 (CDT, -05:00) -> local midnight Nov2 (CST, -06:00).
    const allDayOnTransitionDay = event({
      calendarName: "Family",
      title: "DST day event",
      allDay: true,
      start: new Date("2026-11-01T05:00:00Z"), // 00:00 CDT Sun Nov 1
      end: new Date("2026-11-02T06:00:00Z"), // 00:00 CST Mon Nov 2
    });

    const schedule = assembleNightSchedule({
      weekKey: "2026-11-01",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [allDayOnTransitionDay],
    });

    const byDate = new Map(schedule.map((n) => [n.date, n]));
    expect(byDate.get("2026-11-01")?.date).toBe("2026-11-01");
    expect(byDate.get("2026-11-01")?.weekday).toBe("Sunday");
    expect(byDate.get("2026-11-01")?.capacity).toBe("NONE"); // transition day: covered
    expect(byDate.get("2026-11-02")?.weekday).toBe("Monday");
    expect(byDate.get("2026-11-02")?.capacity).toBe("FULL"); // day after: untouched
  });
});

// bd meal-planner-0v7.8: the compact, PII-free projection attached onto the
// plan/persisted as working_plan — date/weekday/capacity only, no
// blocking_events / raw calendar event titles.
describe("toNightCapacitySchedule", () => {
  it("projects date/weekday/capacity and drops blocking_events for every night", () => {
    const blockingEvent = event({ title: "Secret family therapy session" });
    const schedule = assembleNightSchedule({
      weekKey: "2026-08-02",
      timezone: TIMEZONE,
      calendarConfig: CALENDAR_CONFIG,
      events: [blockingEvent],
    });
    // Sanity: the full schedule DOES carry the event title somewhere.
    expect(JSON.stringify(schedule)).toContain("Secret family therapy session");

    const compact = toNightCapacitySchedule(schedule);

    expect(compact).toHaveLength(schedule.length);
    for (const [i, night] of compact.entries()) {
      expect(night).toEqual({
        date: schedule[i].date,
        weekday: schedule[i].weekday,
        capacity: schedule[i].capacity,
      });
      expect(night).not.toHaveProperty("blocking_events");
    }
    expect(JSON.stringify(compact)).not.toContain(
      "Secret family therapy session",
    );
  });
});
