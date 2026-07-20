import { describe, expect, it, vi } from "vitest";
import type { Recipe } from "../recipe-mcp/schema.js";
import {
  EnrichedWeekPlanSchema,
  EnrichmentError,
  enrichPlan,
} from "./enrich.js";
import type { SelectedMeal, WeekPlan } from "./select.js";

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

function meal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
  return {
    slot_type: "constrained",
    recipe_id: "wn-veg",
    title: "Recipe wn-veg",
    day: null,
    veg: { kind: "inherent" },
    flags: [],
    rationale: "quick + vegetarian",
    ...overrides,
  };
}

function plan(meals: SelectedMeal[], summary?: string): WeekPlan {
  return {
    week_key: "2026-W29",
    meals,
    ...(summary !== undefined ? { summary } : {}),
  };
}

describe("enrichPlan", () => {
  it("attaches the full Recipe to each meal", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([
      meal({ recipe_id: "wn-veg" }),
      meal({ recipe_id: "we-veg", slot_type: "relaxed" }),
    ]);

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    expect(enriched.week_key).toBe("2026-W29");
    expect(enriched.meals).toHaveLength(2);
    expect(enriched.meals[0].recipe).toEqual(recipe("wn-veg"));
    expect(enriched.meals[1].recipe).toEqual(recipe("we-veg"));
  });

  it("attaches secondDishRecipe for a second_dish meal", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([
      meal({
        recipe_id: "wn-meat",
        veg: { kind: "second_dish", recipe_id: "wn-veg-side", title: "Side" },
      }),
    ]);

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    expect(enriched.meals[0].recipe).toEqual(recipe("wn-meat"));
    expect(enriched.meals[0].secondDishRecipe).toEqual(recipe("wn-veg-side"));
  });

  it("attaches sideRecipe when the meal has an optional paired side (8zs.8)", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([
      meal({
        recipe_id: "wn-meat",
        side: { recipe_id: "cornbread", title: "Cornbread" },
      }),
    ]);

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    expect(enriched.meals[0].recipe).toEqual(recipe("wn-meat"));
    expect(enriched.meals[0].sideRecipe).toEqual(recipe("cornbread"));
    // The selection-time `side` reference is preserved alongside the full recipe.
    expect(enriched.meals[0].side).toEqual({
      recipe_id: "cornbread",
      title: "Cornbread",
    });
    expect(getRecipe).toHaveBeenCalledWith("cornbread");
  });

  it("attaches both secondDishRecipe and sideRecipe when a meal has both", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([
      meal({
        recipe_id: "wn-meat",
        veg: { kind: "second_dish", recipe_id: "veg-main", title: "Veg Main" },
        side: { recipe_id: "cornbread", title: "Cornbread" },
      }),
    ]);

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    expect(enriched.meals[0].secondDishRecipe).toEqual(recipe("veg-main"));
    expect(enriched.meals[0].sideRecipe).toEqual(recipe("cornbread"));
  });

  it("throws EnrichmentError naming the id when getRecipe returns null for a side id", async () => {
    const getRecipe = vi.fn(async (id: string) =>
      id === "cornbread" ? null : recipe(id),
    );
    const weekPlan = plan([
      meal({
        recipe_id: "wn-meat",
        side: { recipe_id: "cornbread", title: "Cornbread" },
      }),
    ]);

    await expect(enrichPlan(weekPlan, { getRecipe })).rejects.toThrow(
      EnrichmentError,
    );
    await expect(enrichPlan(weekPlan, { getRecipe })).rejects.toThrow(
      /cornbread/,
    );
  });

  it("does not set secondDishRecipe for a non-second_dish meal", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([meal()]);

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    expect(enriched.meals[0].secondDishRecipe).toBeUndefined();
    expect(enriched.meals[0].sideRecipe).toBeUndefined();
  });

  it("calls getRecipe once per chosen id, including second dishes", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([
      meal({
        recipe_id: "wn-meat",
        veg: { kind: "second_dish", recipe_id: "wn-side", title: "Side" },
      }),
      meal({ recipe_id: "we-veg", slot_type: "relaxed" }),
    ]);

    await enrichPlan(weekPlan, { getRecipe });

    expect(getRecipe).toHaveBeenCalledTimes(3);
    expect(getRecipe).toHaveBeenCalledWith("wn-meat");
    expect(getRecipe).toHaveBeenCalledWith("wn-side");
    expect(getRecipe).toHaveBeenCalledWith("we-veg");
  });

  it("throws EnrichmentError naming the id when getRecipe returns null for a selected meal id", async () => {
    const getRecipe = vi.fn(async (id: string) =>
      id === "wn-veg" ? null : recipe(id),
    );
    const weekPlan = plan([meal({ recipe_id: "wn-veg" })]);

    await expect(enrichPlan(weekPlan, { getRecipe })).rejects.toThrow(
      EnrichmentError,
    );
    await expect(enrichPlan(weekPlan, { getRecipe })).rejects.toThrow(/wn-veg/);
  });

  it("throws EnrichmentError naming the id when getRecipe returns null for a second_dish id", async () => {
    const getRecipe = vi.fn(async (id: string) =>
      id === "wn-side" ? null : recipe(id),
    );
    const weekPlan = plan([
      meal({
        recipe_id: "wn-meat",
        veg: { kind: "second_dish", recipe_id: "wn-side", title: "Side" },
      }),
    ]);

    await expect(enrichPlan(weekPlan, { getRecipe })).rejects.toThrow(
      EnrichmentError,
    );
    await expect(enrichPlan(weekPlan, { getRecipe })).rejects.toThrow(
      /wn-side/,
    );
  });

  it("preserves the plan summary when present", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([meal()], "a fine week of meals");

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    expect(enriched.summary).toBe("a fine week of meals");
  });
});

describe("EnrichedWeekPlanSchema (canonical, bd6.8)", () => {
  it("parses a real enrichPlan output", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan(
      [
        meal({ recipe_id: "wn-veg" }),
        meal({
          recipe_id: "wn-meat",
          slot_type: "relaxed",
          veg: { kind: "second_dish", recipe_id: "wn-side", title: "Side" },
        }),
      ],
      "a fine week of meals",
    );

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    const result = EnrichedWeekPlanSchema.safeParse(enriched);
    expect(result.success).toBe(true);
  });

  it("parses an enrichPlan output carrying an optional paired side (8zs.8)", async () => {
    const getRecipe = vi.fn(async (id: string) => recipe(id));
    const weekPlan = plan([
      meal({
        recipe_id: "wn-meat",
        side: { recipe_id: "cornbread", title: "Cornbread" },
      }),
    ]);

    const enriched = await enrichPlan(weekPlan, { getRecipe });

    const result = EnrichedWeekPlanSchema.safeParse(enriched);
    expect(result.success).toBe(true);
  });

  it("rejects a plan whose meal is missing its enriched recipe", () => {
    const result = EnrichedWeekPlanSchema.safeParse({
      week_key: "2026-W29",
      meals: [meal({ recipe_id: "wn-veg" })], // no `recipe` attached
    });
    expect(result.success).toBe(false);
  });

  it("rejects a plan missing its meals array", () => {
    const result = EnrichedWeekPlanSchema.safeParse({ week_key: "2026-W29" });
    expect(result.success).toBe(false);
  });
});
