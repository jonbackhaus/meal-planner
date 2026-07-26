import { describe, expect, it, vi } from "vitest";
import type { TodoistCommitConfig } from "../config/profile.js";
import type { RevisionCoordinator } from "../orchestrator/revision-coordinator.js";
import type { Session, SessionStore } from "../orchestrator/session-store.js";
import type { PrepUnit, SelectedMeal, WeekPlan } from "../planner/select.js";
import type { Recipe } from "../recipe-mcp/schema.js";
import type { ApprovedMealPlanCommand } from "../slack/slash-commands.js";
import {
  createTodoistApprovalHandler,
  resolveWorkingPlanForCommit,
  type TodoistApprovalSlackClient,
} from "./approval-handler.js";
import type { TodoistTaskCreatorUpdater } from "./recommit.js";

/**
 * `approval-handler.ts` tests (bd meal-planner-iu7.2, ADR-0006, SPEC §7). No
 * real network: `TodoistTaskCreator`/`TodoistApprovalSlackClient` are `vi.fn`
 * stand-ins, and `SessionStore` is narrowed to `get`/`update` mocks (matches
 * `revision.test.ts`'s own `Pick<SessionStore, "get">` fixture convention).
 */

function todoistConfig(
  overrides: Partial<TodoistCommitConfig> = {},
): TodoistCommitConfig {
  return {
    projectId: "proj-1",
    titleTemplate: "{title}",
    recipeLinkFormat: "",
    ...overrides,
  };
}

function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    title: `Recipe ${id}`,
    time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
    effort_tags: [],
    season_tags: [],
    veg_status: "vegetarian",
    ingredients: [],
    body: "body text",
    source_note_id: id,
    ...overrides,
  };
}

function selectedMeal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
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

/** An enriched working_plan (what `generateForWeek` actually stores) — every meal carries its `recipe`. */
function enrichedWorkingPlan(meals: SelectedMeal[] = [selectedMeal()]) {
  return {
    week_key: "2026-W32",
    meals: meals.map((m) => ({ ...m, recipe: recipe(m.recipe_id) })),
  };
}

function barePlan(meals: SelectedMeal[], prep: PrepUnit[] = []): WeekPlan {
  return { week_key: "2026-W32", meals, prep };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    week_key: "2026-W32",
    status: "suggested",
    thread_ts: "1000.0001",
    working_plan: enrichedWorkingPlan(),
    turn_count: 0,
    token_spend: 0,
    cost_usd: 0,
    created_at: "2026-08-02T06:00:00.000Z",
    updated_at: "2026-08-02T06:00:00.000Z",
    ...overrides,
  };
}

function fakeSessionStore(row: Session | null): {
  store: Pick<SessionStore, "get" | "update">;
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(() => row);
  const update = vi.fn();
  return { store: { get, update }, get, update };
}

function fakeTodoistClient(): {
  client: TodoistTaskCreatorUpdater;
  createTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
} {
  let nextId = 0;
  const createTask = vi.fn(
    async (input: { project_id: string; content: string }) => {
      nextId += 1;
      return {
        id: `task-${nextId}`,
        content: input.content,
        description: "",
        project_id: input.project_id,
        due_date: null,
        completed_at: null,
      };
    },
  );
  const updateTask = vi.fn(
    async (input: { task_id: string; content?: string }) => {
      return {
        id: input.task_id,
        content: input.content ?? "",
        description: "",
        project_id: "proj-1",
        due_date: null,
        completed_at: null,
      };
    },
  );
  return { client: { createTask, updateTask }, createTask, updateTask };
}

function fakeSlack(): {
  slack: TodoistApprovalSlackClient;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const postMessage = vi.fn(async () => ({ ok: true, ts: "2000.0001" }));
  return { slack: { chat: { postMessage } }, postMessage };
}

function command(
  overrides: Partial<ApprovedMealPlanCommand> = {},
): ApprovedMealPlanCommand {
  return {
    weekKey: "2026-W32",
    threadTs: "1000.0001",
    command: { command: "/mp-approve", user_id: "U123" },
    ...overrides,
  };
}

describe("resolveWorkingPlanForCommit", () => {
  it("returns the plan as-is (recipe fields intact) for an enriched working_plan", () => {
    const plan = resolveWorkingPlanForCommit(enrichedWorkingPlan());
    expect(plan?.meals[0]?.recipe_id).toBe("r1");
    const withRecipe = plan?.meals[0] as unknown as { recipe?: Recipe };
    expect(withRecipe.recipe?.id).toBe("r1");
  });

  it("falls back to a bare WeekPlan when the stored plan predates enrichment", () => {
    const plan = resolveWorkingPlanForCommit(barePlan([selectedMeal()]));
    expect(plan?.meals[0]?.recipe_id).toBe("r1");
  });

  it("returns null for null/unparseable input", () => {
    expect(resolveWorkingPlanForCommit(null)).toBeNull();
    expect(resolveWorkingPlanForCommit({ not: "a plan" })).toBeNull();
  });
});

describe("createTodoistApprovalHandler", () => {
  it("commits the active week's plan, persists the returned task ids, and posts a confirmation in the thread", async () => {
    const row = session();
    const { store, update } = fakeSessionStore(row);
    const { client, createTask } = fakeTodoistClient();
    const { slack, postMessage } = fakeSlack();
    const config = todoistConfig({ projectId: "proj-42" });

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: config,
      slack,
      channelId: "C-MEAL-PLAN",
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await handler.onApprove(command());

    // Commit called with the right plan + config.
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-42",
        content: "Braised Short Ribs",
        due_date: "2026-08-04",
      }),
    );

    // Persisted the returned id + `committed` status back via SessionStore.update
    // (ADR-0002 transition discipline, C4).
    expect(update).toHaveBeenCalledTimes(1);
    const [weekKey, patch] = update.mock.calls[0] as [
      string,
      { working_plan: WeekPlan; status: string; updated_at: string },
    ];
    expect(weekKey).toBe("2026-W32");
    expect(patch.working_plan.meals[0]?.todoist_task_id).toBe("task-1");
    expect(patch.status).toBe("committed");
    expect(patch.updated_at).toBe("2026-08-02T12:00:00.000Z");

    // Confirmation posted as a follow-up in the session thread.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-MEAL-PLAN",
        thread_ts: "1000.0001",
        text: expect.stringContaining("Committed 1 meal"),
      }),
    );
  });

  it("handles a plan with no meals gracefully (no crash, still confirms zero commits)", async () => {
    const row = session({ working_plan: enrichedWorkingPlan([]) });
    const { store, update } = fakeSessionStore(row);
    const { client, createTask } = fakeTodoistClient();
    const { slack, postMessage } = fakeSlack();

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: todoistConfig(),
      slack,
      channelId: "C-MEAL-PLAN",
    });

    await expect(handler.onApprove(command())).resolves.toBeUndefined();

    expect(createTask).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Committed 0 meals"),
      }),
    );
  });

  it("no-ops gracefully when there is no active-week session row", async () => {
    const { store, update } = fakeSessionStore(null);
    const { client, createTask } = fakeTodoistClient();
    const { slack, postMessage } = fakeSlack();

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: todoistConfig(),
      slack,
      channelId: "C-MEAL-PLAN",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(handler.onApprove(command())).resolves.toBeUndefined();

    expect(createTask).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("no-ops gracefully when the session row has no usable working_plan yet (still generating)", async () => {
    const row = session({ working_plan: null, status: "generating" });
    const { store, update } = fakeSessionStore(row);
    const { client, createTask } = fakeTodoistClient();
    const { slack, postMessage } = fakeSlack();

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: todoistConfig(),
      slack,
      channelId: "C-MEAL-PLAN",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(handler.onApprove(command())).resolves.toBeUndefined();

    expect(createTask).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("logs but does not throw when the confirmation post fails after a successful commit", async () => {
    const row = session();
    const { store, update } = fakeSessionStore(row);
    const { client } = fakeTodoistClient();
    const postMessage = vi.fn(async () => {
      throw new Error("slack unreachable");
    });
    const errorLog = vi.fn();

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: todoistConfig(),
      slack: { chat: { postMessage } },
      channelId: "C-MEAL-PLAN",
      logger: { log: vi.fn(), warn: vi.fn(), error: errorLog },
    });

    await expect(handler.onApprove(command())).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("confirmation post failed"),
    );
  });

  it("supersedes any in-flight revision (bd meal-planner-3e2.5, ADR 0007 D4) as its first action, even before the no-session/no-plan early returns", async () => {
    const { store } = fakeSessionStore(null);
    const { client } = fakeTodoistClient();
    const { slack } = fakeSlack();
    const supersede = vi.fn();
    const revisionCoordinator: Pick<RevisionCoordinator, "supersede"> = {
      supersede,
    };

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: todoistConfig(),
      slack,
      channelId: "C-MEAL-PLAN",
      revisionCoordinator,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.onApprove(command({ weekKey: "2026-W32" }));

    expect(supersede).toHaveBeenCalledWith("2026-W32");
    expect(supersede).toHaveBeenCalledTimes(1);
  });

  it("commits normally when no revisionCoordinator is injected (optional dep)", async () => {
    const row = session();
    const { store, update } = fakeSessionStore(row);
    const { client, createTask } = fakeTodoistClient();
    const { slack, postMessage } = fakeSlack();

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: todoistConfig(),
      slack,
      channelId: "C-MEAL-PLAN",
    });

    await expect(handler.onApprove(command())).resolves.toBeUndefined();

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("soft-commit RE-approval (bd meal-planner-iu7.5, C4, ADR-0006 D4): updates in place for meals with a stored todoist_task_id, creates only the genuinely-new ones, and stays `committed` (no duplicate tasks)", async () => {
    const existingMeal = selectedMeal({
      recipe_id: "r1",
      title: "Braised Short Ribs",
      day: "2026-08-04",
      todoist_task_id: "task-existing",
    });
    const newMeal = selectedMeal({
      recipe_id: "r2",
      title: "Veggie Stir Fry",
      day: "2026-08-05",
    });
    // Already `committed` (a prior approval ran) -- the soft-commit self-loop
    // (ADR-0002 "re-approve", `committed -> committed`) must also succeed.
    const row = session({
      status: "committed",
      working_plan: enrichedWorkingPlan([existingMeal, newMeal]),
    });
    const { store, update } = fakeSessionStore(row);
    const { client, createTask, updateTask } = fakeTodoistClient();
    const { slack, postMessage } = fakeSlack();
    const config = todoistConfig({ projectId: "proj-42" });

    const handler = createTodoistApprovalHandler({
      sessionStore: store,
      todoistClient: client,
      todoistConfig: config,
      slack,
      channelId: "C-MEAL-PLAN",
      now: () => new Date("2026-08-02T13:00:00.000Z"),
    });

    await handler.onApprove(command());

    // The already-committed meal is UPDATED IN PLACE, not re-created.
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "task-existing",
        content: "Braised Short Ribs",
        due_date: "2026-08-04",
      }),
    );

    // Only the genuinely-new meal is created fresh -- one call, not two.
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-42",
        content: "Veggie Stir Fry",
        due_date: "2026-08-05",
      }),
    );

    // Persisted ids: the existing task id is preserved, the new one is added.
    expect(update).toHaveBeenCalledTimes(1);
    const [weekKey, patch] = update.mock.calls[0] as [
      string,
      { working_plan: WeekPlan; status: string; updated_at: string },
    ];
    expect(weekKey).toBe("2026-W32");
    expect(patch.status).toBe("committed");
    expect(patch.working_plan.meals[0]?.todoist_task_id).toBe("task-existing");
    expect(patch.working_plan.meals[1]?.todoist_task_id).toBe("task-1");

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Committed 2 meals"),
      }),
    );
  });
});
