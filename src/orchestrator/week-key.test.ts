import { describe, expect, it } from "vitest";
import {
  currentPlanWeek,
  isActiveWeek,
  previousPlanWeek,
  triggerMoment,
  type WeekKeyConfig,
} from "./week-key.js";

/**
 * ADR 0002 week_key computation tests.
 *
 * All fixed `now` values below are injected as explicit `Date`s (UTC ISO
 * strings) — never `Date.now()` / argless `new Date()` — so the tests are
 * fully deterministic. The pinned config uses `America/Chicago` (a real
 * DST-observing zone) + `triggerTime: "06:00"` throughout, matching the
 * scheduler's own DST test fixtures (real 2026 dates).
 */

const cfg: WeekKeyConfig = {
  timezone: "America/Chicago",
  triggerTime: "06:00",
};

describe("currentPlanWeek", () => {
  it("keys to that Sunday when now is Sunday AFTER the trigger", () => {
    // 2026-07-12 is a Sunday; 13:00Z = 08:00 America/Chicago (CDT), after 06:00 trigger.
    const now = new Date("2026-07-12T13:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-07-12");
  });

  it("keys to the PREVIOUS Sunday when now is Sunday BEFORE the trigger", () => {
    // 2026-07-12 10:00Z = 05:00 America/Chicago (CDT), before the 06:00 trigger:
    // this week's plan has not yet been generated, so last week is still active.
    const now = new Date("2026-07-12T10:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-07-05");
  });

  it("keys to the most recent Sunday when now is mid-week", () => {
    // 2026-07-08 is a Wednesday.
    const now = new Date("2026-07-08T18:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-07-05");
  });

  it("is DST-correct across the US spring-forward transition (2026-03-08), before the trigger", () => {
    // 2026-03-08 10:00Z = 05:00 America/Chicago (CDT, already sprung forward),
    // before the 06:00 trigger -> previous week's key still active.
    const now = new Date("2026-03-08T10:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-03-01");
  });

  it("is DST-correct across the US spring-forward transition (2026-03-08), after the trigger", () => {
    // 2026-03-08 12:00Z = 07:00 America/Chicago (CDT), after the 06:00 trigger.
    const now = new Date("2026-03-08T12:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-03-08");
  });

  it("is DST-correct mid-week after the spring-forward Sunday", () => {
    // 2026-03-10 is the Tuesday following the 2026-03-08 spring-forward Sunday.
    const now = new Date("2026-03-10T12:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-03-08");
  });

  it("is DST-correct across the US fall-back transition (2026-11-01), before the trigger", () => {
    // 2026-11-01 11:00Z = 05:00 America/Chicago (CST, already fallen back),
    // before the 06:00 trigger -> previous week's key still active.
    const now = new Date("2026-11-01T11:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-10-25");
  });

  it("is DST-correct across the US fall-back transition (2026-11-01), after the trigger", () => {
    // 2026-11-01 13:00Z = 07:00 America/Chicago (CST), after the 06:00 trigger.
    const now = new Date("2026-11-01T13:00:00Z");
    expect(currentPlanWeek(now, cfg)).toBe("2026-11-01");
  });
});

describe("previousPlanWeek", () => {
  it("returns the Sunday 7 days before the given week_key", () => {
    expect(previousPlanWeek("2026-07-12")).toBe("2026-07-05");
  });

  it("is correct across a month boundary", () => {
    expect(previousPlanWeek("2026-03-01")).toBe("2026-02-22");
  });

  it("is correct across a year boundary", () => {
    expect(previousPlanWeek("2026-01-04")).toBe("2025-12-28");
  });

  it("is correct across the spring-forward DST transition", () => {
    expect(previousPlanWeek("2026-03-08")).toBe("2026-03-01");
  });

  it("is correct across the fall-back DST transition", () => {
    expect(previousPlanWeek("2026-11-01")).toBe("2026-10-25");
  });
});

describe("triggerMoment", () => {
  it("returns the correct absolute instant in standard time (CST, UTC-6)", () => {
    // 2026-11-01 06:00 America/Chicago is CST (UTC-6) -> 12:00Z.
    expect(triggerMoment("2026-11-01", cfg).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
  });

  it("returns the correct absolute instant in daylight time (CDT, UTC-5)", () => {
    // 2026-03-08 06:00 America/Chicago is CDT (UTC-5) -> 11:00Z.
    expect(triggerMoment("2026-03-08", cfg).toISOString()).toBe(
      "2026-03-08T11:00:00.000Z",
    );
  });
});

describe("isActiveWeek", () => {
  it("is true when wk equals currentPlanWeek(now, cfg)", () => {
    const now = new Date("2026-07-12T13:00:00Z");
    expect(isActiveWeek("2026-07-12", now, cfg)).toBe(true);
  });

  it("is false for a prior week_key", () => {
    const now = new Date("2026-07-12T13:00:00Z");
    expect(isActiveWeek("2026-07-05", now, cfg)).toBe(false);
  });
});
