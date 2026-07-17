/**
 * Derives the current meteorological season from a wall-clock instant,
 * interpreted in the configured IANA timezone (bd meal-planner-8zs.9).
 *
 * v1.0 seasonality is TAG-based and DERIVED, not configured: the daemon reads
 * "what season is it now?" from the clock and feeds it to the planner, which
 * uses it as a hard filter (drop recipes explicitly tagged for OTHER seasons)
 * plus a soft prompt bias (prefer in-season). Live weather (Open-Meteo) is the
 * separate v2.0 signal — this is only the calendar season.
 *
 * Meteorological (month-based) boundaries, Northern Hemisphere: only the
 * MONTH-in-zone matters, so this is a pure lookup with no day/solstice math.
 */
export type Season = "spring" | "summer" | "fall" | "winter";

/** month (1-12) -> season, meteorological Northern-Hemisphere mapping. */
const SEASON_BY_MONTH: Record<number, Season> = {
  1: "winter",
  2: "winter",
  3: "spring",
  4: "spring",
  5: "spring",
  6: "summer",
  7: "summer",
  8: "summer",
  9: "fall",
  10: "fall",
  11: "fall",
  12: "winter",
};

/**
 * Returns the season for `date` as observed in `timezone` (an IANA zone such
 * as "America/Chicago"). The month is read IN THE ZONE — an instant that is
 * late August in Chicago but already September in UTC maps to summer, not fall
 * — so the household's local calendar, not the server's UTC offset, decides.
 */
export function seasonForDate(date: Date, timezone: string): Season {
  const month = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "numeric",
    }).format(date),
  );
  return SEASON_BY_MONTH[month];
}
