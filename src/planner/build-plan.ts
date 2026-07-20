import type { LlmClient } from "../llm/llm-client.js";
import type { Recipe } from "../recipe-mcp/schema.js";
import { type EnrichedWeekPlan, enrichPlan } from "./enrich.js";
import { buildPlannerInput } from "./input.js";
import {
  type ComposePoolsDeps,
  composePools,
  type PoolCompositionConfig,
} from "./pools.js";
import { assertPoolsSufficient, selectValidatedPlan } from "./validate.js";

/**
 * The planner's public entry point (ADR 0002 `buildPlan(wk)`) — the single
 * function E3's `generateForWeek` calls. Chains the whole planner pipeline:
 * `composePools` -> `buildPlannerInput` -> `selectValidatedPlan` ->
 * `enrichPlan`. Building the orchestrator/state-machine/`generateForWeek`
 * ITSELF is out of scope here (E3) — this is only what it calls.
 */

/**
 * v1.0's default semantic seed SET (ADR 0003 / bd meal-planner-l7x, resolved in
 * 8zs.6): a category-seeded multi-query, NOT a single generic seed. Live
 * measurement showed one bland seed under-recalls — its nearest neighbours are
 * a narrow, low-signal cluster (only ~2 rated dinners, 0 rated-veg, of its top
 * 48) — so `composePools` retrieves a coherent cluster per seed and merges them
 * (per-seed capped for fairness). One seed is explicitly vegetarian to guarantee
 * rated-veg coverage for the every-night vegetarian constraint. Seed wording is
 * tunable (part of 8zs.6). Callers may override per-run via `cfg.seeds`.
 */
export const DEFAULT_SEEDS: string[] = [
  "vegetarian family dinner",
  "chicken dinner",
  "beef or pork main dish",
  "fish or seafood dinner",
  "pasta, noodle, or grain bowl dinner",
  "curry, stir-fry, or braise",
];

/**
 * The planner-relevant `Config` subset `buildPlan` needs: everything
 * `composePools` needs (`cookNights` — which also supplies the exact slot
 * counts for selection/validation — `activeMaxMinutes`, `fanoutMultiplier`,
 * `vegFloorK`, `untestedRate`, optional `season`), plus an optional
 * `seeds` override (see `DEFAULT_SEEDS` above).
 */
export type BuildPlanConfig = PoolCompositionConfig & {
  seeds?: string[];
};

export interface BuildPlanDeps {
  /** A bound `search(query, filters)` callback — `search_recipes` with its own deps applied. */
  search: ComposePoolsDeps["search"];
  llm: LlmClient;
  /** A bound `getRecipe(id)` callback — `get_recipe` with its own deps applied. */
  getRecipe: (id: string) => Promise<Recipe | null>;
}

export interface BuildPlanArgs {
  weekKey: string;
  cfg: BuildPlanConfig;
  /**
   * Caller-supplied household prose (vegetarian daughter, picky-youngest,
   * etc.) — sourced from config/env by the orchestrator, not this module.
   * See `PlannerInput.household`'s doc in `input.ts`.
   */
  household: string;
  deps: BuildPlanDeps;
}

/**
 * Runs the full planner pipeline for one week:
 * 1. `composePools(seedQuery, cfg, { search })` — code-composed candidate pools.
 * 2. `buildPlannerInput(...)` — assembles the typed selection input from those SAME pools.
 * 3. `selectValidatedPlan(input, pools, cfg, { llm })` — one selection call, validated
 *    against those SAME pools, with the one bounded repair retry (8zs.4).
 * 4. `enrichPlan(plan, { getRecipe })` — attaches the full `Recipe` to every chosen meal (8zs.5).
 *
 * The SAME `pools` value from step 1 is passed into BOTH step 2 (selection input)
 * and step 3 (validation) — a plan that references an id outside those pools
 * fails validation (and, after the bounded repair, throws `PlanValidationError`)
 * rather than silently passing.
 */
export async function buildPlan(
  args: BuildPlanArgs,
): Promise<EnrichedWeekPlan> {
  const { weekKey, cfg, household, deps } = args;
  const seeds = cfg.seeds ?? DEFAULT_SEEDS;

  const pools = await composePools(seeds, cfg, { search: deps.search });

  const slots = {
    constrained: cfg.cookNights.constrained,
    relaxed: cfg.cookNights.relaxed,
  };

  // Pool-sufficiency pre-check (bd meal-planner-8zs.12): fail deterministically
  // BEFORE any (paid) LLM call when the composed pools can't satisfy the slot
  // counts — an empty/thin index, a tag wipe, or an over-selective filter combo
  // would otherwise burn the selection AND repair calls and then throw a
  // misleading PlanValidationError. `InsufficientPoolError` propagates to
  // `generateForWeek`'s failed+alert path with an actionable, secret-free message.
  assertPoolsSufficient(pools, slots);

  const input = buildPlannerInput({
    weekKey,
    slots,
    pools,
    household,
    currentSeason: cfg.season,
    maxPairedSides: cfg.maxPairedSides,
  });

  const plan = await selectValidatedPlan(
    input,
    pools,
    { slots, maxPairedSides: cfg.maxPairedSides },
    { llm: deps.llm },
  );

  return enrichPlan(plan, { getRecipe: deps.getRecipe });
}
