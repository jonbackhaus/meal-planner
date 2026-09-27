import { describe, expect, it, vi } from "vitest";
import { combineRecencySources, readPlannedRecipeIds } from "./plan-memory.js";
import { SessionStore } from "./session-store.js";

const T = "2026-09-01T00:00:00.000Z";

function plan(...ids: string[]) {
  return {
    meals: ids.map((recipe_id) => ({
      recipe_id,
      title: recipe_id,
      side: { recipe_id: `side-${recipe_id}`, title: "side" },
    })),
  };
}

function seed(
  store: SessionStore,
  week_key: string,
  initial: unknown,
  extra: { working_plan?: unknown; status?: "expired" | "failed" } = {},
) {
  store.insert({
    week_key,
    status: extra.status ?? "expired",
    created_at: T,
    updated_at: T,
    initial_plan: initial,
    working_plan: extra.working_plan ?? initial,
  });
}

describe("readPlannedRecipeIds (bd meal-planner-5uy)", () => {
  it("returns main-dish ids from the last N weeks' INITIAL plans, before the given week only", () => {
    const store = new SessionStore({ path: ":memory:" });
    seed(store, "2026-08-30", plan("old"));
    seed(store, "2026-09-06", plan("a", "b"));
    seed(store, "2026-09-13", plan("b", "c"), {
      working_plan: plan("revised-away"),
    });
    seed(store, "2026-09-20", plan("current-week"));

    const ids = readPlannedRecipeIds(store, "2026-09-20", {
      lookbackWeeks: 2,
    });

    expect(ids.sort()).toEqual(["a", "b", "c"]);
    store.close();
  });

  it("skips weeks with no initial plan and malformed plans without throwing", () => {
    const store = new SessionStore({ path: ":memory:" });
    seed(store, "2026-09-06", null, { status: "failed" });
    seed(store, "2026-09-13", { meals: "nope" });
    seed(store, "2026-09-20", {
      meals: [{ recipe_id: 7 }, null, { recipe_id: "ok" }],
    });

    expect(
      readPlannedRecipeIds(store, "2026-09-27", { lookbackWeeks: 8 }),
    ).toEqual(["ok"]);
    store.close();
  });
});

describe("combineRecencySources (bd meal-planner-5uy)", () => {
  it("unions local memory with Todoist ids", async () => {
    const read = combineRecencySources({
      local: () => ["a", "b"],
      todoist: async () => ["b", "c"],
    });
    expect((await read()).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps the local memory when the Todoist read throws", async () => {
    const warn = vi.fn();
    const read = combineRecencySources({
      local: () => ["a"],
      todoist: async () => {
        throw new Error("Invalid argument value");
      },
      logger: { warn },
    });
    expect(await read()).toEqual(["a"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("works with no Todoist source configured", async () => {
    expect(await combineRecencySources({ local: () => ["a"] })()).toEqual([
      "a",
    ]);
  });
});
