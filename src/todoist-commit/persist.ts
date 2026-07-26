import {
  type PrepUnit,
  resolvePrepUnits,
  type SelectedMeal,
  type WeekPlan,
} from "../planner/select.js";
import { prepUnitsForMeal, type TodoistCommitResult } from "./commit.js";

/**
 * `todoist_task_id` persistence + create-vs-update partitioning (bd
 * meal-planner-iu7.4, ADR-0006 D4). Two pure, storage-agnostic helpers:
 *
 *  - {@link applyTodoistCommitResult} — takes C2's `TodoistCommitResult` and
 *    returns a NEW `WeekPlan` with each meal's (and, where applicable, its
 *    second-dish's and prep units') `todoist_task_id` filled in. The caller
 *    (C4/C1, not this module) is responsible for writing the returned
 *    `WeekPlan` back onto the session row via `SessionStore.update` (the
 *    same `working_plan` JSON column `day` already rides — no new SQL
 *    column, per ADR-0006 D4).
 *  - {@link partitionMealsForRecommit} — given a stored `WeekPlan` (as read
 *    back from the session row), splits its meals into those that already
 *    carry a `todoist_task_id` (route to `TodoistClient.updateTask`,
 *    update-in-place) vs those that don't (route to `createTask`, created
 *    fresh). This module only decides the routing; the actual
 *    create/update orchestration is C4/C1.
 *
 * Neither function talks to `SessionStore` or `TodoistClient` directly —
 * both take/return plain data, matching `commit.ts`'s own "pure translator"
 * style so they're trivial to unit-test with mocked inputs.
 */

/**
 * Applies every id from a `TodoistCommitResult` onto a matching `WeekPlan`,
 * returning a NEW plan value (never mutates `plan` or any of its nested
 * arrays/objects — every touched meal/veg/prep-unit is a fresh shallow
 * copy). Meals/units the result didn't touch (e.g. `mealTask: null` because
 * `meal.day` was `null`, per `commit.ts`) are returned unchanged.
 *
 * Matches `MealCommitOutcome.prepTasks` back to `plan.prep[]` entries by
 * re-deriving the same per-meal filter (`prepUnitsForMeal`) `commit.ts` used
 * to build that array in the first place, then pairing positionally — the
 * two arrays are guaranteed the same length/order because both are produced
 * by that one filter over the same `prepUnits`.
 */
export function applyTodoistCommitResult(
  plan: WeekPlan,
  result: TodoistCommitResult,
): WeekPlan {
  const prepUnits = resolvePrepUnits(plan);
  const outcomeByMealIndex = new Map(
    result.meals.map((outcome) => [outcome.mealIndex, outcome]),
  );
  const taskIdByPrepUnit = new Map<PrepUnit, string>();

  const meals = plan.meals.map((meal, mealIndex): SelectedMeal => {
    const outcome = outcomeByMealIndex.get(mealIndex);
    if (!outcome) {
      return meal;
    }

    let updated = meal;
    if (outcome.mealTask) {
      updated = { ...updated, todoist_task_id: outcome.mealTask.taskId };
    }
    if (outcome.secondDishTask && updated.veg.kind === "second_dish") {
      updated = {
        ...updated,
        veg: { ...updated.veg, todoist_task_id: outcome.secondDishTask.taskId },
      };
    }

    if (outcome.prepTasks.length > 0) {
      const unitsForThisMeal = prepUnitsForMeal(meal, prepUnits);
      unitsForThisMeal.forEach((unit, i) => {
        const task = outcome.prepTasks[i];
        if (task) {
          taskIdByPrepUnit.set(unit, task.taskId);
        }
      });
    }

    return updated;
  });

  const prep = plan.prep?.map((unit) => {
    const taskId = taskIdByPrepUnit.get(unit);
    return taskId === undefined ? unit : { ...unit, todoist_task_id: taskId };
  });

  return {
    ...plan,
    meals,
    ...(prep !== undefined ? { prep } : {}),
  };
}

/** One meal with no stored `todoist_task_id` — a re-commit creates it fresh. */
export interface MealToCreate {
  mealIndex: number;
  meal: SelectedMeal;
}

/** One meal that already has a stored `todoist_task_id` — a re-commit updates it in place. */
export interface MealToUpdate {
  mealIndex: number;
  meal: SelectedMeal;
  todoist_task_id: string;
}

export interface PartitionedMeals {
  toCreate: MealToCreate[];
  toUpdate: MealToUpdate[];
}

/**
 * Partitions a stored `WeekPlan`'s meals by whether each already carries a
 * `todoist_task_id` (ADR-0006 D4 create-vs-update-in-place decision). A meal
 * with a stored id routes to `toUpdate` (the future re-commit caller —
 * C4/C1 — calls `TodoistClient.updateTask`); a meal without one routes to
 * `toCreate` (calls `createTask`, as `commit.ts` already does).
 *
 * Deliberately meal-level only — `secondDishTask`/`prepTasks` id presence is
 * available on each `MealToUpdate.meal` (`meal.veg.todoist_task_id` /
 * `meal.prep[].todoist_task_id` via `resolvePrepUnits`) for the orchestrator
 * to inspect per its own update-granularity needs; this helper doesn't
 * pre-split those, since the meal-level partition is what a re-commit's
 * top-level create-vs-update routing decision (ADR-0006 D4's stated scope)
 * needs.
 */
export function partitionMealsForRecommit(plan: WeekPlan): PartitionedMeals {
  const toCreate: MealToCreate[] = [];
  const toUpdate: MealToUpdate[] = [];

  plan.meals.forEach((meal, mealIndex) => {
    if (meal.todoist_task_id !== undefined) {
      toUpdate.push({ mealIndex, meal, todoist_task_id: meal.todoist_task_id });
    } else {
      toCreate.push({ mealIndex, meal });
    }
  });

  return { toCreate, toUpdate };
}
