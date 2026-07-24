import { describe, expect, it, vi } from "vitest";
import type { Night, NightSchedule } from "../calendar/night-schedule.js";
import { getWeekNightSchedule } from "../calendar/week-night-schedule.js";
import type { CalendarConfig, CookNights } from "../config/config.js";
import type { WeekKey } from "../orchestrator/week-key.js";
import { deriveCookNightCount, deriveSlots } from "./derive-slots.js";

/**
 * ADR-0004 D4 — `deriveSlots`/`deriveCookNightCount` unit tests (bead r0o.5).
 */

function night(overrides: Partial<Night>): Night {
  return {
    date: "2026-08-03",
    weekday: "Monday",
    capacity: "FULL",
    blocking_events: [],
    ...overrides,
  };
}

const TIMEZONE = "America/Chicago";
const WEEK_KEY: WeekKey = "2026-08-02";
const CALENDAR_CONFIG: CalendarConfig = {
  enabled: false,
  include: [],
  cookingWindow: { start: "16:30", end: "19:30" },
};

/**
 * Fetches the real ADR-0004 D6 static-fallback `NightSchedule` (via the
 * unmodified, already-tested `getWeekNightSchedule`, `calendar.enabled:
 * false`) rather than reimplementing/duplicating it here — this is the exact
 * schedule shape `deriveSlots` must reproduce `cookNights` counts from.
 */
async function staticFallbackSchedule(
  cookNights: CookNights,
): Promise<NightSchedule> {
  return getWeekNightSchedule({
    weekKey: WEEK_KEY,
    config: { timezone: TIMEZONE, calendar: CALENDAR_CONFIG, cookNights },
    readEvents: vi.fn(async () => []),
    alert: vi.fn(async () => {}),
    logger: { warn: vi.fn(), error: vi.fn() },
  });
}

describe("deriveSlots", () => {
  it("counts non-NONE weeknights as constrained and non-NONE weekend nights as relaxed", () => {
    const schedule: NightSchedule = [
      night({ date: "2026-08-02", weekday: "Sunday", capacity: "FULL" }), // relaxed
      night({ date: "2026-08-03", weekday: "Monday", capacity: "FULL" }), // constrained
      night({ date: "2026-08-04", weekday: "Tuesday", capacity: "QUICK" }), // constrained
      night({ date: "2026-08-05", weekday: "Wednesday", capacity: "NONE" }), // none
      night({ date: "2026-08-06", weekday: "Thursday", capacity: "FULL" }), // constrained
      night({ date: "2026-08-07", weekday: "Friday", capacity: "NONE" }), // none
      night({ date: "2026-08-08", weekday: "Saturday", capacity: "QUICK" }), // relaxed
    ];

    expect(deriveSlots(schedule)).toEqual({ constrained: 3, relaxed: 2 });
  });

  it("QUICK counts identically to FULL for slot counting (capacity and weekday slot-type are orthogonal axes, D4)", () => {
    const allFullWeeknight: NightSchedule = [
      night({ weekday: "Monday", capacity: "FULL" }),
    ];
    const allQuickWeeknight: NightSchedule = [
      night({ weekday: "Monday", capacity: "QUICK" }),
    ];

    expect(deriveSlots(allFullWeeknight)).toEqual(
      deriveSlots(allQuickWeeknight),
    );
  });

  it("NONE nights contribute to neither count", () => {
    const schedule: NightSchedule = [
      night({ weekday: "Monday", capacity: "NONE" }),
      night({ weekday: "Saturday", capacity: "NONE" }),
    ];

    expect(deriveSlots(schedule)).toEqual({ constrained: 0, relaxed: 0 });
  });

  it("an empty schedule yields zero slots", () => {
    expect(deriveSlots([])).toEqual({ constrained: 0, relaxed: 0 });
  });

  it("reproduces the exact static v1.0 cookNights counts over the static-fallback schedule (ADR-0004 D6 equivalence)", async () => {
    const cookNights: CookNights = { constrained: 4, relaxed: 2 };
    const fallbackSchedule = await staticFallbackSchedule(cookNights);

    expect(deriveSlots(fallbackSchedule)).toEqual({
      constrained: cookNights.constrained,
      relaxed: cookNights.relaxed,
    });
  });

  it("reproduces a short static-fallback schedule (fewer weeknights than the offsets available) exactly", async () => {
    const cookNights: CookNights = { constrained: 3, relaxed: 2 };
    const fallbackSchedule = await staticFallbackSchedule(cookNights);

    expect(fallbackSchedule).toHaveLength(5);
    expect(deriveSlots(fallbackSchedule)).toEqual({
      constrained: 3,
      relaxed: 2,
    });
  });
});

describe("deriveCookNightCount", () => {
  it("sums constrained + relaxed", () => {
    expect(deriveCookNightCount({ constrained: 4, relaxed: 2 })).toBe(6);
    expect(deriveCookNightCount({ constrained: 0, relaxed: 0 })).toBe(0);
  });
});
