import type { LlmClient } from "../llm/llm-client.js";
import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import { buildSelectionPrompt, type PlannerInput } from "./input.js";
import type { Pools } from "./pools.js";
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
    ...checkUntestedCount(plan.meals, pools),
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
    const repairedPlan = parseSelectionResponse(repairedText);
    const repairIssues = validateWeekPlan(repairedPlan, pools, cfg);
    if (repairIssues.length > 0) {
      throw new PlanValidationError(repairIssues);
    }
    return repairedPlan;
  }

  // Initial call parsed cleanly. SEMANTIC path (unchanged): spend the ONE shared
  // repair budget on a semantic-repair re-prompt if code validation finds issues.
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
