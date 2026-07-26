import { describe, expect, it, vi } from "vitest";
import type {
  ListCompletedInput,
  ListCompletedResult,
  TodoistTask,
} from "../todoist-mcp/schema.js";
import {
  DEFAULT_RECENCY_LOOKBACK_WEEKS,
  readRecentRecipeIds,
  type TodoistCompletedTaskReader,
} from "./recency.js";

/**
 * `recency.ts` tests (bd meal-planner-v9v.1, ADR-0006 D2, SPEC §6.3). No real
 * network: `TodoistCompletedTaskReader` is a `vi.fn` stand-in for
 * `TodoistClient.listCompletedByCompletionDate`, mirroring the
 * `TodoistTaskCreator`/`TodoistTaskCreatorUpdater` DI convention in
 * `commit.test.ts`/`recommit.ts`.
 */

function task(overrides: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id: "task-1",
    content: "Tomato Soup",
    description: "mp:rid=recipe-1",
    project_id: "proj-1",
    due_date: null,
    completed_at: "2026-07-20T18:00:00.000Z",
    ...overrides,
  };
}

function fakeReader(pages: ListCompletedResult[]): {
  reader: TodoistCompletedTaskReader;
  listCompleted: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const listCompleted = vi.fn(
    async (_input: ListCompletedInput): Promise<ListCompletedResult> => {
      const page = pages[call] ?? { items: [], nextCursor: null };
      call += 1;
      return page;
    },
  );
  return {
    reader: { listCompletedByCompletionDate: listCompleted },
    listCompleted,
  };
}

describe("readRecentRecipeIds", () => {
  it("resolves marked completed tasks to their exact recipe_ids, deduped", async () => {
    const { reader } = fakeReader([
      {
        items: [
          task({ id: "t1", description: "mp:rid=recipe-1" }),
          task({ id: "t2", description: "mp:rid=recipe-2" }),
          task({
            id: "t3",
            description: "mp:rid=recipe-1",
            completed_at: "2026-07-21T18:00:00.000Z",
          }),
        ],
        nextCursor: null,
      },
    ]);

    const result = await readRecentRecipeIds(reader, {
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });

    expect(result.recipeIds.sort()).toEqual(["recipe-1", "recipe-2"]);
    expect(result.recipes).toEqual([
      { recipeId: "recipe-1", completedAt: "2026-07-20T18:00:00.000Z" },
      { recipeId: "recipe-2", completedAt: "2026-07-20T18:00:00.000Z" },
    ]);
  });

  it("skips tasks with no (or an invalid) mp:rid marker", async () => {
    const { reader } = fakeReader([
      {
        items: [
          task({ id: "t1", description: "" }),
          task({ id: "t2", description: "buy more paper towels" }),
          task({ id: "t3", description: "mp:rid=recipe-9" }),
        ],
        nextCursor: null,
      },
    ]);

    const result = await readRecentRecipeIds(reader, {
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });

    expect(result.recipeIds).toEqual(["recipe-9"]);
  });

  it("returns an empty result when there are no completed tasks", async () => {
    const { reader, listCompleted } = fakeReader([
      { items: [], nextCursor: null },
    ]);

    const result = await readRecentRecipeIds(reader, {
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });

    expect(result).toEqual({ recipeIds: [], recipes: [] });
    expect(listCompleted).toHaveBeenCalledTimes(1);
  });

  it("paginates via nextCursor until exhausted, merging resolved ids across pages", async () => {
    const { reader, listCompleted } = fakeReader([
      {
        items: [task({ id: "t1", description: "mp:rid=recipe-1" })],
        nextCursor: "cursor-2",
      },
      {
        items: [task({ id: "t2", description: "mp:rid=recipe-2" })],
        nextCursor: null,
      },
    ]);

    const result = await readRecentRecipeIds(reader, {
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });

    expect(listCompleted).toHaveBeenCalledTimes(2);
    const secondCallInput = listCompleted.mock
      .calls[1]?.[0] as ListCompletedInput;
    expect(secondCallInput.cursor).toBe("cursor-2");
    expect(result.recipeIds.sort()).toEqual(["recipe-1", "recipe-2"]);
  });

  it("computes since/until from the injected clock and the (default or overridden) lookback window", async () => {
    const { reader, listCompleted } = fakeReader([
      { items: [], nextCursor: null },
    ]);
    const now = new Date("2026-07-27T00:00:00.000Z");

    await readRecentRecipeIds(reader, { now: () => now });

    const input = listCompleted.mock.calls[0]?.[0] as ListCompletedInput;
    expect(input.until).toBe(now.toISOString());
    const expectedSince = new Date(
      now.getTime() - DEFAULT_RECENCY_LOOKBACK_WEEKS * 7 * 24 * 60 * 60 * 1000,
    );
    expect(input.since).toBe(expectedSince.toISOString());

    const { reader: reader2, listCompleted: listCompleted2 } = fakeReader([
      { items: [], nextCursor: null },
    ]);
    await readRecentRecipeIds(reader2, { now: () => now, lookbackWeeks: 2 });
    const input2 = listCompleted2.mock.calls[0]?.[0] as ListCompletedInput;
    const expectedSince2 = new Date(
      now.getTime() - 2 * 7 * 24 * 60 * 60 * 1000,
    );
    expect(input2.since).toBe(expectedSince2.toISOString());
  });
});
