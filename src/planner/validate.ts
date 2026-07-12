import type { LlmClient } from "../llm/llm-client.js";
import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import { buildSelectionPrompt, type PlannerInput } from "./input.js";
import type { Pools } from "./pools.js";
import {
  llmSelect,
  llmSelectFromPrompt,
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
}

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
 * Flag sanity (per-meal half): the `"untested"` flag requires the meal's own
 * candidate to have `quality === "untested"`.
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

    if (meal.flags.includes("untested") && ownCandidate) {
      const quality = ownCandidate.quality ?? "unrated";
      if (quality !== "untested") {
        issues.push(
          `${label}: flagged "untested" but its candidate's quality is ` +
            `"${quality}", not "untested"`,
        );
      }
    }
  });

  return issues;
}

/**
 * No-duplicates check: a recipe id may appear at most once across ALL
 * `recipe_id` + `second_dish.recipe_id` values in the week.
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
 * Flag-sanity check (week-wide half): at most one meal in the whole week may
 * carry the `"untested"` flag.
 */
function checkUntestedCount(meals: SelectedMeal[]): ValidationIssue[] {
  const untestedLabels = meals
    .map((meal, index) => ({ meal, label: `meal ${index + 1}` }))
    .filter(({ meal }) => meal.flags.includes("untested"))
    .map(({ label }) => label);

  if (untestedLabels.length > 1) {
    return [
      `more than one meal is flagged "untested" this week (${untestedLabels.join(", ")}); ` +
        "at most one untested meal is allowed",
    ];
  }
  return [];
}

/**
 * Deterministic post-selection validation (ADR 0003 "What validate()
 * checks"): counts, pool membership (guards hallucinated ids), veg
 * consistency, no-dupes, and flag sanity. Returns an empty array when `plan`
 * is fully valid; otherwise a list of specific, human-readable
 * `ValidationIssue`s, each naming the offending meal/id — this list is fed
 * straight into the repair prompt, so specificity here is load-bearing.
 *
 * Pure and synchronous: makes no LLM call and never retries — that's
 * `selectValidatedPlan`'s job.
 */
export function validateWeekPlan(
  plan: WeekPlan,
  pools: Pools,
  cfg: ValidatePlanConfig,
): ValidationIssue[] {
  return [
    ...checkCounts(plan.meals, cfg),
    ...checkMealsIndividually(plan.meals, pools),
    ...checkNoDuplicates(plan.meals),
    ...checkUntestedCount(plan.meals),
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

export interface SelectValidatedPlanDeps {
  llm: LlmClient;
}

/**
 * ADR 0003's `buildPlan` steps 2-3 (minus the `get_recipe` enrich, which is
 * 8zs.5): runs the single selection call, validates it in code, and — on any
 * violation — makes EXACTLY ONE repair re-prompt naming the violations before
 * giving up. Net LLM calls: at most 2 (the initial `llmSelect` call, plus one
 * repair `llmSelectFromPrompt` call) — never an unbounded retry loop.
 *
 * Throws `PlanValidationError` (never retries further) if the repaired plan
 * is STILL invalid. `llmSelect`/`llmSelectFromPrompt`'s own `PlanSelectionError`
 * (unparseable JSON / wrong shape) propagates as-is — this function does not
 * catch or repair a shape failure, only a SEMANTIC validation failure.
 */
export async function selectValidatedPlan(
  input: PlannerInput,
  pools: Pools,
  cfg: ValidatePlanConfig,
  deps: SelectValidatedPlanDeps,
): Promise<WeekPlan> {
  const plan = await llmSelect(input, deps);
  const issues = validateWeekPlan(plan, pools, cfg);
  if (issues.length === 0) {
    return plan;
  }

  const repairPrompt = buildRepairPrompt(input, plan, issues);
  const repairedPlan = await llmSelectFromPrompt(repairPrompt, deps);
  const repairIssues = validateWeekPlan(repairedPlan, pools, cfg);
  if (repairIssues.length === 0) {
    return repairedPlan;
  }

  throw new PlanValidationError(repairIssues);
}
