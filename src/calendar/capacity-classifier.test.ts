import { describe, expect, it } from "vitest";
import type { CalendarConfig } from "../config/config.js";
import type { CalendarEvent } from "./calendar-reader.js";
import { classifyNightCapacity } from "./capacity-classifier.js";

/**
 * ADR-0004 D3 event→capacity classifier tests (bead r0o.3).
 *
 * All fixtures use `America/Chicago` (CDT, UTC-5 in August — no DST
 * transition in play) and the ADR's default cookingWindow (16:30-19:30
 * local), matching the fixture style of `orchestrator/week-key.test.ts`:
 * explicit UTC ISO `Date`s with a comment giving the local-time equivalent,
 * never a hand-rolled offset.
 *
 * Night: 2026-08-03 (a Monday). Local 16:30-19:30 CDT == 21:30Z-00:30Z(+1).
 */

const TIMEZONE = "America/Chicago";
const NIGHT_DATE = new Date("2026-08-03T12:00:00Z"); // 07:00 CDT, same local day

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
    start: new Date("2026-08-03T21:30:00Z"), // 16:30 CDT (window start)
    end: new Date("2026-08-03T22:30:00Z"), // 17:30 CDT
    allDay: false,
    status: "confirmed",
    ...overrides,
  };
}

function classify(
  events: CalendarEvent[],
): ReturnType<typeof classifyNightCapacity> {
  return classifyNightCapacity(NIGHT_DATE, TIMEZONE, CALENDAR_CONFIG, events);
}

describe("classifyNightCapacity", () => {
  it("returns FULL for an empty day (no events)", () => {
    expect(classify([])).toBe("FULL");
  });

  it("returns FULL when an event doesn't overlap the cooking window", () => {
    const outsideWindow = event({
      start: new Date("2026-08-03T12:00:00Z"), // 07:00 CDT
      end: new Date("2026-08-03T13:00:00Z"), // 08:00 CDT
    });
    expect(classify([outsideWindow])).toBe("FULL");
  });

  it("returns FULL for an event that touches the window boundary but doesn't overlap it", () => {
    // Ends exactly at window start (21:30Z) — half-open interval, no overlap.
    const touchesBoundary = event({
      start: new Date("2026-08-03T20:30:00Z"),
      end: new Date("2026-08-03T21:30:00Z"),
    });
    expect(classify([touchesBoundary])).toBe("FULL");
  });

  it("returns NONE when a cook-role event fully covers the window", () => {
    const fullyCovers = event({
      calendarName: "Jonathan",
      start: new Date("2026-08-03T20:00:00Z"), // 15:00 CDT
      end: new Date("2026-08-04T01:00:00Z"), // 20:00 CDT
    });
    expect(classify([fullyCovers])).toBe("NONE");
  });

  it("returns QUICK when a cook-role event only partially overlaps the window", () => {
    const partial = event({
      calendarName: "Jonathan",
      start: new Date("2026-08-03T20:00:00Z"), // 15:00 CDT
      end: new Date("2026-08-03T22:00:00Z"), // 17:00 CDT (window runs to 00:30Z)
    });
    expect(classify([partial])).toBe("QUICK");
  });

  it("returns NONE for an all-day event on a cook-role calendar", () => {
    const allDay = event({
      calendarName: "Family",
      allDay: true,
      start: new Date("2026-08-03T00:00:00Z"),
      end: new Date("2026-08-04T00:00:00Z"),
    });
    expect(classify([allDay])).toBe("NONE");
  });

  it("returns QUICK for a logistics-role event that partially overlaps the window", () => {
    const partial = event({
      calendarName: "Kids",
      start: new Date("2026-08-03T22:00:00Z"), // 17:00 CDT
      end: new Date("2026-08-03T22:30:00Z"), // 17:30 CDT
    });
    expect(classify([partial])).toBe("QUICK");
  });

  it("returns QUICK (never NONE) for a logistics-role event that fully covers the window", () => {
    // D3: "any logistics event overlapping the window pulls a cook" is
    // deterministic on presence, not degree — a logistics event never
    // escalates to NONE the way a cook event does.
    const fullyCovers = event({
      calendarName: "Kids",
      start: new Date("2026-08-03T20:00:00Z"), // 15:00 CDT
      end: new Date("2026-08-04T01:00:00Z"), // 20:00 CDT
    });
    expect(classify([fullyCovers])).toBe("QUICK");
  });

  it("returns QUICK (never NONE) for an all-day event on a logistics-role calendar", () => {
    const allDay = event({
      calendarName: "Kids",
      allDay: true,
      start: new Date("2026-08-03T00:00:00Z"),
      end: new Date("2026-08-04T00:00:00Z"),
    });
    expect(classify([allDay])).toBe("QUICK");
  });

  it("returns NONE when multiple events overlap and one cook event fully covers the window", () => {
    const partialLogistics = event({
      calendarName: "Kids",
      start: new Date("2026-08-03T22:00:00Z"),
      end: new Date("2026-08-03T22:30:00Z"),
    });
    const fullyCoveringCook = event({
      calendarName: "Family",
      start: new Date("2026-08-03T20:00:00Z"),
      end: new Date("2026-08-04T01:00:00Z"),
    });
    expect(classify([partialLogistics, fullyCoveringCook])).toBe("NONE");
  });

  it("returns QUICK (not NONE) when a partial cook overlap and a logistics overlap combine, with no single fully-covering event", () => {
    const partialCook = event({
      calendarName: "Jonathan",
      start: new Date("2026-08-03T20:00:00Z"), // 15:00 CDT
      end: new Date("2026-08-03T22:00:00Z"), // 17:00 CDT
    });
    const partialLogistics = event({
      calendarName: "Kids",
      start: new Date("2026-08-03T23:00:00Z"), // 18:00 CDT
      end: new Date("2026-08-03T23:30:00Z"), // 18:30 CDT
    });
    expect(classify([partialCook, partialLogistics])).toBe("QUICK");
  });

  it("ignores a canceled event (bead 7o5) even if it would otherwise fully block the window", () => {
    const canceled = event({
      calendarName: "Jonathan",
      status: "canceled",
      start: new Date("2026-08-03T20:00:00Z"),
      end: new Date("2026-08-04T01:00:00Z"),
    });
    expect(classify([canceled])).toBe("FULL");
  });

  it("counts a tentative event toward capacity reduction (bead 7o5)", () => {
    const tentative = event({
      calendarName: "Jonathan",
      status: "tentative",
      start: new Date("2026-08-03T20:00:00Z"),
      end: new Date("2026-08-04T01:00:00Z"),
    });
    expect(classify([tentative])).toBe("NONE");
  });

  it("ignores an event on a calendar not in CalendarConfig.include[] (D2 allow-list)", () => {
    const unmatched = event({
      calendarName: "US Holidays",
      start: new Date("2026-08-03T20:00:00Z"),
      end: new Date("2026-08-04T01:00:00Z"),
    });
    expect(classify([unmatched])).toBe("FULL");
  });

  it("returns NONE when any one of multiple cook-role calendars fully covers the window, regardless of the others", () => {
    const jonathanBusyElsewhere = event({
      calendarName: "Jonathan",
      start: new Date("2026-08-03T12:00:00Z"), // 07:00 CDT, outside window
      end: new Date("2026-08-03T13:00:00Z"),
    });
    const familyFullyCovers = event({
      calendarName: "Family",
      start: new Date("2026-08-03T20:00:00Z"),
      end: new Date("2026-08-04T01:00:00Z"),
    });
    expect(classify([jonathanBusyElsewhere, familyFullyCovers])).toBe("NONE");
  });
});
