import type { Recipe } from "../recipe-mcp/schema.js";
import type { SelectedMeal, WeekPlan } from "./select.js";

/**
 * Final planner pipeline step: `get_recipe` enrich (ADR 0003 pipeline step 4,
 * bd meal-planner-8zs.5). Runs AFTER `selectValidatedPlan` (8zs.4) — takes the
 * validated `WeekPlan` (recipe ids only) and attaches the FULL `Recipe`
 * (ingredient block included) for each chosen meal, so the plan is ready for
 * the draft render (E5, source/body) and later the v4.0 grocery step
 * (ingredient block).
 *
 * This module makes NO LLM call and does no selection/validation of its own
 * — it only fetches, via the injected `getRecipe`, exactly the ids the
 * validated plan already named.
 */

/**
 * A `SelectedMeal` with its full `Recipe` attached, plus (for a
 * `veg.kind:"second_dish"` meal) the second dish's own `Recipe`.
 */
export type EnrichedMeal = SelectedMeal & {
  recipe: Recipe;
  secondDishRecipe?: Recipe;
};

/** `WeekPlan` with every meal enriched to an `EnrichedMeal`. */
export interface EnrichedWeekPlan {
  week_key: string;
  meals: EnrichedMeal[];
  summary?: string;
}

export interface EnrichPlanDeps {
  /** A bound `getRecipe(id)` callback — `getRecipe` with its own store deps already applied. */
  getRecipe: (id: string) => Promise<Recipe | null>;
}

/**
 * Thrown when `getRecipe` returns `null` for an id the validated plan
 * selected. This should not happen in the normal case — `selectValidatedPlan`
 * (8zs.4) already confirmed every selected/second_dish id is a real pool
 * member — but the underlying note/structured record could go missing
 * between search and enrich (e.g. deleted mid-run). Rather than silently
 * dropping the meal, this fails loudly, naming only the id (never any
 * household prose or other secret), so it's always safe to log.
 */
export class EnrichmentError extends Error {
  constructor(id: string) {
    super(
      `getRecipe returned null for recipe_id="${id}", which was already ` +
        "selected and validated as a pool member; the underlying recipe " +
        "record may have gone missing between search and enrich",
    );
    this.name = "EnrichmentError";
  }
}

async function fetchRecipe(
  id: string,
  getRecipe: EnrichPlanDeps["getRecipe"],
): Promise<Recipe> {
  const recipe = await getRecipe(id);
  if (!recipe) {
    throw new EnrichmentError(id);
  }
  return recipe;
}

/**
 * Enriches every selected meal with its full `Recipe` via the injected
 * `getRecipe`, fetching concurrently (`Promise.all`) since this is ~5-6
 * independent reads with no ordering dependency between them. For a
 * `veg.kind:"second_dish"` meal, also fetches the second dish's `Recipe` as
 * `secondDishRecipe`.
 */
export async function enrichPlan(
  plan: WeekPlan,
  deps: EnrichPlanDeps,
): Promise<EnrichedWeekPlan> {
  const { getRecipe } = deps;

  const meals = await Promise.all(
    plan.meals.map(async (meal): Promise<EnrichedMeal> => {
      const [recipe, secondDishRecipe] = await Promise.all([
        fetchRecipe(meal.recipe_id, getRecipe),
        meal.veg.kind === "second_dish"
          ? fetchRecipe(meal.veg.recipe_id, getRecipe)
          : Promise.resolve(undefined),
      ]);

      return secondDishRecipe !== undefined
        ? { ...meal, recipe, secondDishRecipe }
        : { ...meal, recipe };
    }),
  );

  return {
    week_key: plan.week_key,
    meals,
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
  };
}
