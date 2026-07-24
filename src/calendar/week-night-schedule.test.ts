import { describe, expect, it, vi } from "vitest";
import type { CalendarConfig, CookNights } from "../config/config.js";
import type {
  CalendarEvent,
  CalendarReaderOptions,
} from "./calendar-reader.js";
import {
  type GetWeekNightScheduleDeps,
  getWeekNightSchedule,
  type WeekNightScheduleConfig,
} from "./week-night-schedule.js";

/**
 * ADR-0004 D6 degrade-to-static + alert-once tests (bead r0o.6).
 *
 * Standalone provider tests: `readEvents`/`alert` are injected mocks, never a
 * live calendar/Slack. `weekKey` "2026-08-02" is the same anchor Sunday used
 * by `night-schedule.test.ts`'s fixtures (Aug 2 Sun .. Aug 8 Sat), so the
 * live-read path's expected dates line up with that module's own coverage.
 */

const TIMEZONE = "America/Chicago";
const WEEK_KEY = "2026-08-02";

const CALENDAR_CONFIG: CalendarConfig = {
  enabled: true,
  include: [
    { name: "Jonathan", role: "cook" },
    { name: "Family", role: "cook" },
    { name: "Kids", role: "logistics" },
  ],
  cookingWindow: { start: "16:30", end: "19:30" },
};

const COOK_NIGHTS: CookNights = { constrained: 4, relaxed: 2 };

function baseConfig(
  overrides: Partial<WeekNightScheduleConfig> = {},
): WeekNightScheduleConfig {
  return {
    timezone: TIMEZONE,
    calendar: CALENDAR_CONFIG,
    cookNights: COOK_NIGHTS,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GetWeekNightScheduleDeps> = {}) {
  const readEvents =
    overrides.readEvents ??
    vi.fn(
      async (_options: CalendarReaderOptions): Promise<CalendarEvent[]> => [],
    );
  const alert = overrides.alert ?? vi.fn(async (_message: string) => {});
  return {
    weekKey: WEEK_KEY,
    config: baseConfig(),
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
    readEvents,
    alert,
  };
}

describe("getWeekNightSchedule", () => {
  it("enabled + successful read: returns the real assembled schedule, never alerts", async () => {
    const event: CalendarEvent = {
      calendarName: "Jonathan",
      title: "Fully blocks Tuesday",
      start: new Date("2026-08-04T20:00:00Z"), // 15:00 CDT Tue
      end: new Date("2026-08-05T01:00:00Z"), // 20:00 CDT Tue
      allDay: false,
      status: "confirmed",
    };
    const readEvents = vi.fn(
      async (_options: CalendarReaderOptions): Promise<CalendarEvent[]> => [
        event,
      ],
    );
    const alert = vi.fn(async (_message: string) => {});
    const deps = makeDeps({ readEvents, alert });

    const schedule = await getWeekNightSchedule(deps);

    expect(schedule).toHaveLength(7);
    expect(schedule.map((n) => n.date)).toEqual([
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
    const tuesday = schedule.find((n) => n.date === "2026-08-04");
    expect(tuesday?.capacity).toBe("NONE");
    expect(tuesday?.blocking_events).toHaveLength(1);
    expect(alert).not.toHaveBeenCalled();

    // Passed the plan week's [start, end) range through to readEvents.
    expect(readEvents).toHaveBeenCalledTimes(1);
    const range = readEvents.mock.calls[0]?.[0] as CalendarReaderOptions;
    expect(range.start.toISOString()).toBe("2026-08-02T05:00:00.000Z"); // 2026-08-02 00:00 CDT
    expect(range.end.toISOString()).toBe("2026-08-09T05:00:00.000Z"); // 2026-08-09 00:00 CDT
  });

  it("a genuinely free week (successful read, zero events): returns a real all-FULL 7-night schedule, never alerts", async () => {
    const alert = vi.fn(async () => {});
    const deps = makeDeps({ readEvents: vi.fn(async () => []), alert });

    const schedule = await getWeekNightSchedule(deps);

    expect(schedule).toHaveLength(7);
    for (const night of schedule) {
      expect(night.capacity).toBe("FULL");
      expect(night.blocking_events).toEqual([]);
    }
    expect(alert).not.toHaveBeenCalled();
  });

  it("calendar.enabled=false: returns the static fallback schedule and alerts once", async () => {
    const readEvents = vi.fn(async () => []);
    const alert = vi.fn(async () => {});
    const deps = makeDeps({
      config: baseConfig({
        calendar: { ...CALENDAR_CONFIG, enabled: false },
      }),
      readEvents,
      alert,
    });

    const schedule = await getWeekNightSchedule(deps);

    // 4 weeknights + 2 weekend nights (COOK_NIGHTS), all FULL, no events.
    expect(schedule).toHaveLength(6);
    for (const night of schedule) {
      expect(night.capacity).toBe("FULL");
      expect(night.blocking_events).toEqual([]);
    }
    // Never attempted a live read while disabled.
    expect(readEvents).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining("calendar.enabled is false"),
    );
    expect(alert).toHaveBeenCalledWith(expect.stringContaining(WEEK_KEY));
  });

  it("readEvents throws (TCC denied / timeout / any read failure): returns the static fallback and alerts once", async () => {
    const alert = vi.fn(async () => {});
    const deps = makeDeps({
      readEvents: vi.fn(async () => {
        throw new Error(
          "calendar-reader: reading Calendar.app events timed out",
        );
      }),
      alert,
    });

    const schedule = await getWeekNightSchedule(deps);

    expect(schedule).toHaveLength(6);
    for (const night of schedule) {
      expect(night.capacity).toBe("FULL");
      expect(night.blocking_events).toEqual([]);
    }
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining("calendar read failed"),
    );
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("never throws even when the alert itself fails, and still returns the static fallback", async () => {
    const alert = vi.fn(async () => {
      throw new Error("Slack unreachable");
    });
    const errorLog = vi.fn();
    const deps = makeDeps({
      config: baseConfig({
        calendar: { ...CALENDAR_CONFIG, enabled: false },
      }),
      alert,
      logger: { warn: vi.fn(), error: errorLog },
    });

    const schedule = await getWeekNightSchedule(deps);

    expect(schedule).toHaveLength(6);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("alert failed"),
    );
  });

  it("static fallback sizes to cookNights (e.g. 3 weeknight + 2 weekend) and never fabricates more nights than available", async () => {
    const deps = makeDeps({
      config: baseConfig({
        calendar: { ...CALENDAR_CONFIG, enabled: false },
        cookNights: { constrained: 3, relaxed: 2 },
      }),
    });

    const schedule = await getWeekNightSchedule(deps);

    expect(schedule).toHaveLength(5);
    // Weeknights first (Mon-Wed), then weekend (Sun, Sat) per the anchor week.
    expect(schedule.map((n) => n.weekday)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Sunday",
      "Saturday",
    ]);
  });
});
