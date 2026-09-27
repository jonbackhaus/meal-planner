import type { SessionStore } from "./session-store.js";

/**
 * Interim local recency memory (bd meal-planner-5uy). Until the Todoist
 * round-trip (ADR-0006, bd meal-planner-4sr) supplies real "what did we
 * actually eat" feedback, each week's INITIAL recommendation is treated as if
 * it were accepted: the main-dish `recipe_id`s of the last N weeks'
 * `initial_plan`s become recent ids for `buildPlan`'s recency dedup, so the
 * planner stops re-suggesting the same handful of recipes every week.
 *
 * Only `meals[].recipe_id` counts -- the same grain as the Todoist source
 * (one task per meal, `mp:rid=` marker). Paired sides are left out on
 * purpose: the sides pool is small and a repeated side is not the repetition
 * this memory exists to prevent.
 *
 * Read defensively: `initial_plan` is opaque JSON at the storage layer, so a
 * malformed row contributes nothing rather than failing the week.
 */

export type InitialPlanReader = Pick<SessionStore, "listInitialPlansBefore">;

export interface ReadPlannedRecipeIdsOptions {
  /** How many prior weeks to remember. */
  lookbackWeeks: number;
}

/** Deduped main-dish recipe ids from the `lookbackWeeks` weeks before `weekKey`, newest week first. */
export function readPlannedRecipeIds(
  store: InitialPlanReader,
  weekKey: string,
  options: ReadPlannedRecipeIdsOptions,
): string[] {
  const ids = new Set<string>();
  for (const { initial_plan } of store.listInitialPlansBefore(
    weekKey,
    options.lookbackWeeks,
  )) {
    const meals = (initial_plan as { meals?: unknown } | null)?.meals;
    if (!Array.isArray(meals)) {
      continue;
    }
    for (const meal of meals) {
      const id = (meal as { recipe_id?: unknown } | null)?.recipe_id;
      if (typeof id === "string" && id.length > 0) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

export interface CombineRecencySourcesDeps {
  /** Local plan memory for this week (synchronous SQLite read). */
  local: () => string[];
  /** Todoist completed-task read, when a token is configured. May throw. */
  todoist?: () => Promise<string[]>;
  logger?: Pick<Console, "warn">;
}

/**
 * Unions the local plan memory with the Todoist recency read into the single
 * `getRecentRecipeIds` `buildPlan` consumes. A Todoist failure is logged and
 * dropped here, so it can no longer wipe out the local memory along with it
 * (`buildPlan`'s own catch would otherwise discard BOTH). A local-read throw
 * still propagates to `buildPlan`'s degrade-silently catch.
 */
export function combineRecencySources(
  deps: CombineRecencySourcesDeps,
): () => Promise<string[]> {
  return async () => {
    const ids = new Set(deps.local());
    if (deps.todoist) {
      try {
        for (const id of await deps.todoist()) {
          ids.add(id);
        }
      } catch (e) {
        (deps.logger ?? console).warn(
          `Todoist recency read failed; deduping against local plan memory only: ${String(e)}`,
        );
      }
    }
    return [...ids];
  };
}
