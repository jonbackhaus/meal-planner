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

/**
 * v3.0 commit write translator (bd meal-planner-iu7.3, ADR-0006 D2/D3): pure
 * `working_plan` -> Todoist task-write translator, called deterministically
 * from the (not-yet-built) `/mealplan-approved` handler — no LLM call, no
 * MCP round-trip (a commit is code-driven; see ADR-0006 D3's interface
 * sketch). Reuses the C0 `TodoistClient` directly and the C5
 * `composeTodoistRidMarker` helper so the marker string has one definition.
 *
 * Only the subset of `TodoistClient` this module needs — narrowing the
 * parameter type lets tests substitute a plain mock instead of constructing a
 * real client (structural typing; `TodoistClient`'s private fields would
 * otherwise force a nominal match).
 *
 * Scope note (bd meal-planner-iu7.3): this module only CREATES tasks and
 * returns the created ids mapped back to their meal/second-dish/prep origin.
 * Persisting `todoist_task_id` into the stored `working_plan` (ADR-0006 D4)
 * is bd meal-planner-iu7.4 (C3); update-in-place re-commit (reading a
 * previously stored `todoist_task_id` and calling `client.updateTask`
 * instead of creating a fresh task) is bd meal-planner-iu7.5 (C4) — a future
 * re-commit path would branch here, before `createOneTask`, on whether the
 * caller already has a task id for that meal/second-dish/prep slot.
 */
export type TodoistTaskCreator = Pick<TodoistClient, "createTask">;

/** One task actually created by a commit call. */
export interface CreatedTodoistTask {
  taskId: string;
  recipeId: string;
  content: string;
  dueDate: string;
}

/**
 * Per-meal outcome of a commit call, so the caller (C3) can persist
 * `todoist_task_id` (ADR-0006 D4) back onto the right `WeekPlan.meals[]`
 * entry via `mealIndex`.
 */
export interface MealCommitOutcome {
  /** Index into the committed `WeekPlan.meals` array. */
  mealIndex: number;
  recipeId: string;
  /**
   * `null` when `meal.day` is `null` (the ADR-0005 legacy/degraded-path
   * meaning) — there is no ISO date to set as the task's `due_date`, so no
   * task is created for this meal (and, for consistency, no `second_dish`
   * or prep task either — see module doc).
   */
  mealTask: CreatedTodoistTask | null;
  /** Set only when `meal.veg.kind === "second_dish"` AND `mealTask` was created. */
  secondDishTask: CreatedTodoistTask | null;
  /**
   * One entry per placed (`prep_date !== null`) `PrepUnit` whose
   * `serve_date` matches this meal's `day`. An unplaced prep unit
   * (`prep_date === null`) has no due date to write and is skipped.
   */
  prepTasks: CreatedTodoistTask[];
}

export interface TodoistCommitResult {
  meals: MealCommitOutcome[];
}

/** Thrown when `config.projectId` is empty — per `profile.ts`'s own doc
 * comment, an empty `projectId` is a valid *resolved* value (no env var set
 * yet) but a misconfiguration for any actual commit consumer. Fails closed
 * rather than writing tasks into an unspecified project. */
export class TodoistCommitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoistCommitConfigError";
  }
}

/** Renders `{title}` / `{recipe_id}` placeholders in a config template
 * (`titleTemplate` / `recipeLinkFormat`) — the only two placeholders either
 * field's doc comment / tests reference. */
function renderTemplate(
  template: string,
  vars: { title: string; recipeId: string },
): string {
  return template
    .replaceAll("{title}", vars.title)
    .replaceAll("{recipe_id}", vars.recipeId);
}

/** Composes a task's description: the optional config link line, then the
 * `mp:rid=` marker (ADR-0006 D2) on its own line. */
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

async function createOneTask(
  client: TodoistTaskCreator,
  config: TodoistCommitConfig,
  vars: { title: string; recipeId: string; dueDate: string },
): Promise<CreatedTodoistTask> {
  const content = renderTemplate(config.titleTemplate, vars);
  const task = await client.createTask({
    project_id: config.projectId,
    content,
    description: composeDescription(config, vars),
    due_date: vars.dueDate,
  });
  return {
    taskId: task.id,
    recipeId: vars.recipeId,
    content,
    dueDate: vars.dueDate,
  };
}

/**
 * Exported so `persist.ts` (bd meal-planner-iu7.4, C3) can reconstruct the
 * exact same meal->prep-unit matching/order when writing `todoist_task_id`s
 * back onto `plan.prep[]` from a `MealCommitOutcome.prepTasks` array — a
 * second, drifting copy of this filter would risk mismatching ids to units.
 */
export function prepUnitsForMeal(
  meal: SelectedMeal,
  prepUnits: PrepUnit[],
): PrepUnit[] {
  if (meal.day === null) {
    return [];
  }
  return prepUnits.filter(
    (unit) => unit.serve_date === meal.day && unit.prep_date !== null,
  );
}

async function commitOneMeal(
  meal: SelectedMeal,
  mealIndex: number,
  prepUnits: PrepUnit[],
  config: TodoistCommitConfig,
  client: TodoistTaskCreator,
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

  const mealTask = await createOneTask(client, config, {
    title: meal.title,
    recipeId: meal.recipe_id,
    dueDate: meal.day,
  });

  const secondDishTask =
    meal.veg.kind === "second_dish"
      ? await createOneTask(client, config, {
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
      await createOneTask(client, config, {
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
 * Deterministically translates a `WeekPlan` into Todoist task-creation calls
 * per ADR-0006 D3, one meal at a time (sequential — the family-sized weekly
 * task count is tiny, and sequential keeps a partial-failure's already-created
 * tasks easy to reason about). Returns the created task ids mapped back to
 * their originating meal so the caller (bd meal-planner-iu7.4) can persist
 * `todoist_task_id` into the stored `working_plan`.
 *
 * Throws `TodoistCommitConfigError` before any write if `config.projectId`
 * is empty. Any `TodoistApiError` from `client.createTask` propagates
 * unwrapped (mirrors `TodoistClient`'s own "throw, don't degrade" contract
 * for a real write) — the caller decides how to handle a partial commit.
 */
export async function commitWeekPlanToTodoist(
  plan: WeekPlan,
  config: TodoistCommitConfig,
  client: TodoistTaskCreator,
): Promise<TodoistCommitResult> {
  if (config.projectId === "") {
    throw new TodoistCommitConfigError(
      "TodoistCommitConfig.projectId is empty — refusing to commit tasks to an unconfigured project",
    );
  }

  const prepUnits = resolvePrepUnits(plan);
  const meals: MealCommitOutcome[] = [];
  for (let index = 0; index < plan.meals.length; index++) {
    meals.push(
      await commitOneMeal(plan.meals[index], index, prepUnits, config, client),
    );
  }

  return { meals };
}
