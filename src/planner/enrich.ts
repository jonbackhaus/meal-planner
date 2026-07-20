import { z } from "zod";
import { type Recipe, RecipeSchema } from "../recipe-mcp/schema.js";
import { SelectedMealSchema, type WeekPlan } from "./select.js";

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
 * The CANONICAL schema for what `enrichPlan` produces, and the single source
 * of truth for the `EnrichedMeal`/`EnrichedWeekPlan` shape (bd6.8). Composed
 * from the two schemas the planner already owns — `SelectedMealSchema`
 * (planner/select.ts, the pre-enrichment shape) extended with the
 * `recipe`/`secondDishRecipe` fields `enrichPlan` attaches (`RecipeSchema`,
 * recipe-mcp/schema.ts) — so it can't drift from the real produced shape. The
 * lenient READ variant used on crash-recovery resume (orchestrator/resume.ts,
 * bd6.13) IMPORTS this and layers its own read-leniency on top; this schema
 * itself stays a faithful description of the produced value (strict `day:
 * null`, no passthrough).
 *
 * A `SelectedMeal` with its full `Recipe` attached, plus (for a
 * `veg.kind:"second_dish"` meal) the second dish's own `Recipe`, plus (for a
 * meal with an optional paired `side`, bd meal-planner-8zs.8) the side's own
 * `Recipe` as `sideRecipe` — carrying its full ingredient block for the later
 * v4.0 grocery step (bd 0za) to consume.
 */
export const EnrichedMealSchema = SelectedMealSchema.extend({
  recipe: RecipeSchema,
  secondDishRecipe: RecipeSchema.optional(),
  sideRecipe: RecipeSchema.optional(),
});
export type EnrichedMeal = z.infer<typeof EnrichedMealSchema>;

/** `WeekPlan` with every meal enriched to an `EnrichedMeal`. */
export const EnrichedWeekPlanSchema = z.object({
  week_key: z.string(),
  meals: z.array(EnrichedMealSchema),
  summary: z.string().optional(),
});
export type EnrichedWeekPlan = z.infer<typeof EnrichedWeekPlanSchema>;

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
 * `secondDishRecipe`; for a meal with an optional paired `side` (8zs.8), also
 * fetches the side's `Recipe` as `sideRecipe`. A missing/null `getRecipe`
 * result for ANY of these ids fails loudly via `EnrichmentError`.
 */
export async function enrichPlan(
  plan: WeekPlan,
  deps: EnrichPlanDeps,
): Promise<EnrichedWeekPlan> {
  const { getRecipe } = deps;

  const meals = await Promise.all(
    plan.meals.map(async (meal): Promise<EnrichedMeal> => {
      const [recipe, secondDishRecipe, sideRecipe] = await Promise.all([
        fetchRecipe(meal.recipe_id, getRecipe),
        meal.veg.kind === "second_dish"
          ? fetchRecipe(meal.veg.recipe_id, getRecipe)
          : Promise.resolve(undefined),
        meal.side
          ? fetchRecipe(meal.side.recipe_id, getRecipe)
          : Promise.resolve(undefined),
      ]);

      return {
        ...meal,
        recipe,
        ...(secondDishRecipe !== undefined ? { secondDishRecipe } : {}),
        ...(sideRecipe !== undefined ? { sideRecipe } : {}),
      };
    }),
  );

  return {
    week_key: plan.week_key,
    meals,
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
  };
}
