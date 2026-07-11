import type { LlmClient } from "../llm/llm-client.js";
import type { Recipe } from "../recipe-mcp/schema.js";
import { type EnrichedWeekPlan, enrichPlan } from "./enrich.js";
import { buildPlannerInput } from "./input.js";
import {
  type ComposePoolsDeps,
  composePools,
  type PoolCompositionConfig,
} from "./pools.js";
import { selectValidatedPlan } from "./validate.js";

/**
 * The planner's public entry point (ADR 0002 `buildPlan(wk)`) — the single
 * function E3's `generateForWeek` calls. Chains the whole planner pipeline:
 * `composePools` -> `buildPlannerInput` -> `selectValidatedPlan` ->
 * `enrichPlan`. Building the orchestrator/state-machine/`generateForWeek`
 * ITSELF is out of scope here (E3) — this is only what it calls.
 */

/**
 * v1.0's default semantic seed query (ADR 0003): a thin, generic diversity
 * seed rather than a category-seeded or recency/weather-framed multi-query.
 * The actual seed-query STRATEGY is still an open decision
 * (bd meal-planner-l7x), to be finalized during the plan-quality tuning task
 * (8zs.6) — this default is a reasonable placeholder, not the final answer.
 * Callers may override it per-run via `cfg.seedQuery`.
 */
export const DEFAULT_SEED_QUERY = "varied family weeknight and weekend dinners";

/**
 * The planner-relevant `Config` subset `buildPlan` needs: everything
 * `composePools` needs (`cookNights` — which also supplies the exact slot
 * counts for selection/validation — `activeMaxMinutes`, `fanoutMultiplier`,
 * `vegFloorK`, `untestedRate`, optional `season`), plus an optional
 * `seedQuery` override (see `DEFAULT_SEED_QUERY` above).
 */
export type BuildPlanConfig = PoolCompositionConfig & {
  seedQuery?: string;
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
  const seedQuery = cfg.seedQuery ?? DEFAULT_SEED_QUERY;

  const pools = await composePools(seedQuery, cfg, { search: deps.search });

  const slots = {
    constrained: cfg.cookNights.constrained,
    relaxed: cfg.cookNights.relaxed,
  };

  const input = buildPlannerInput({
    weekKey,
    slots,
    pools,
    household,
    currentSeason: cfg.season,
  });

  const plan = await selectValidatedPlan(
    input,
    pools,
    { slots },
    { llm: deps.llm },
  );

  return enrichPlan(plan, { getRecipe: deps.getRecipe });
}
