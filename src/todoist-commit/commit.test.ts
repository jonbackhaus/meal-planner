import { describe, expect, it, vi } from "vitest";
import type { TodoistCommitConfig } from "../config/profile.js";
import type { PrepUnit, SelectedMeal, WeekPlan } from "../planner/select.js";
import type { TodoistTask } from "../todoist-mcp/schema.js";
import {
  commitWeekPlanToTodoist,
  TodoistCommitConfigError,
  type TodoistTaskCreator,
} from "./commit.js";

/**
 * `commitWeekPlanToTodoist` (bd meal-planner-iu7.3, ADR-0006 D2/D3): pure
 * `working_plan` -> Todoist task-write translation. Every test mocks
 * `TodoistClient.createTask` directly (no real network, no HTTP layer) —
 * `TodoistClient`'s own request-building is already covered by
 * `todoist-mcp/todoist-client.test.ts`.
 */

function config(
  overrides: Partial<TodoistCommitConfig> = {},
): TodoistCommitConfig {
  return {
    projectId: "proj-1",
    titleTemplate: "{title}",
    recipeLinkFormat: "",
    ...overrides,
  };
}

function meal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
  return {
    slot_type: "constrained",
    recipe_id: "r1",
    title: "Braised Short Ribs",
    day: "2026-08-04",
    veg: { kind: "inherent" },
    flags: [],
    rationale: "family favorite",
    ...overrides,
  };
}

function plan(meals: SelectedMeal[], prep: PrepUnit[] = []): WeekPlan {
  return {
    week_key: "2026-W32",
    meals,
    prep,
  };
}

function fakeClient(): {
  client: TodoistTaskCreator;
  createTask: ReturnType<typeof vi.fn>;
} {
  let nextId = 0;
  const createTask = vi.fn(
    async (input: {
      project_id: string;
      content: string;
      description?: string;
      due_date?: string;
    }): Promise<TodoistTask> => {
      nextId += 1;
      return {
        id: `task-${nextId}`,
        content: input.content,
        description: input.description ?? "",
        project_id: input.project_id,
        due_date: input.due_date ?? null,
        completed_at: null,
      };
    },
  );
  return { client: { createTask }, createTask };
}

describe("commitWeekPlanToTodoist", () => {
  it("creates one task per meal with the configured project, templated title, mp:rid marker, and ISO due date", async () => {
    const { client, createTask } = fakeClient();
    const weekPlan = plan([
      meal({ recipe_id: "r1", title: "Braised Short Ribs", day: "2026-08-04" }),
    ]);

    const result = await commitWeekPlanToTodoist(weekPlan, config(), client);

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith({
      project_id: "proj-1",
      content: "Braised Short Ribs",
      description: "mp:rid=r1",
      due_date: "2026-08-04",
    });
    expect(result.meals).toEqual([
      {
        mealIndex: 0,
        recipeId: "r1",
        mealTask: {
          taskId: "task-1",
          recipeId: "r1",
          content: "Braised Short Ribs",
          dueDate: "2026-08-04",
        },
        secondDishTask: null,
        prepTasks: [],
      },
    ]);
  });

  it("applies the configured titleTemplate and recipeLinkFormat", async () => {
    const { client, createTask } = fakeClient();
    const weekPlan = plan([
      meal({ recipe_id: "r1", title: "Chili", day: "2026-08-04" }),
    ]);
    const cfg = config({
      titleTemplate: "Cook: {title}",
      recipeLinkFormat: "https://example.com/recipes/{recipe_id}",
    });

    await commitWeekPlanToTodoist(weekPlan, cfg, client);

    expect(createTask).toHaveBeenCalledWith({
      project_id: "proj-1",
      content: "Cook: Chili",
      description: "https://example.com/recipes/r1\nmp:rid=r1",
      due_date: "2026-08-04",
    });
  });

  it("skips creating a task when the meal's day is null, and still returns a mapping entry", async () => {
    const { client, createTask } = fakeClient();
    const weekPlan = plan([meal({ recipe_id: "r1", day: null })]);

    const result = await commitWeekPlanToTodoist(weekPlan, config(), client);

    expect(createTask).not.toHaveBeenCalled();
    expect(result.meals).toEqual([
      {
        mealIndex: 0,
        recipeId: "r1",
        mealTask: null,
        secondDishTask: null,
        prepTasks: [],
      },
    ]);
  });

  it("creates a second task for a second_dish veg path, carrying its own mp:rid marker", async () => {
    const { client, createTask } = fakeClient();
    const weekPlan = plan([
      meal({
        recipe_id: "r1",
        title: "Steak",
        day: "2026-08-04",
        veg: { kind: "second_dish", recipe_id: "r2", title: "Veggie Stir Fry" },
      }),
    ]);

    const result = await commitWeekPlanToTodoist(weekPlan, config(), client);

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask).toHaveBeenNthCalledWith(2, {
      project_id: "proj-1",
      content: "Veggie Stir Fry",
      description: "mp:rid=r2",
      due_date: "2026-08-04",
    });
    expect(result.meals[0].secondDishTask).toEqual({
      taskId: "task-2",
      recipeId: "r2",
      content: "Veggie Stir Fry",
      dueDate: "2026-08-04",
    });
  });

  it("creates a prep task due on prep_date, marked with the parent meal's recipe id", async () => {
    const { client, createTask } = fakeClient();
    const weekPlan = plan(
      [meal({ recipe_id: "r1", title: "Chili", day: "2026-08-05" })],
      [
        {
          description: "Prep: Chili",
          serve_date: "2026-08-05",
          prep_date: "2026-08-03",
        },
      ],
    );

    const result = await commitWeekPlanToTodoist(weekPlan, config(), client);

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask).toHaveBeenNthCalledWith(2, {
      project_id: "proj-1",
      content: "Prep: Chili",
      description: "mp:rid=r1",
      due_date: "2026-08-03",
    });
    expect(result.meals[0].prepTasks).toEqual([
      {
        taskId: "task-2",
        recipeId: "r1",
        content: "Prep: Chili",
        dueDate: "2026-08-03",
      },
    ]);
  });

  it("skips an unplaced prep unit (prep_date null)", async () => {
    const { client, createTask } = fakeClient();
    const weekPlan = plan(
      [meal({ recipe_id: "r1", day: "2026-08-05" })],
      [
        {
          description: "Prep: Chili",
          serve_date: "2026-08-05",
          prep_date: null,
        },
      ],
    );

    const result = await commitWeekPlanToTodoist(weekPlan, config(), client);

    expect(createTask).toHaveBeenCalledTimes(1); // only the meal task
    expect(result.meals[0].prepTasks).toEqual([]);
  });

  it("returns a correct id-to-meal mapping across multiple meals, second dishes, and prep units", async () => {
    const { client } = fakeClient();
    const weekPlan = plan(
      [
        meal({ recipe_id: "r1", title: "Chili", day: "2026-08-05" }),
        meal({
          recipe_id: "r3",
          title: "Steak",
          day: "2026-08-06",
          veg: { kind: "second_dish", recipe_id: "r4", title: "Tofu Stir Fry" },
        }),
      ],
      [
        {
          description: "Prep: Chili",
          serve_date: "2026-08-05",
          prep_date: "2026-08-03",
        },
      ],
    );

    const result = await commitWeekPlanToTodoist(weekPlan, config(), client);

    expect(result.meals).toHaveLength(2);
    expect(result.meals[0].mealIndex).toBe(0);
    expect(result.meals[0].recipeId).toBe("r1");
    expect(result.meals[0].mealTask?.recipeId).toBe("r1");
    expect(result.meals[0].prepTasks).toHaveLength(1);
    expect(result.meals[0].prepTasks[0].recipeId).toBe("r1");

    expect(result.meals[1].mealIndex).toBe(1);
    expect(result.meals[1].recipeId).toBe("r3");
    expect(result.meals[1].mealTask?.recipeId).toBe("r3");
    expect(result.meals[1].secondDishTask?.recipeId).toBe("r4");
    expect(result.meals[1].prepTasks).toEqual([]);
  });

  it("throws TodoistCommitConfigError before any write when projectId is empty", async () => {
    const { client, createTask } = fakeClient();
    const weekPlan = plan([meal()]);

    await expect(
      commitWeekPlanToTodoist(weekPlan, config({ projectId: "" }), client),
    ).rejects.toBeInstanceOf(TodoistCommitConfigError);
    expect(createTask).not.toHaveBeenCalled();
  });
});
