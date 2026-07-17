import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import type { Recipe, RecipeCandidate } from "../recipe-mcp/schema.js";
import type { SearchFilters } from "../recipe-mcp/search.js";
import { buildPlan, DEFAULT_SEEDS } from "./build-plan.js";
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

  it("searches each of the default v1.0 seeds when cfg.seeds is omitted", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-W29",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: { search, llm, getRecipe },
    });

    for (const seed of DEFAULT_SEEDS) {
      expect(search).toHaveBeenCalledWith(seed, expect.anything());
    }
  });

  it("passes custom cfg.seeds to search when provided", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-W29",
      cfg: { ...baseCfg, seeds: ["custom seed a", "custom seed b"] },
      household: "Vegetarian daughter every night.",
      deps: { search, llm, getRecipe },
    });

    expect(search).toHaveBeenCalledWith("custom seed a", expect.anything());
    expect(search).toHaveBeenCalledWith("custom seed b", expect.anything());
  });

  it("threads cfg.season into BOTH the search filters (hard) and the selection prompt (soft) — bd meal-planner-8zs.9", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-W29",
      cfg: { ...baseCfg, season: "summer" },
      household: "Vegetarian daughter every night.",
      deps: { search, llm, getRecipe },
    });

    // Hard: every search call carries the season predicate.
    for (const call of search.mock.calls) {
      expect(call[1]).toMatchObject({ season: "summer" });
    }
    // Soft: the selection prompt names the current season.
    const prompt = (llm.runQuery as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .prompt as string;
    expect(prompt).toContain("summer");
  });

  it("omits the season signal entirely when cfg.season is undefined (dormant, pre-8zs.9 behavior)", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-W29",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: { search, llm, getRecipe },
    });

    for (const call of search.mock.calls) {
      expect(call[1]).not.toHaveProperty("season");
    }
    const prompt = (llm.runQuery as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .prompt as string;
    expect(prompt).not.toContain("current season");
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
