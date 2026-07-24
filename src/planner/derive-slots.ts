import type { NightSchedule } from "../calendar/night-schedule.js";

/**
 * Derives `PlannerInput.slots` from a `NightSchedule` (ADR-0004 D4, bead
 * r0o.5). `ADR-0003`'s `slots = {constrained, relaxed}` stops being static
 * `cookNights` config: the orchestrator instead counts non-`NONE` nights per
 * weekday-type from the week's `NightSchedule`.
 *
 * **Rule (D4, literal):** non-`NONE` weeknights (Mon-Fri) -> `constrained`;
 * non-`NONE` weekend nights (Sat/Sun) -> `relaxed`. `NONE` contributes to
 * neither. `QUICK` counts exactly like `FULL` here — capacity and base
 * weekday slot-type are orthogonal axes (D4): weekday alone decides
 * constrained-vs-relaxed, while `QUICK` separately tightens THAT night's
 * selection gate (`quickActiveMax` / make-ahead) rather than changing which
 * count it lands in. Applying that per-night gate to selection is a later
 * concern (v1.0/v2.0 selection is slot-typed and unordered, not per-night —
 * see the delivering task's FOLLOW-UPS) — this function only counts.
 *
 * **Static-fallback equivalence (ADR-0004 D6):** `getWeekNightSchedule`'s
 * degrade path returns a schedule sized to EXACTLY `cookNights.constrained`
 * weeknight + `cookNights.relaxed` weekend nights, all `FULL` (bead r0o.6) —
 * counting non-`NONE` nights per weekday-type over that short schedule
 * recovers the original static counts exactly, so this same pure function
 * works unchanged for both a real 7-night schedule and the static fallback.
 */

export interface Slots {
  constrained: number;
  relaxed: number;
}

/** Full local weekday names (`Night.weekday`, e.g. `"Saturday"`) treated as weekend. */
const WEEKEND_WEEKDAYS = new Set(["Saturday", "Sunday"]);

/**
 * Counts `schedule`'s non-`NONE` nights into `{constrained, relaxed}` by
 * weekday type (ADR-0004 D4). Pure — no calendar/clock access.
 */
export function deriveSlots(schedule: NightSchedule): Slots {
  let constrained = 0;
  let relaxed = 0;

  for (const night of schedule) {
    if (night.capacity === "NONE") {
      continue;
    }
    if (WEEKEND_WEEKDAYS.has(night.weekday)) {
      relaxed++;
    } else {
      constrained++;
    }
  }

  return { constrained, relaxed };
}

/**
 * `cook_night_count = #(FULL)+#(QUICK) = constrained + relaxed` (ADR-0004
 * D4) — every non-`NONE` night counted in `slots` is a cook night, so this
 * is just the sum.
 */
export function deriveCookNightCount(slots: Slots): number {
  return slots.constrained + slots.relaxed;
}
