import { describe, expect, it } from "vitest";
import { resumeQuietly } from "../orchestrator/resume.js";
import { SessionStore } from "../orchestrator/session-store.js";
import type { PrepUnit, SelectedMeal, WeekPlan } from "../planner/select.js";
import type { TodoistCommitResult } from "./commit.js";
import {
  applyTodoistCommitResult,
  partitionMealsForRecommit,
} from "./persist.js";

/**
 * `applyTodoistCommitResult` / `partitionMealsForRecommit` (bd
 * meal-planner-iu7.4, ADR-0006 D4). No real network — `TodoistCommitResult`
 * inputs are hand-built fixtures (as C2's own `commit.test.ts` would
 * produce), and the round-trip test uses a real `:memory:` `SessionStore`
 * (matches `session-store.test.ts`'s own convention), not a mock HTTP layer.
 */

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

describe("applyTodoistCommitResult", () => {
  it("persists a meal's todoist_task_id from a CreatedTodoistTask outcome", () => {
    const weekPlan = plan([meal({ recipe_id: "r1" })]);
    const result: TodoistCommitResult = {
      meals: [
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
      ],
    };

    const updated = applyTodoistCommitResult(weekPlan, result);

    expect(updated.meals[0].todoist_task_id).toBe("task-1");
    // Never mutates the input.
    expect(weekPlan.meals[0].todoist_task_id).toBeUndefined();
  });

  it("persists a second_dish veg path's own todoist_task_id", () => {
    const weekPlan = plan([
      meal({
        recipe_id: "r1",
        veg: { kind: "second_dish", recipe_id: "r2", title: "Veggie Stir Fry" },
      }),
    ]);
    const result: TodoistCommitResult = {
      meals: [
        {
          mealIndex: 0,
          recipeId: "r1",
          mealTask: {
            taskId: "task-1",
            recipeId: "r1",
            content: "Braised Short Ribs",
            dueDate: "2026-08-04",
          },
          secondDishTask: {
            taskId: "task-2",
            recipeId: "r2",
            content: "Veggie Stir Fry",
            dueDate: "2026-08-04",
          },
          prepTasks: [],
        },
      ],
    };

    const updated = applyTodoistCommitResult(weekPlan, result);

    expect(updated.meals[0].todoist_task_id).toBe("task-1");
    const veg = updated.meals[0].veg;
    expect(veg.kind === "second_dish" ? veg.todoist_task_id : undefined).toBe(
      "task-2",
    );
  });

  it("matches prepTasks back onto plan.prep[] via the same meal->prep-unit filter commit.ts used", () => {
    const weekPlan = plan(
      [meal({ recipe_id: "r1", day: "2026-08-05" })],
      [
        {
          description: "Prep: Chili",
          serve_date: "2026-08-05",
          prep_date: "2026-08-03",
        },
        // A prep unit belonging to no meal in this fixture (serve_date
        // doesn't match) must be left untouched.
        {
          description: "Prep: Unrelated",
          serve_date: "2026-08-09",
          prep_date: "2026-08-07",
        },
      ],
    );
    const result: TodoistCommitResult = {
      meals: [
        {
          mealIndex: 0,
          recipeId: "r1",
          mealTask: {
            taskId: "task-1",
            recipeId: "r1",
            content: "Chili",
            dueDate: "2026-08-05",
          },
          secondDishTask: null,
          prepTasks: [
            {
              taskId: "task-2",
              recipeId: "r1",
              content: "Prep: Chili",
              dueDate: "2026-08-03",
            },
          ],
        },
      ],
    };

    const updated = applyTodoistCommitResult(weekPlan, result);

    expect(updated.prep?.[0].todoist_task_id).toBe("task-2");
    expect(updated.prep?.[1].todoist_task_id).toBeUndefined();
  });

  it("leaves a meal with no matching outcome (e.g. day: null, skipped by commit.ts) unchanged", () => {
    const weekPlan = plan([meal({ recipe_id: "r1", day: null })]);
    const result: TodoistCommitResult = {
      meals: [
        {
          mealIndex: 0,
          recipeId: "r1",
          mealTask: null,
          secondDishTask: null,
          prepTasks: [],
        },
      ],
    };

    const updated = applyTodoistCommitResult(weekPlan, result);

    expect(updated.meals[0].todoist_task_id).toBeUndefined();
  });

  it("survives a SessionStore round trip (JSON serialize/deserialize)", () => {
    const store = new SessionStore({ path: ":memory:" });
    try {
      const weekPlan = plan([meal({ recipe_id: "r1" })]);
      const result: TodoistCommitResult = {
        meals: [
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
        ],
      };
      const updated = applyTodoistCommitResult(weekPlan, result);

      store.insert({
        week_key: "2026-W32",
        status: "committed",
        created_at: "2026-08-04T06:00:00.000Z",
        updated_at: "2026-08-04T06:00:00.000Z",
        working_plan: updated,
      });

      const row = store.get("2026-W32");
      const roundTripped = row?.working_plan as WeekPlan;
      expect(roundTripped.meals[0].todoist_task_id).toBe("task-1");
    } finally {
      store.close();
    }
  });

  it("resume-safe: a legacy row whose working_plan predates commit (no todoist_task_id anywhere) still loads via resumeQuietly", () => {
    const store = new SessionStore({ path: ":memory:" });
    try {
      // `resumeQuietly` validates against the ENRICHED shape (a `recipe`
      // attached per meal), not the raw `WeekPlan` — so this fixture needs
      // that field, unlike the pre-enrich fixtures used elsewhere in this
      // file (matches resume.test.ts's own `makeValidWorkingPlan` pattern).
      const legacyWorkingPlan = {
        week_key: "2026-W32",
        meals: [
          {
            slot_type: "constrained" as const,
            recipe_id: "r1",
            title: "Braised Short Ribs",
            day: null,
            veg: { kind: "inherent" as const },
            flags: [],
            rationale: "family favorite",
            recipe: {
              id: "r1",
              title: "Braised Short Ribs",
              time: { active: 20, total: 180, prep: 10, confidence: 0.9 },
              effort_tags: [],
              season_tags: [],
              veg_status: "contains_meat" as const,
              ingredients: [],
              source_note_id: "note-r1",
            },
          },
        ],
      };
      store.insert({
        week_key: "2026-W32",
        status: "suggested",
        created_at: "2026-08-04T06:00:00.000Z",
        updated_at: "2026-08-04T06:00:00.000Z",
        working_plan: legacyWorkingPlan,
      });

      const row = store.get("2026-W32");
      expect(row).not.toBeNull();
      const active = resumeQuietly(row as NonNullable<typeof row>);

      expect(active.working_plan?.meals[0].todoist_task_id).toBeUndefined();
      expect(active.working_plan?.meals[0].recipe_id).toBe("r1");
    } finally {
      store.close();
    }
  });
});

describe("partitionMealsForRecommit", () => {
  it("routes a meal with an existing todoist_task_id to toUpdate, and one without to toCreate", () => {
    const weekPlan = plan([
      meal({ recipe_id: "r1", todoist_task_id: "task-1" }),
      meal({ recipe_id: "r2" }),
    ]);

    const { toCreate, toUpdate } = partitionMealsForRecommit(weekPlan);

    expect(toUpdate).toEqual([
      {
        mealIndex: 0,
        meal: weekPlan.meals[0],
        todoist_task_id: "task-1",
      },
    ]);
    expect(toCreate).toEqual([{ mealIndex: 1, meal: weekPlan.meals[1] }]);
  });

  it("returns an empty toUpdate when no meal has a stored id (a fresh, never-committed plan)", () => {
    const weekPlan = plan([
      meal({ recipe_id: "r1" }),
      meal({ recipe_id: "r2" }),
    ]);

    const { toCreate, toUpdate } = partitionMealsForRecommit(weekPlan);

    expect(toUpdate).toEqual([]);
    expect(toCreate).toHaveLength(2);
  });
});
