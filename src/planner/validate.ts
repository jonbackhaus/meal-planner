import type { Night, NightSchedule } from "../calendar/night-schedule.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import { buildSelectionPrompt, type PlannerInput } from "./input.js";
import { DEFAULT_MAX_PAIRED_SIDES, type Pools } from "./pools.js";
import {
  llmSelectFromPrompt,
  PlanSelectionError,
  parseSelectionResponse,
  runSelectionQuery,
  type SelectedMeal,
  type WeekPlan,
} from "./select.js";

/**
 * Deterministic post-selection validation + the single bounded repair retry
 * (ADR 0003 D5 — "the LLM decides; the code guarantees"). `select.ts`'s
 * `llmSelect` only shape-validates the LLM's JSON against `WeekPlanSchema`;
 * this module is where the SEMANTIC rules the shape schema can't express
 * (slot counts, pool membership, veg-consistency, no-dupes, flag sanity) are
 * checked in code — never just trusted from the model — and where the one
 * allowed re-prompt-on-violation happens before giving up.
 */

/**
 * A single human-readable validation failure, always naming the offending
 * meal/id and what's wrong (e.g. `meal 2 (recipe_id="ghost-id", ...): recipe_id
 * not found in the weeknight pool`). Fed back into the repair prompt verbatim,
 * so specificity here directly determines how well the repair call can fix
 * the plan.
 */
export type ValidationIssue = string;

/** The slice of config `validateWeekPlan` needs: the exact expected slot counts. */
export interface ValidatePlanConfig {
  slots: { constrained: number; relaxed: number };
  /**
   * Hard ceiling on paired side dishes per week (bd meal-planner-8zs.8).
   * Optional; defaults to `DEFAULT_MAX_PAIRED_SIDES` when omitted.
   */
  maxPairedSides?: number;
  /**
   * ADR-0004 D4's tighter active-time gate for a QUICK-capacity night: a meal
   * placed there must be quick-eligible (`active <= quickActiveMax`) OR
   * flagged `"do-ahead"` (ADR-0005 D3 rule 3, "capacity fit"). Optional;
   * defaults to `DEFAULT_QUICK_ACTIVE_MAX` below (mirrors `Config
   * .quickActiveMax`'s own ADR-0004 D4 default of 30 minutes) when omitted.
   */
  quickActiveMax?: number;
  /**
   * ADR-0005 D3/D2 gate for the "day must be non-null" requirement ("v2.0
   * validation requires non-null on a freshly generated plan").
   *
   * GATING DECISION (this task): non-null is required whenever the caller
   * declares a real night schedule is in play (`calendarEnabled: true`) —
   * which covers BOTH a live calendar read AND the ADR-0004 D6 static
   * fallback. The fallback still hands the planner concrete dated nights to
   * place onto, so a freshly generated plan is expected to place onto it
   * the same as a real read; the requirement is therefore gated on
   * "calendar enabled / real schedule available", NOT on whether the
   * schedule happens to be the degraded fallback. When omitted (default
   * `false`), a null `day` is tolerated — covering legacy/resume reads and
   * any caller not yet threading calendar context through this config.
   *
   * The other four day rules (valid-night, slot/weekday, capacity-fit,
   * distinct-days) run independently of this flag, against whatever
   * `input.night_schedule` is provided (empty when `input` is omitted), for
   * whatever non-null `day` values are already present.
   */
  calendarEnabled?: boolean;
}

/** ADR-0004 D4's own default quick-night active-time ceiling (minutes), used
 * when `cfg.quickActiveMax` is omitted. The live value normally flows from
 * `Config.quickActiveMax` (same default, config.ts) via the caller's `cfg`. */
const DEFAULT_QUICK_ACTIVE_MAX = 30;

/** Full local weekday names (`Night.weekday`) treated as weekend — mirrors
 * `derive-slots.ts`'s own private set, duplicated here rather than exporting
 * a two-string constant across modules for it. */
const WEEKEND_WEEKDAYS = new Set(["Saturday", "Sunday"]);

function findInPool(
  pool: RecipeCandidate[],
  id: string,
): RecipeCandidate | undefined {
  return pool.find((candidate) => candidate.id === id);
}

function findInPools(pools: Pools, id: string): RecipeCandidate | undefined {
  return findInPool(pools.weeknight, id) ?? findInPool(pools.weekend, id);
}

function poolForSlot(
  pools: Pools,
  slotType: SelectedMeal["slot_type"],
): { pool: RecipeCandidate[]; name: "weeknight" | "weekend" } {
  return slotType === "constrained"
    ? { pool: pools.weeknight, name: "weeknight" }
    : { pool: pools.weekend, name: "weekend" };
}

function mealLabel(meal: SelectedMeal, index: number): string {
  return `meal ${index + 1} (recipe_id="${meal.recipe_id}", slot_type=${meal.slot_type})`;
}

function findNight(schedule: NightSchedule, date: string): Night | undefined {
  return schedule.find((night) => night.date === date);
}

/**
 * ADR-0005 D3 non-null gate (see `ValidatePlanConfig.calendarEnabled`'s doc
 * for the gating decision): when `cfg.calendarEnabled`, every meal must
 * carry an assigned (non-null) `day`. A no-op when `calendarEnabled` is
 * false/omitted.
 */
function checkDayNonNull(
  meals: SelectedMeal[],
  cfg: ValidatePlanConfig,
): ValidationIssue[] {
  if (!cfg.calendarEnabled) {
    return [];
  }
  const issues: ValidationIssue[] = [];
  meals.forEach((meal, index) => {
    if (meal.day === null) {
      issues.push(
        `${mealLabel(meal, index)}: day is null but a night schedule is ` +
          "available (calendarEnabled); assign an ISO date from the schedule",
      );
    }
  });
  return issues;
}

/**
 * Rule 1 (ADR-0005 D3, "valid night"): every non-null `day` must name a
 * non-NONE night present in `schedule`. Runs against whatever `schedule` is
 * given (empty when no `PlannerInput` was supplied) for every non-null
 * `day`, independent of `calendarEnabled` — a null `day` is
 * `checkDayNonNull`'s concern, not this one's.
 */
function checkValidNight(
  meals: SelectedMeal[],
  schedule: NightSchedule,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  meals.forEach((meal, index) => {
    if (meal.day === null) {
      return;
    }
    const label = mealLabel(meal, index);
    const night = findNight(schedule, meal.day);
    if (!night) {
      issues.push(
        `${label}: day="${meal.day}" is not a night present in the schedule`,
      );
      return;
    }
    if (night.capacity === "NONE") {
      issues.push(
        `${label}: day="${meal.day}" is a NONE-capacity night (no cook that ` +
          "night); assign a FULL or QUICK night instead",
      );
    }
  });
  return issues;
}

/**
 * Rule 2 (ADR-0005 D3, "slot ↔ weekday consistency") — the day-side
 * counterpart of `checkMealsIndividually`'s pool-membership check: a
 * `constrained` meal's assigned day must fall on a WEEKNIGHT (Mon-Fri), a
 * `relaxed` meal's on a WEEKEND (Sat/Sun), per the schedule's own `weekday`
 * label for that date. Skips a `day` that doesn't resolve to a schedule
 * night at all (`checkValidNight` already reports that) or is null.
 */
function checkSlotWeekdayConsistency(
  meals: SelectedMeal[],
  schedule: NightSchedule,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  meals.forEach((meal, index) => {
    if (meal.day === null) {
      return;
    }
    const night = findNight(schedule, meal.day);
    if (!night) {
      return;
    }
    const label = mealLabel(meal, index);
    const isWeekendNight = WEEKEND_WEEKDAYS.has(night.weekday);
    if (meal.slot_type === "constrained" && isWeekendNight) {
      issues.push(
        `${label}: slot_type "constrained" is assigned to day="${meal.day}" ` +
          `(${night.weekday}), a weekend night; constrained meals must land ` +
          "on a weeknight",
      );
    } else if (meal.slot_type === "relaxed" && !isWeekendNight) {
      issues.push(
        `${label}: slot_type "relaxed" is assigned to day="${meal.day}" ` +
          `(${night.weekday}), a weeknight; relaxed meals must land on a ` +
          "weekend night",
      );
    }
  });
  return issues;
}

/**
 * Rule 3 (ADR-0005 D3, "capacity fit"): a meal placed on a QUICK-capacity
 * night must be quick-eligible — its own pool candidate's active time
 * `<= quickActiveMax` (default `DEFAULT_QUICK_ACTIVE_MAX`), OR the meal is
 * flagged `"do-ahead"`. An unknown (`null`) active time is treated as NOT
 * quick-eligible unless flagged `"do-ahead"` (can't confirm the ceiling,
 * conservative default, mirrors `renderMinutes`'s "unknown" handling
 * elsewhere in this pipeline). Skips a `day` that isn't a QUICK night, isn't
 * in the schedule (`checkValidNight`'s concern), or is null.
 */
function checkCapacityFit(
  meals: SelectedMeal[],
  pools: Pools,
  schedule: NightSchedule,
  cfg: ValidatePlanConfig,
): ValidationIssue[] {
  const quickActiveMax = cfg.quickActiveMax ?? DEFAULT_QUICK_ACTIVE_MAX;
  const issues: ValidationIssue[] = [];

  meals.forEach((meal, index) => {
    if (meal.day === null) {
      return;
    }
    const night = findNight(schedule, meal.day);
    if (night?.capacity !== "QUICK") {
      return;
    }
    const label = mealLabel(meal, index);
    const { pool } = poolForSlot(pools, meal.slot_type);
    const ownCandidate = findInPool(pool, meal.recipe_id);
    const active = ownCandidate?.time.active ?? null;
    const isDoAhead = meal.flags.includes("do-ahead");
    const quickEligible =
      isDoAhead || (active !== null && active <= quickActiveMax);

    if (!quickEligible) {
      const activeDescription = active === null ? "unknown" : `${active} min`;
      issues.push(
        `${label}: assigned to day="${meal.day}", a QUICK-capacity night, ` +
          `but its active time (${activeDescription}) exceeds the ` +
          `${quickActiveMax}-min quick ceiling and it is not flagged "do-ahead"`,
      );
    }
  });

  return issues;
}

/**
 * Rule 4 (ADR-0005 D3, "distinct days"): no two meals may share the same
 * non-null `day`. Mirrors `checkNoDuplicates`'s shape/labeling.
 */
function checkDistinctDays(meals: SelectedMeal[]): ValidationIssue[] {
  const occurrences = new Map<string, string[]>();

  meals.forEach((meal, index) => {
    if (meal.day === null) {
      return;
    }
    const labels = occurrences.get(meal.day) ?? [];
    labels.push(`meal ${index + 1}`);
    occurrences.set(meal.day, labels);
  });

  const issues: ValidationIssue[] = [];
  for (const [day, labels] of occurrences) {
    if (labels.length > 1) {
      issues.push(
        `day="${day}" is assigned to more than one meal (${labels.join(", ")}); ` +
          "each meal must be assigned a distinct day",
      );
    }
  }
  return issues;
}

/**
 * Rule 5 (ADR-0005 D3, "prep ordering"): a make-ahead meal's placed
 * `prep_date` (`WeekPlan.prep`, ADR-0004 D5's `PrepUnit`) must be STRICTLY
 * before its serve `serve_date`. Defensive per the delivering task: `prep`
 * is optional and its units' `prep_date` is nullable (not-yet-placed, or the
 * ADR-0004 D6 degraded no-calendar path) — this checks ordering only for
 * whatever units ARE present with a non-null `prep_date`; a plan with no
 * `prep` (or none yet placed) trivially passes. ISO `YYYY-MM-DD` strings
 * compare correctly with plain string comparison.
 */
function checkPrepOrdering(plan: WeekPlan): ValidationIssue[] {
  const prepUnits = plan.prep ?? [];
  const issues: ValidationIssue[] = [];

  prepUnits.forEach((unit, index) => {
    if (unit.prep_date === null) {
      return;
    }
    if (unit.prep_date >= unit.serve_date) {
      issues.push(
        `prep unit ${index + 1} ("${unit.description}"): prep_date="${unit.prep_date}" ` +
          `must be strictly before its serve day="${unit.serve_date}"`,
      );
    }
  });

  return issues;
}

/**
 * Checks the exact expected `constrained`/`relaxed` slot counts (ADR 0003
 * "What validate() checks" — counts).
 */
function checkCounts(
  meals: SelectedMeal[],
  cfg: ValidatePlanConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const constrainedCount = meals.filter(
    (meal) => meal.slot_type === "constrained",
  ).length;
  const relaxedCount = meals.filter(
    (meal) => meal.slot_type === "relaxed",
  ).length;

  if (constrainedCount !== cfg.slots.constrained) {
    issues.push(
      `expected exactly ${cfg.slots.constrained} constrained meal(s), found ${constrainedCount}`,
    );
  }
  if (relaxedCount !== cfg.slots.relaxed) {
    issues.push(
      `expected exactly ${cfg.slots.relaxed} relaxed meal(s), found ${relaxedCount}`,
    );
  }
  return issues;
}

/**
 * Per-meal membership + veg-consistency + per-meal flag-sanity checks.
 * Membership: `meal.recipe_id` must be a real candidate in the MATCHING pool
 * (constrained -> weeknight, relaxed -> weekend) — guards hallucinated ids.
 * Veg consistency: `veg.kind:"inherent"` requires the meal's OWN candidate to
 * be `veg_status:"vegetarian"`; `veg.kind:"second_dish"` requires its
 * `recipe_id`'s candidate (looked up in EITHER pool) to be
 * `veg_status:"vegetarian"`; `veg.kind:"separable"` is accepted as-is (not
 * verifiable in v1.0 — the ADR explicitly does not ask code to check it).
 * Flag sanity (per-meal, BOTH directions, keyed on the POOL candidate as ground
 * truth — 8zs.11): the `"untested"` flag must be present IFF the meal's own
 * candidate has `quality === "untested"`. A flag on a non-untested candidate is
 * a violation (the model over-claimed), AND an untested candidate WITHOUT the
 * flag is a violation (the model omitted the render hint) — the latter is the
 * bug the flag-only check missed.
 */
function checkMealsIndividually(
  meals: SelectedMeal[],
  pools: Pools,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  meals.forEach((meal, index) => {
    const label = mealLabel(meal, index);
    const { pool, name: poolName } = poolForSlot(pools, meal.slot_type);
    const ownCandidate = findInPool(pool, meal.recipe_id);

    if (!ownCandidate) {
      issues.push(`${label}: recipe_id not found in the ${poolName} pool`);
    }

    if (meal.veg.kind === "inherent") {
      if (ownCandidate && ownCandidate.veg_status !== "vegetarian") {
        issues.push(
          `${label}: veg.kind is "inherent" but its candidate's veg_status is ` +
            `"${ownCandidate.veg_status}", not "vegetarian"`,
        );
      }
    } else if (meal.veg.kind === "second_dish") {
      const secondCandidate = findInPools(pools, meal.veg.recipe_id);
      if (!secondCandidate) {
        issues.push(
          `${label}: second_dish.recipe_id="${meal.veg.recipe_id}" is not a real ` +
            "candidate in any pool",
        );
      } else if (secondCandidate.veg_status !== "vegetarian") {
        issues.push(
          `${label}: second_dish.recipe_id="${meal.veg.recipe_id}" has veg_status ` +
            `"${secondCandidate.veg_status}", not "vegetarian"`,
        );
      }
    }
    // veg.kind === "separable": accepted, not verifiable at v1.0 — no check.

    // Flag consistency, both directions (8zs.11). The pool candidate's quality
    // is ground truth; the model's flag is only a render hint that must agree.
    // Skipped when the id isn't in the pool — that hallucination is already
    // reported above, and the lookup would be meaningless.
    if (ownCandidate) {
      const flagged = meal.flags.includes("untested");
      const isUntested = ownCandidate.quality === "untested";
      if (flagged && !isUntested) {
        const quality = ownCandidate.quality ?? "unrated";
        issues.push(
          `${label}: flagged "untested" but its candidate's quality is ` +
            `"${quality}", not "untested"`,
        );
      } else if (isUntested && !flagged) {
        issues.push(
          `${label}: its candidate's quality is "untested" but the meal is ` +
            'not flagged "untested"; add the "untested" flag',
        );
      }
    }
  });

  return issues;
}

/**
 * Reconciles the `"untested"` render hint from ground truth (bd
 * meal-planner-6d3). The `"untested"` flag is a PURE presentation hint that is
 * DERIVABLE from the chosen pool candidate's `quality` — which
 * `checkMealsIndividually` and `checkUntestedCount` already treat as ground
 * truth — so a non-deterministic LLM omission (or over-claim) of the cosmetic
 * flag should be auto-reconciled, NOT hard-failed on the weekly critical path.
 *
 * Returns a NEW plan (never mutating `plan`) where, for each meal whose OWN
 * candidate is found in its matching pool (weeknight for `constrained`, weekend
 * for `relaxed` — the SAME lookup the validator uses):
 *  - candidate `quality === "untested"` → ensure `"untested"` IS in `flags`
 *    (append if missing; never duplicate);
 *  - candidate `quality !== "untested"` → ensure `"untested"` is NOT in `flags`
 *    (strip a stray one).
 * A meal whose id isn't in the matching pool (a hallucinated id) is left
 * untouched — the membership check already reports that. Every other flag and
 * meal field is preserved exactly, and flag order is preserved aside from the
 * single add/remove.
 */
export function normalizeUntestedFlags(plan: WeekPlan, pools: Pools): WeekPlan {
  const meals = plan.meals.map((meal) => {
    const { pool } = poolForSlot(pools, meal.slot_type);
    const ownCandidate = findInPool(pool, meal.recipe_id);
    if (!ownCandidate) {
      return meal;
    }

    const isUntested = ownCandidate.quality === "untested";
    const flagged = meal.flags.includes("untested");

    if (isUntested && !flagged) {
      return { ...meal, flags: [...meal.flags, "untested"] };
    }
    if (!isUntested && flagged) {
      return {
        ...meal,
        flags: meal.flags.filter((flag) => flag !== "untested"),
      };
    }
    return meal;
  });

  return { ...plan, meals };
}

/**
 * No-duplicates check: a recipe id may appear at most once across ALL
 * `recipe_id` + `second_dish.recipe_id` + `side.recipe_id` values in the week
 * (a paired side can't duplicate a main, a second_dish, or another side —
 * bd meal-planner-8zs.8).
 */
function checkNoDuplicates(meals: SelectedMeal[]): ValidationIssue[] {
  const occurrences = new Map<string, string[]>();

  const record = (id: string, label: string) => {
    const labels = occurrences.get(id) ?? [];
    labels.push(label);
    occurrences.set(id, labels);
  };

  meals.forEach((meal, index) => {
    const label = `meal ${index + 1}`;
    record(meal.recipe_id, label);
    if (meal.veg.kind === "second_dish") {
      record(meal.veg.recipe_id, `${label} second_dish`);
    }
    if (meal.side) {
      record(meal.side.recipe_id, `${label} side`);
    }
  });

  const issues: ValidationIssue[] = [];
  for (const [id, labels] of occurrences) {
    if (labels.length > 1) {
      issues.push(
        `recipe_id="${id}" is used more than once this week (${labels.join(", ")}); ` +
          "each recipe may appear at most once",
      );
    }
  }
  return issues;
}

/**
 * Untested-cap check (week-wide, 8zs.11): at most one meal in the whole week
 * may use an untested recipe. Counts by the POOL candidate's `quality ===
 * "untested"` (ground truth), NOT the model's `"untested"` flag — the model can
 * omit the flag on an untested pick, so trusting the flag would let a week full
 * of never-cooked recipes pass. A meal whose id isn't in the matching pool has
 * no candidate to key on and doesn't count here (the id-in-pool check fires).
 */
function checkUntestedCount(
  meals: SelectedMeal[],
  pools: Pools,
): ValidationIssue[] {
  const untestedLabels = meals
    .map((meal, index) => ({ meal, label: `meal ${index + 1}` }))
    .filter(({ meal }) => {
      const { pool } = poolForSlot(pools, meal.slot_type);
      return findInPool(pool, meal.recipe_id)?.quality === "untested";
    })
    .map(({ label }) => label);

  if (untestedLabels.length > 1) {
    return [
      `more than one meal uses an untested recipe this week (${untestedLabels.join(", ")}); ` +
        "at most one untested meal is allowed",
    ];
  }
  return [];
}

/**
 * Optional-side checks (bd meal-planner-8zs.8), all secret-free (ids/counts
 * only): for every meal carrying a `side`,
 *  (i)  `side.recipe_id` must be a real candidate in the SIDES pool (guards a
 *       hallucinated or main-pool id), and
 *  (ii) that side candidate must be `veg_status: "vegetarian"` (ratified: a
 *       paired side MUST be veg-satisfiable so the daughter can eat it too);
 * plus (iii) a week-wide cap — total paired sides may not exceed
 * `maxPairedSides` (default `DEFAULT_MAX_PAIRED_SIDES`). Uniqueness of a side
 * id against mains/other sides is enforced separately by `checkNoDuplicates`.
 */
function checkSides(
  meals: SelectedMeal[],
  pools: Pools,
  cfg: ValidatePlanConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sidePool = pools.sides ?? [];
  let pairedCount = 0;

  meals.forEach((meal, index) => {
    if (!meal.side) {
      return;
    }
    pairedCount += 1;
    const label = mealLabel(meal, index);
    const sideCandidate = findInPool(sidePool, meal.side.recipe_id);
    if (!sideCandidate) {
      issues.push(
        `${label}: side.recipe_id="${meal.side.recipe_id}" is not a real candidate ` +
          "in the sides pool",
      );
    } else if (sideCandidate.veg_status !== "vegetarian") {
      issues.push(
        `${label}: side.recipe_id="${meal.side.recipe_id}" has veg_status ` +
          `"${sideCandidate.veg_status}", not "vegetarian" (a paired side must be vegetarian)`,
      );
    }
  });

  const maxPairedSides = cfg.maxPairedSides ?? DEFAULT_MAX_PAIRED_SIDES;
  if (pairedCount > maxPairedSides) {
    issues.push(
      `${pairedCount} paired side(s) this week exceeds the maximum of ${maxPairedSides}`,
    );
  }
  return issues;
}

/**
 * Deterministic post-selection validation (ADR 0003 "What validate()
 * checks", extended by ADR-0005 D3 with 5 day rules): counts, pool
 * membership (guards hallucinated ids), veg consistency, no-dupes, flag
 * sanity, optional-side rules (8zs.8), and — when `input` is supplied — the
 * day-assignment rules (valid-night, slot/weekday consistency, capacity fit,
 * distinct days, prep ordering). Returns an empty array when `plan` is fully
 * valid; otherwise a list of specific, human-readable `ValidationIssue`s,
 * each naming the offending meal/id — this list is fed straight into the
 * repair prompt, so specificity here is load-bearing.
 *
 * `input` is OPTIONAL (defaults `night_schedule` to `[]` when omitted) so
 * every existing caller/test keeps compiling and behaving unchanged — the
 * day rules simply have nothing to check against (and `cfg.calendarEnabled`
 * defaults to `false`, so the non-null gate stays off) until a caller
 * threads `PlannerInput` through.
 *
 * Pure and synchronous: makes no LLM call and never retries — that's
 * `selectValidatedPlan`'s job.
 */
export function validateWeekPlan(
  plan: WeekPlan,
  pools: Pools,
  cfg: ValidatePlanConfig,
  input?: PlannerInput,
): ValidationIssue[] {
  const schedule = input?.night_schedule ?? [];
  return [
    ...checkCounts(plan.meals, cfg),
    ...checkMealsIndividually(plan.meals, pools),
    ...checkNoDuplicates(plan.meals),
    ...checkUntestedCount(plan.meals, pools),
    ...checkSides(plan.meals, pools, cfg),
    ...checkDayNonNull(plan.meals, cfg),
    ...checkValidNight(plan.meals, schedule),
    ...checkSlotWeekdayConsistency(plan.meals, schedule),
    ...checkCapacityFit(plan.meals, pools, schedule, cfg),
    ...checkDistinctDays(plan.meals),
    ...checkPrepOrdering(plan),
  ];
}

/**
 * Thrown when a `WeekPlan` is STILL invalid after the one bounded repair
 * retry (ADR 0003 D5: fail loudly rather than looping or silently persisting
 * a plan that violates a hard constraint). Carries the final `issues` (ids/
 * counts/slot types only) for the caller (E3) to log/alert on — deliberately
 * never carries the raw prompt or household prose, so it's always safe to
 * log.
 */
export class PlanValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(
      `plan validation failed after the repair attempt:\n${issues
        .map((issue) => `- ${issue}`)
        .join("\n")}`,
    );
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}

/**
 * Thrown BEFORE the selection call when the composed pools cannot possibly
 * satisfy the exact slot counts — an empty/thin index, a tag wipe, or an
 * over-selective filter combo (bd meal-planner-8zs.12). Without this pre-check
 * `buildPlan` would still issue the selection call AND its repair call (two
 * guaranteed-doomed PAID LLM calls) and then surface a misleading
 * `PlanValidationError` ("expected N constrained, found 0") instead of naming
 * the real problem. Carries the actual pool sizes vs. required counts so the
 * #agent-alerts message (via `generateForWeek`'s failure path) is actionable.
 * Secret-free by construction: counts only — never a recipe title/body/id or
 * household prose — so it's always safe to log/alert.
 */
export class InsufficientPoolError extends Error {
  readonly weeknightPoolSize: number;
  readonly weekendPoolSize: number;
  readonly distinctPoolSize: number;
  readonly constrainedSlots: number;
  readonly relaxedSlots: number;

  constructor(sizes: {
    weeknightPoolSize: number;
    weekendPoolSize: number;
    distinctPoolSize: number;
    constrainedSlots: number;
    relaxedSlots: number;
  }) {
    const totalSlots = sizes.constrainedSlots + sizes.relaxedSlots;
    super(
      "insufficient candidate pool for selection: " +
        `weeknight pool has ${sizes.weeknightPoolSize} candidate(s) for ` +
        `${sizes.constrainedSlots} constrained slot(s); ` +
        `weekend pool has ${sizes.weekendPoolSize} candidate(s) for ` +
        `${sizes.relaxedSlots} relaxed slot(s); ` +
        `${sizes.distinctPoolSize} distinct recipe(s) across both pools for ` +
        `${totalSlots} total slot(s) (each recipe may be used at most once)`,
    );
    this.name = "InsufficientPoolError";
    this.weeknightPoolSize = sizes.weeknightPoolSize;
    this.weekendPoolSize = sizes.weekendPoolSize;
    this.distinctPoolSize = sizes.distinctPoolSize;
    this.constrainedSlots = sizes.constrainedSlots;
    this.relaxedSlots = sizes.relaxedSlots;
  }
}

/**
 * Deterministic pool-sufficiency pre-check (bd meal-planner-8zs.12), run in
 * `buildPlan` AFTER `composePools` but BEFORE any LLM call, so a doomed run
 * spends zero paid tokens. Generalizes the empty-index case `index.ts` already
 * acknowledges: an empty index yields empty pools, which this rejects with a
 * clear `InsufficientPoolError` (routed to the same failed+alert path) rather
 * than a misleading post-selection `PlanValidationError`.
 *
 * A valid `WeekPlan` needs `constrained` DISTINCT recipes drawn from the
 * weeknight pool (constrained meals validate against `pools.weeknight`),
 * `relaxed` DISTINCT recipes from the weekend pool, and — because
 * `checkNoDuplicates` forbids any recipe appearing twice across the week —
 * `constrained + relaxed` DISTINCT recipes in total. A recipe CAN appear in
 * both pools (the weekend pool drops `active_max`, but a fast recipe is
 * returned by both searches), so a per-pool count alone can double-count it;
 * the total requirement must be measured against the UNION of distinct ids
 * across both pools.
 *
 * Three checks (necessary AND sufficient — this is a two-group system of
 * distinct representatives, so by Hall's theorem feasibility reduces exactly to
 * these three cases: constrained-only slots -> weeknight set, relaxed-only ->
 * weekend set, any mix -> the union):
 *   1. distinct weeknight ids >= `constrained`
 *   2. distinct weekend ids  >= `relaxed`
 *   3. distinct union of ids >= `constrained + relaxed`
 *
 * (Optional `second_dish` veg sides consume additional distinct ids, but they
 * are out of scope for this coarse slot-feasibility gate — veg availability is
 * handled by the veg-floor composition — so this counts main slots only.)
 */
export function assertPoolsSufficient(
  pools: Pools,
  slots: { constrained: number; relaxed: number },
): void {
  const weeknightIds = new Set(pools.weeknight.map((c) => c.id));
  const weekendIds = new Set(pools.weekend.map((c) => c.id));
  const distinctIds = new Set([...weeknightIds, ...weekendIds]);
  const totalSlots = slots.constrained + slots.relaxed;

  if (
    weeknightIds.size < slots.constrained ||
    weekendIds.size < slots.relaxed ||
    distinctIds.size < totalSlots
  ) {
    throw new InsufficientPoolError({
      weeknightPoolSize: weeknightIds.size,
      weekendPoolSize: weekendIds.size,
      distinctPoolSize: distinctIds.size,
      constrainedSlots: slots.constrained,
      relaxedSlots: slots.relaxed,
    });
  }
}

/**
 * Builds the ONE repair prompt sent back to the LLM after an invalid
 * selection. Re-renders the same selection prompt (`buildSelectionPrompt`) —
 * the CANDIDATES section is what lets the model actually fix hallucinated
 * ids / veg-consistency violations, so it can't be dropped — then appends a
 * compact REPAIR section: the previous (invalid) plan as JSON, plus every
 * `ValidationIssue` found, plus a one-line instruction to return a corrected
 * WeekPlan JSON object and nothing else.
 *
 * Token-bounding note: this intentionally does NOT re-derive or restate the
 * rules/rationale beyond the delta (previous plan + issues) — it costs one
 * extra prompt's worth of tokens (the original selection prompt's size,
 * roughly doubling ONE call's cost), but the call COUNT stays bounded at
 * exactly one repair, which is what keeps the run inside the ADR's cost cap.
 * Truncating the CANDIDATES section further isn't safe: fixing a hallucinated
 * id or a veg-consistency violation requires the model to see the real ids/
 * veg_status/quality data again.
 */
export function buildRepairPrompt(
  input: PlannerInput,
  plan: WeekPlan,
  issues: ValidationIssue[],
): string {
  const basePrompt = buildSelectionPrompt(input);
  const issueLines = issues.map((issue) => `- ${issue}`).join("\n");

  return (
    `${basePrompt}\n\n` +
    "REPAIR\n" +
    "Your previous response below FAILED validation. Previous response:\n" +
    `${JSON.stringify(plan)}\n\n` +
    "Problems (fix EVERY one of these; do not introduce new ones):\n" +
    `${issueLines}\n\n` +
    "Return ONLY a corrected WeekPlan JSON object, in the exact same shape as before, " +
    "that resolves every problem above. No prose, no markdown fences."
  );
}

/**
 * Builds the ONE repair prompt sent back to the LLM after a SHAPE failure —
 * the initial selection response couldn't be parsed into / didn't match
 * `WeekPlanSchema` (bad JSON, a `{week_plan: {...}}` envelope, an extra key, a
 * string `"null"` day, …). Mirrors `recipe-mcp/extraction.ts`'s repair pattern:
 * quote the model's own malformed `previousResponse` verbatim plus the concrete
 * `reason` it failed, then ask for corrected JSON.
 *
 * Like `buildRepairPrompt`, it re-renders the full selection prompt
 * (`buildSelectionPrompt`) first so the CANDIDATES section — the real ids /
 * veg_status / quality — is present for the model to re-emit against. The only
 * additions over that base prompt are the raw previous response and the parse/
 * shape error; it introduces no new household context (and thus no new leakage
 * surface) beyond what the base selection prompt already carries.
 */
export function buildShapeRepairPrompt(
  input: PlannerInput,
  previousResponse: string,
  reason: string,
): string {
  const basePrompt = buildSelectionPrompt(input);

  return (
    `${basePrompt}\n\n` +
    "REPAIR\n" +
    "Your previous response below could NOT be parsed into the required " +
    "WeekPlan JSON shape. Previous response:\n" +
    `${previousResponse}\n\n` +
    "Problem (fix it; do not wrap the object, add keys, or emit prose):\n" +
    `${reason}\n\n` +
    "Return ONLY a corrected WeekPlan JSON object, in the exact shape described " +
    "above. No prose, no markdown fences."
  );
}

export interface SelectValidatedPlanDeps {
  llm: LlmClient;
}

/**
 * ADR 0003's `buildPlan` steps 2-3 (minus the `get_recipe` enrich, which is
 * 8zs.5): runs the single selection call, validates it in code, and — on any
 * violation — makes EXACTLY ONE repair re-prompt before giving up. Net LLM
 * calls: at most 2 (the initial selection call plus one repair call) — never an
 * unbounded retry loop.
 *
 * The initial call can fail in two ways, and the ONE repair budget is SHARED
 * between them — whichever occurs first consumes it (8zs.10):
 *  - SHAPE failure: the response can't be parsed into / doesn't match
 *    `WeekPlanSchema` (`PlanSelectionError` — bad JSON, a `{week_plan: {...}}`
 *    envelope, an extra key, a string `"null"` day, …). Caught here; the repair
 *    quotes the model's raw malformed text + the parse error
 *    (`buildShapeRepairPrompt`, mirroring `recipe-mcp/extraction.ts`). The
 *    repaired result must then pass BOTH shape AND semantics.
 *  - SEMANTIC failure: the response parsed fine but `validateWeekPlan` found
 *    rule violations (counts / hallucinated ids / veg-consistency / dupes). The
 *    repair names the violations (`buildRepairPrompt`).
 *
 * Because the budget is shared, a SHAPE failure on the initial call does NOT
 * additionally earn a semantic repair (that would be a 3rd call) — if the shape
 * repair's result still fails (shape OR semantic), this throws immediately.
 * Throws `PlanValidationError` on a residual semantic failure and
 * `PlanSelectionError` on a residual shape failure — never retries further.
 */
export async function selectValidatedPlan(
  input: PlannerInput,
  pools: Pools,
  cfg: ValidatePlanConfig,
  deps: SelectValidatedPlanDeps,
): Promise<WeekPlan> {
  const initialText = await runSelectionQuery(
    buildSelectionPrompt(input),
    deps,
  );

  let plan: WeekPlan;
  try {
    plan = parseSelectionResponse(initialText);
  } catch (error) {
    if (!(error instanceof PlanSelectionError)) {
      throw error;
    }
    // SHAPE failure on the initial call: spend the ONE shared repair budget on
    // a shape-repair re-prompt. This is the whole budget — the repaired result
    // must pass BOTH parse/shape AND semantics with NO further call. A residual
    // shape failure re-throws `PlanSelectionError` from `parseSelectionResponse`
    // (total 2 calls); a residual semantic failure throws `PlanValidationError`
    // (also 2 calls). Either way: never a 3rd call.
    const repairPrompt = buildShapeRepairPrompt(
      input,
      initialText,
      error.message,
    );
    const repairedText = await runSelectionQuery(repairPrompt, deps);
    const repairedPlan = normalizeUntestedFlags(
      parseSelectionResponse(repairedText),
      pools,
    );
    const repairIssues = validateWeekPlan(repairedPlan, pools, cfg, input);
    if (repairIssues.length > 0) {
      throw new PlanValidationError(repairIssues);
    }
    return repairedPlan;
  }

  // Initial call parsed cleanly. SEMANTIC path: reconcile the derivable
  // "untested" render hint from ground-truth pool quality (bd meal-planner-6d3)
  // BEFORE validating, so a cosmetic flag omission/over-claim is auto-fixed
  // rather than burning the ONE repair budget or hard-failing the week.
  const normalizedPlan = normalizeUntestedFlags(plan, pools);
  const issues = validateWeekPlan(normalizedPlan, pools, cfg, input);
  if (issues.length === 0) {
    return normalizedPlan;
  }

  const repairPrompt = buildRepairPrompt(input, normalizedPlan, issues);
  const repairedPlan = normalizeUntestedFlags(
    await llmSelectFromPrompt(repairPrompt, deps),
    pools,
  );
  const repairIssues = validateWeekPlan(repairedPlan, pools, cfg, input);
  if (repairIssues.length === 0) {
    return repairedPlan;
  }

  throw new PlanValidationError(repairIssues);
}
