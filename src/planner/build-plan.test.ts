import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import type { Recipe, RecipeCandidate } from "../recipe-mcp/schema.js";
import type { SearchFilters } from "../recipe-mcp/search.js";
import { buildPlan, DEFAULT_SEED_QUERY } from "./build-plan.js";
import type { SelectedMeal, WeekPlan } from "./select.js";

function candidate(
  id: string,
  overrides: Partial<RecipeCandidate> = {},
): RecipeCandidate {
  return {
    id,
    title: `Recipe ${id}`,
    time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
    effort_tags: [],
    season_tags: [],
    veg_status: "vegetarian",
    ...overrides,
  };
}

function recipe(id: string): Recipe {
  return {
    id,
    title: `Recipe ${id}`,
    time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
    effort_tags: [],
    season_tags: [],
    veg_status: "vegetarian",
    ingredients: [],
    body: "body",
    source_note_id: id,
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

function llmResult(text: string): LlmResult {
  return { text, usage: { inputTokens: 1, outputTokens: 1 } };
}

const baseCfg = {
  cookNights: { constrained: 1, relaxed: 1 },
  activeMaxMinutes: 60,
  fanoutMultiplier: 4,
  vegFloorK: 1,
  untestedRate: 0,
};

function fakeSearch() {
  return vi.fn(async (_query: string, filters?: SearchFilters) => {
    const isWeeknight = filters?.active_max !== undefined;
    return isWeeknight ? [candidate("wn-veg")] : [candidate("we-veg")];
  });
}

function planJson(): WeekPlan {
  return {
    week_key: "2026-W29",
    meals: [
      meal({ recipe_id: "wn-veg", slot_type: "constrained" }),
      meal({ recipe_id: "we-veg", slot_type: "relaxed" }),
    ],
  };
}

function fakeLlm(text: string): LlmClient {
  return { runQuery: vi.fn(async () => llmResult(text)) };
}

function fakeGetRecipe() {
  return vi.fn(async (id: string) => recipe(id));
}

describe("buildPlan", () => {
  it("chains composePools -> selectValidatedPlan -> enrichPlan into an EnrichedWeekPlan", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    const result = await buildPlan({
      weekKey: "2026-W29",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: { search, llm, getRecipe },
    });

    expect(result.week_key).toBe("2026-W29");
    expect(result.meals).toHaveLength(2);
    expect(result.meals[0].recipe).toEqual(recipe("wn-veg"));
    expect(result.meals[1].recipe).toEqual(recipe("we-veg"));
    expect(getRecipe).toHaveBeenCalledWith("wn-veg");
    expect(getRecipe).toHaveBeenCalledWith("we-veg");
  });

  it("passes the default v1.0 seed query to search when cfg.seedQuery is omitted", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-W29",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: { search, llm, getRecipe },
    });

    expect(search).toHaveBeenCalledWith(DEFAULT_SEED_QUERY, expect.anything());
  });

  it("passes a custom cfg.seedQuery to search when provided", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-W29",
      cfg: { ...baseCfg, seedQuery: "custom seed" },
      household: "Vegetarian daughter every night.",
      deps: { search, llm, getRecipe },
    });

    expect(search).toHaveBeenCalledWith("custom seed", expect.anything());
  });

  it("wires the SAME composed pools into both selection and validation: a plan referencing a non-pool id throws", async () => {
    const search = fakeSearch();
    // The LLM "selects" a recipe id that isn't in either composed pool at all,
    // and there is no repair-turned-valid response queued, so the repair also
    // fails and selectValidatedPlan's PlanValidationError propagates from
    // buildPlan without being swallowed.
    const badPlan: WeekPlan = {
      week_key: "2026-W29",
      meals: [
        meal({ recipe_id: "ghost-id", slot_type: "constrained" }),
        meal({ recipe_id: "we-veg", slot_type: "relaxed" }),
      ],
    };
    const llm: LlmClient = {
      runQuery: vi.fn(async () => llmResult(JSON.stringify(badPlan))),
    };
    const getRecipe = fakeGetRecipe();

    await expect(
      buildPlan({
        weekKey: "2026-W29",
        cfg: baseCfg,
        household: "Vegetarian daughter every night.",
        deps: { search, llm, getRecipe },
      }),
    ).rejects.toThrow(/ghost-id/);
  });
});
