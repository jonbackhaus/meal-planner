import {
  composeTodoistRidMarker,
  type TodoistCommitConfig,
} from "../config/profile.js";
import {
  type PrepUnit,
  resolvePrepUnits,
  type SelectedMeal,
  type WeekPlan,
} from "../planner/select.js";
import type { TodoistClient } from "../todoist-mcp/todoist-client.js";
import {
  type CreatedTodoistTask,
  type MealCommitOutcome,
  prepUnitsForMeal,
  TodoistCommitConfigError,
  type TodoistCommitResult,
} from "./commit.js";
import { partitionMealsForRecommit } from "./persist.js";

/**
 * Soft-commit re-commit orchestration (bd meal-planner-iu7.5, C4, ADR-0006
 * D4): a create-OR-update translator that supersedes C2's `commitWeekPlanToTodoist`
 * (which only ever creates) for the `/mp-approved` path, so a
 * re-approval of an already-committed plan UPDATES the previously-created
 * Todoist tasks in place instead of duplicating them.
 *
 * Per-meal/second-dish/prep-unit routing is field-granular, not just
 * meal-level: {@link partitionMealsForRecommit} (C3) decides the top-level
 * meal create-vs-update split, but a meal already carrying a stored
 * `todoist_task_id` may still have a BRAND NEW second dish or prep unit
 * added by an intervening revision (v3.0) — those still need `createTask`
 * even though the parent meal's own task updates in place. Each task slot
 * (meal / second dish / prep unit) therefore makes its own create-vs-update
 * decision off its OWN stored id, mirroring `commit.ts`'s `commitOneMeal`
 * shape so the result is drop-in compatible with `persist.ts`'s
 * `applyTodoistCommitResult` (same `TodoistCommitResult`/`MealCommitOutcome`
 * shape C2 produces).
 *
 * Deliberately duplicates `commit.ts`'s small `renderTemplate`/
 * `composeDescription` helpers rather than importing them (they aren't
 * exported — `commit.ts` is C2's module and out of scope to edit for C4).
 */

/** Mirrors `commit.ts`'s own `TodoistTaskCreator`, widened to also allow `updateTask` for the update-in-place path. */
export type TodoistTaskCreatorUpdater = Pick<
  TodoistClient,
  "createTask" | "updateTask"
>;

function renderTemplate(
  template: string,
  vars: { title: string; recipeId: string },
): string {
  return template
    .replaceAll("{title}", vars.title)
    .replaceAll("{recipe_id}", vars.recipeId);
}

function composeDescription(
  config: TodoistCommitConfig,
  vars: { title: string; recipeId: string },
): string {
  const marker = composeTodoistRidMarker(vars.recipeId);
  if (config.recipeLinkFormat === "") {
    return marker;
  }
  return `${renderTemplate(config.recipeLinkFormat, vars)}\n${marker}`;
}

/**
 * Creates a fresh task when `existingTaskId` is `undefined`, else updates
 * that task in place (ADR-0006 D4) — the one place this module's
 * create-vs-update decision is made.
 */
async function createOrUpdateOneTask(
  client: TodoistTaskCreatorUpdater,
  config: TodoistCommitConfig,
  existingTaskId: string | undefined,
  vars: { title: string; recipeId: string; dueDate: string },
): Promise<CreatedTodoistTask> {
  const content = renderTemplate(config.titleTemplate, vars);
  const description = composeDescription(config, vars);
  const task = existingTaskId
    ? await client.updateTask({
        task_id: existingTaskId,
        content,
        description,
        due_date: vars.dueDate,
      })
    : await client.createTask({
        project_id: config.projectId,
        content,
        description,
        due_date: vars.dueDate,
      });
  return {
    taskId: task.id,
    recipeId: vars.recipeId,
    content,
    dueDate: vars.dueDate,
  };
}

async function recommitOneMeal(
  meal: SelectedMeal,
  mealIndex: number,
  prepUnits: PrepUnit[],
  config: TodoistCommitConfig,
  client: TodoistTaskCreatorUpdater,
): Promise<MealCommitOutcome> {
  if (meal.day === null) {
    return {
      mealIndex,
      recipeId: meal.recipe_id,
      mealTask: null,
      secondDishTask: null,
      prepTasks: [],
    };
  }

  const mealTask = await createOrUpdateOneTask(
    client,
    config,
    meal.todoist_task_id,
    { title: meal.title, recipeId: meal.recipe_id, dueDate: meal.day },
  );

  const secondDishTask =
    meal.veg.kind === "second_dish"
      ? await createOrUpdateOneTask(client, config, meal.veg.todoist_task_id, {
          title: meal.veg.title,
          recipeId: meal.veg.recipe_id,
          dueDate: meal.day,
        })
      : null;

  const prepTasks: CreatedTodoistTask[] = [];
  for (const unit of prepUnitsForMeal(meal, prepUnits)) {
    // `prepUnitsForMeal` only returns units with `prep_date !== null`.
    const prepDate = unit.prep_date as string;
    prepTasks.push(
      await createOrUpdateOneTask(client, config, unit.todoist_task_id, {
        title: unit.description,
        recipeId: meal.recipe_id,
        dueDate: prepDate,
      }),
    );
  }

  return {
    mealIndex,
    recipeId: meal.recipe_id,
    mealTask,
    secondDishTask,
    prepTasks,
  };
}

/**
 * Create-or-update translator for `/mp-approved` (both the FIRST
 * approval and any soft-commit RE-approval, ADR-0006 D4 / SPEC §7
 * "soft-commit"): routes each meal via {@link partitionMealsForRecommit}
 * (C3) to a create or update call, and further routes each meal's second
 * dish / prep units off their OWN stored ids (see module doc). A meal with
 * no stored id anywhere is created fresh — byte-for-byte the same outcome
 * C2's `commitWeekPlanToTodoist` would produce for a brand-new plan, so this
 * function is safe to use unconditionally for every approval, first or
 * re-issued.
 *
 * Returns the same `TodoistCommitResult` shape C2 returns, so the existing
 * C3 `applyTodoistCommitResult` persists the (possibly unchanged, possibly
 * newly-created) ids back onto `working_plan` with no changes needed there.
 */
export async function recommitWeekPlanToTodoist(
  plan: WeekPlan,
  config: TodoistCommitConfig,
  client: TodoistTaskCreatorUpdater,
): Promise<TodoistCommitResult> {
  if (config.projectId === "") {
    throw new TodoistCommitConfigError(
      "TodoistCommitConfig.projectId is empty — refusing to commit tasks to an unconfigured project",
    );
  }

  const prepUnits = resolvePrepUnits(plan);
  const { toCreate, toUpdate } = partitionMealsForRecommit(plan);
  const outcomeByMealIndex = new Map<number, MealCommitOutcome>();

  for (const { meal, mealIndex } of [...toCreate, ...toUpdate]) {
    outcomeByMealIndex.set(
      mealIndex,
      await recommitOneMeal(meal, mealIndex, prepUnits, config, client),
    );
  }

  const meals = plan.meals.map((_, index) => {
    const outcome = outcomeByMealIndex.get(index);
    if (!outcome) {
      throw new Error(
        `recommitWeekPlanToTodoist: missing partitioned outcome for meal index ${index}`,
      );
    }
    return outcome;
  });

  return { meals };
}
