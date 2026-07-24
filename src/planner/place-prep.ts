import type { NightSchedule } from "../calendar/night-schedule.js";
import type { PrepUnit, SelectedMeal } from "./select.js";

/**
 * Deterministic prep-unit placement (ADR-0004 D5, bd meal-planner-468.2).
 *
 * ADR-0003 D5's general hybrid principle is "the LLM decides; the code
 * guarantees" — but D5 for prep scheduling explicitly chooses a
 * DETERMINISTIC placement heuristic ("testable and sufficient"), not an LLM
 * call: this module is pure and makes no LLM/network call of its own.
 *
 * For every selected meal flagged `"do-ahead"` (the same signal
 * `validate.ts` rule 3 uses, `meal.flags.includes("do-ahead")`) with a
 * non-null assigned `day`, produces ONE `PrepUnit` whose `serve_date` is
 * that meal's `day` and whose `prep_date` is the earliest suitable EARLIER
 * night in `schedule`, chosen by this exact preference order (D5):
 *
 *   1. the earliest NONE ("leftover") night before `serve_date`;
 *   2. else the earliest weekend (Sat/Sun) night before `serve_date`,
 *      regardless of its own capacity (a weekend night not caught by (1) is
 *      still FULL or QUICK, not NONE — either is fine for prep work);
 *   3. else the earliest FULL night before `serve_date`;
 *   4. else — D5 is silent on QUICK as a prep target; ranked here as the
 *      last-resort tier (bd meal-planner-468.2 interpretation) — the
 *      earliest QUICK night before `serve_date`;
 *   5. else `null` (no earlier suitable night — e.g. the meal is already on
 *      the week's earliest night). `validate.ts` rule 5 tolerates a null
 *      `prep_date` (unplaced), so this never fabricates an invalid ordering.
 *
 * `schedule` is assumed already chronologically ordered (Sunday..Saturday,
 * `assembleNightSchedule`'s own construction order) — each tier's `.find`
 * therefore naturally returns the EARLIEST match without a separate sort.
 *
 * A do-ahead meal with `day === null` (no calendar / ADR-0004 D6 degraded
 * path, or any pre-calendar caller) produces NO `PrepUnit`: `PrepUnit.
 * serve_date` is a required, non-null ISO string (`PrepUnitSchema`), so
 * there is no valid `serve_date` to place relative to. This is a deliberate
 * scope boundary, not an oversight — see bd meal-planner-468.2's follow-up
 * note.
 */

/** Full local weekday names (`Night.weekday`) treated as weekend — mirrors
 * `derive-slots.ts`'s and `validate.ts`'s own private sets, duplicated here
 * per the same convention rather than exporting a two-string constant. */
const WEEKEND_WEEKDAYS = new Set(["Saturday", "Sunday"]);

function choosePrepDate(earlierNights: NightSchedule): string | null {
  const noneNight = earlierNights.find((night) => night.capacity === "NONE");
  if (noneNight) {
    return noneNight.date;
  }

  const weekendNight = earlierNights.find((night) =>
    WEEKEND_WEEKDAYS.has(night.weekday),
  );
  if (weekendNight) {
    return weekendNight.date;
  }

  const fullNight = earlierNights.find((night) => night.capacity === "FULL");
  if (fullNight) {
    return fullNight.date;
  }

  const quickNight = earlierNights.find((night) => night.capacity === "QUICK");
  if (quickNight) {
    return quickNight.date;
  }

  return null;
}

/**
 * Builds one `PrepUnit`'s `description` from the meal's `title`. D5 doesn't
 * specify a description source; this is a minimal, sensible baseline
 * (bd meal-planner-468.2 interpretation, flagged as a follow-up) — a richer
 * per-recipe prep breakdown is a possible later refinement, not this task's
 * scope.
 */
function describePrep(meal: SelectedMeal): string {
  return `Prep: ${meal.title}`;
}

/**
 * Places a `PrepUnit` for every do-ahead, day-assigned selected meal (see
 * module doc for the full ordering + edge-case contract). Pure: takes the
 * validated `meals` and the week's `NightSchedule`, returns the placed
 * `PrepUnit[]` — the caller (`build-plan.ts`) attaches it to `WeekPlan.prep`.
 */
export function placePrepUnits(
  meals: SelectedMeal[],
  schedule: NightSchedule,
): PrepUnit[] {
  const units: PrepUnit[] = [];

  for (const meal of meals) {
    if (!meal.flags.includes("do-ahead") || meal.day === null) {
      continue;
    }

    const serveDate = meal.day;
    const earlierNights = schedule.filter((night) => night.date < serveDate);

    units.push({
      description: describePrep(meal),
      serve_date: serveDate,
      prep_date: choosePrepDate(earlierNights),
    });
  }

  return units;
}
