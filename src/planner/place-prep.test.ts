import { describe, expect, it } from "vitest";
import type { Night, NightSchedule } from "../calendar/night-schedule.js";
import { placePrepUnits } from "./place-prep.js";
import type { SelectedMeal } from "./select.js";

/**
 * ADR-0004 D5 — `placePrepUnits` unit tests (bd meal-planner-468.2).
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

function meal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
  return {
    slot_type: "constrained",
    recipe_id: "r1",
    title: "Braised Short Ribs",
    day: null,
    veg: { kind: "inherent" },
    flags: [],
    rationale: "make-ahead",
    ...overrides,
  };
}

// A full Sun (08-02) .. Sat (08-08) schedule, all FULL by default, that
// individual tests override nights on.
function fullWeekSchedule(
  overrides: Partial<Record<string, Partial<Night>>> = {},
): NightSchedule {
  const base: Night[] = [
    night({ date: "2026-08-02", weekday: "Sunday" }),
    night({ date: "2026-08-03", weekday: "Monday" }),
    night({ date: "2026-08-04", weekday: "Tuesday" }),
    night({ date: "2026-08-05", weekday: "Wednesday" }),
    night({ date: "2026-08-06", weekday: "Thursday" }),
    night({ date: "2026-08-07", weekday: "Friday" }),
    night({ date: "2026-08-08", weekday: "Saturday" }),
  ];
  return base.map((n) => ({ ...n, ...overrides[n.date] }));
}

describe("placePrepUnits", () => {
  it("places a do-ahead meal onto the earliest NONE night before its serve date", () => {
    const schedule = fullWeekSchedule({
      "2026-08-03": { capacity: "NONE" }, // Monday: leftover night
    });
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Chili",
        day: "2026-08-05", // Wednesday
        flags: ["do-ahead"],
      }),
    ];

    const units = placePrepUnits(meals, schedule);

    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({
      description: "Prep: Chili",
      serve_date: "2026-08-05",
      prep_date: "2026-08-03",
    });
  });

  it("falls back to the weekend when no earlier NONE night exists", () => {
    // Sunday (08-02, weekend) and Monday (08-03) both FULL; no NONE night.
    const schedule = fullWeekSchedule();
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Lasagna",
        day: "2026-08-05", // Wednesday
        flags: ["do-ahead"],
      }),
    ];

    const units = placePrepUnits(meals, schedule);

    expect(units[0].prep_date).toBe("2026-08-02"); // Sunday, the weekend night
  });

  it("falls back to the earliest FULL night before serve when there's no NONE night and no weekend night before serve", () => {
    // Serve on Tuesday (08-04): the only earlier nights are Sun (weekend) and
    // Mon. Drop the weekend candidate by starting the schedule at Monday so
    // there is no earlier weekend night at all.
    const schedule: NightSchedule = [
      night({ date: "2026-08-03", weekday: "Monday", capacity: "FULL" }),
      night({ date: "2026-08-04", weekday: "Tuesday", capacity: "FULL" }),
      night({ date: "2026-08-05", weekday: "Wednesday", capacity: "FULL" }),
    ];
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Stew",
        day: "2026-08-05", // Wednesday
        flags: ["do-ahead"],
      }),
    ];

    const units = placePrepUnits(meals, schedule);

    // Earliest FULL night strictly before serve, among Mon/Tue (neither NONE
    // nor weekend) -> Monday.
    expect(units[0].prep_date).toBe("2026-08-03");
  });

  it("falls back to the earliest QUICK night when no NONE/weekend/FULL night is available earlier", () => {
    const schedule: NightSchedule = [
      night({ date: "2026-08-03", weekday: "Monday", capacity: "QUICK" }),
      night({ date: "2026-08-04", weekday: "Tuesday", capacity: "QUICK" }),
      night({ date: "2026-08-05", weekday: "Wednesday", capacity: "FULL" }),
    ];
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Soup",
        day: "2026-08-05", // Wednesday
        flags: ["do-ahead"],
      }),
    ];

    const units = placePrepUnits(meals, schedule);

    expect(units[0].prep_date).toBe("2026-08-03"); // earliest QUICK
  });

  it("leaves prep_date null when no earlier suitable night exists", () => {
    const schedule: NightSchedule = [
      night({ date: "2026-08-03", weekday: "Monday", capacity: "FULL" }),
    ];
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Only Night",
        day: "2026-08-03", // the schedule's earliest (only) night
        flags: ["do-ahead"],
      }),
    ];

    const units = placePrepUnits(meals, schedule);

    expect(units).toHaveLength(1);
    expect(units[0].prep_date).toBeNull();
  });

  it("produces no prep unit for a non-do-ahead meal", () => {
    const schedule = fullWeekSchedule({ "2026-08-03": { capacity: "NONE" } });
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Weeknight Pasta",
        day: "2026-08-05",
        flags: [],
      }),
    ];

    expect(placePrepUnits(meals, schedule)).toEqual([]);
  });

  it("produces no prep unit for a do-ahead meal with no assigned day (no calendar / ADR-0004 D6 degraded path)", () => {
    const schedule = fullWeekSchedule({ "2026-08-03": { capacity: "NONE" } });
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Degraded Path Chili",
        day: null,
        flags: ["do-ahead"],
      }),
    ];

    expect(placePrepUnits(meals, schedule)).toEqual([]);
  });

  it("always places a prep_date strictly before its serve_date (validate.ts rule 5)", () => {
    const schedule = fullWeekSchedule({ "2026-08-06": { capacity: "NONE" } });
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Curry",
        day: "2026-08-07", // Friday
        flags: ["do-ahead"],
      }),
    ];

    const units = placePrepUnits(meals, schedule);

    expect(units[0].prep_date).not.toBeNull();
    expect((units[0].prep_date as string) < units[0].serve_date).toBe(true);
  });

  it("places one prep unit per do-ahead meal, independently, across multiple meals", () => {
    const schedule = fullWeekSchedule({
      "2026-08-03": { capacity: "NONE" },
      "2026-08-06": { capacity: "NONE" },
    });
    const meals = [
      meal({
        recipe_id: "r1",
        title: "Chili",
        day: "2026-08-05", // Wednesday -> prep Monday (NONE)
        flags: ["do-ahead"],
      }),
      meal({
        recipe_id: "r2",
        title: "Weeknight Pasta",
        day: "2026-08-04", // Tuesday, not do-ahead
        flags: [],
      }),
      meal({
        recipe_id: "r3",
        title: "Braise",
        // Saturday -> the earliest NONE night before it is still Monday
        // (08-03), since NONE-night preference picks the earliest match,
        // not the closest-to-serve one.
        day: "2026-08-08",
        flags: ["do-ahead"],
      }),
    ];

    const units = placePrepUnits(meals, schedule);

    expect(units).toHaveLength(2);
    expect(units[0]).toEqual({
      description: "Prep: Chili",
      serve_date: "2026-08-05",
      prep_date: "2026-08-03",
    });
    expect(units[1]).toEqual({
      description: "Prep: Braise",
      serve_date: "2026-08-08",
      prep_date: "2026-08-03",
    });
  });
});
