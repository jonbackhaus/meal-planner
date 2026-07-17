import { describe, expect, it } from "vitest";
import { type Season, seasonForDate } from "./season.js";

/**
 * `seasonForDate` maps a wall-clock instant, interpreted IN the configured
 * IANA timezone, to one of the four meteorological seasons (Northern
 * Hemisphere): spring=Mar-May, summer=Jun-Aug, fall=Sep-Nov, winter=Dec-Feb.
 * Only the MONTH-in-zone matters; the day and time don't (until v2.0 weather).
 */
describe("seasonForDate", () => {
  // Day-15-at-noon-UTC is far from any month boundary, so under a fixed UTC
  // zone the mapped month is unambiguous.
  const cases: Array<[string, Season]> = [
    ["2026-01-15T12:00:00Z", "winter"],
    ["2026-02-15T12:00:00Z", "winter"],
    ["2026-03-15T12:00:00Z", "spring"],
    ["2026-04-15T12:00:00Z", "spring"],
    ["2026-05-15T12:00:00Z", "spring"],
    ["2026-06-15T12:00:00Z", "summer"],
    ["2026-07-15T12:00:00Z", "summer"],
    ["2026-08-15T12:00:00Z", "summer"],
    ["2026-09-15T12:00:00Z", "fall"],
    ["2026-10-15T12:00:00Z", "fall"],
    ["2026-11-15T12:00:00Z", "fall"],
    ["2026-12-15T12:00:00Z", "winter"],
  ];

  for (const [iso, expected] of cases) {
    it(`maps ${iso} (UTC) -> ${expected}`, () => {
      expect(seasonForDate(new Date(iso), "UTC")).toBe(expected);
    });
  }

  it("uses the month IN the configured zone, not UTC (season-boundary instant)", () => {
    // 2026-09-01T04:00Z is still Aug 31 (23:00, CDT = UTC-5) in Chicago ->
    // August -> summer; in UTC it is September -> fall. The zone must win.
    const instant = new Date("2026-09-01T04:00:00Z");
    expect(seasonForDate(instant, "America/Chicago")).toBe("summer");
    expect(seasonForDate(instant, "UTC")).toBe("fall");
  });

  it("handles the Dec 31 / Jan 1 year boundary in-zone (still winter either side)", () => {
    // 2027-01-01T04:00Z = 2026-12-31 22:00 in Chicago -> December -> winter.
    const instant = new Date("2027-01-01T04:00:00Z");
    expect(seasonForDate(instant, "America/Chicago")).toBe("winter");
  });

  it("is unaffected by DST (a spring-forward day still maps by month)", () => {
    // 2026-03-08 is the US DST spring-forward date; March -> spring regardless.
    expect(
      seasonForDate(new Date("2026-03-08T12:00:00Z"), "America/Chicago"),
    ).toBe("spring");
  });
});
