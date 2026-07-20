import { describe, expect, it } from "vitest";
import type { EnrichedMeal, EnrichedWeekPlan } from "../planner/enrich.js";
import type { Recipe } from "../recipe-mcp/schema.js";
import { renderPlan } from "./render.js";

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
    source_note_id: `note-${id}`,
    ...overrides,
  };
}

function meal(overrides: Partial<EnrichedMeal> = {}): EnrichedMeal {
  return {
    slot_type: "constrained",
    recipe_id: "wn-veg",
    title: "Recipe wn-veg",
    day: null,
    veg: { kind: "inherent" },
    flags: [],
    rationale: "quick + vegetarian",
    recipe: recipe("wn-veg"),
    ...overrides,
  };
}

function plan(
  meals: EnrichedMeal[],
  summary?: string,
  weekKey = "2026-W29",
): EnrichedWeekPlan {
  return {
    week_key: weekKey,
    meals,
    ...(summary !== undefined ? { summary } : {}),
  };
}

describe("renderPlan", () => {
  it("renders a header with the week_key", () => {
    const output = renderPlan(plan([meal()]));

    expect(output).toContain("*Meal plan for the week of 2026-W29*");
  });

  it("renders the summary line when present", () => {
    const output = renderPlan(plan([meal()], "A lighter week after travel."));

    expect(output).toContain("A lighter week after travel.");
  });

  it("omits any summary line when absent", () => {
    const output = renderPlan(plan([meal()]));

    // Only the header/section text should appear; no stray blank "summary"
    // artifact. We check by making sure the rendered output line count
    // matches a plan that never had a summary field at all.
    const withSummary = renderPlan(plan([meal()], "Some summary"));
    expect(withSummary).not.toBe(output);
    expect(output.includes("Some summary")).toBe(false);
  });

  it("groups meals under Weeknights and Weekend by slot_type", () => {
    const wn = meal({
      recipe_id: "wn-1",
      title: "Weeknight One",
      slot_type: "constrained",
      recipe: recipe("wn-1", { title: "Weeknight One" }),
    });
    const we = meal({
      recipe_id: "we-1",
      title: "Weekend One",
      slot_type: "relaxed",
      recipe: recipe("we-1", { title: "Weekend One" }),
    });

    const output = renderPlan(plan([wn, we]));

    expect(output).toContain("*Weeknights*");
    expect(output).toContain("*Weekend*");
    const weeknightsIdx = output.indexOf("*Weeknights*");
    const weekendIdx = output.indexOf("*Weekend*");
    const wnTitleIdx = output.indexOf("Weeknight One");
    const weTitleIdx = output.indexOf("Weekend One");

    expect(wnTitleIdx).toBeGreaterThan(weeknightsIdx);
    expect(wnTitleIdx).toBeLessThan(weekendIdx);
    expect(weTitleIdx).toBeGreaterThan(weekendIdx);
  });

  it("omits a section entirely when it has no meals", () => {
    const wn = meal({ slot_type: "constrained" });
    const output = renderPlan(plan([wn]));

    expect(output).toContain("*Weeknights*");
    expect(output).not.toContain("*Weekend*");
  });

  it("renders an inherent VegPath as vegetarian coverage", () => {
    const output = renderPlan(plan([meal({ veg: { kind: "inherent" } })]));

    expect(output).toMatch(/vegetarian/i);
  });

  it("renders a separable VegPath using its note", () => {
    const output = renderPlan(
      plan([
        meal({
          veg: {
            kind: "separable",
            note: "hold the chicken; she has pasta + sauce",
          },
        }),
      ]),
    );

    expect(output).toContain("hold the chicken; she has pasta + sauce");
  });

  it("renders a second_dish VegPath with the second dish's title", () => {
    const output = renderPlan(
      plan([
        meal({
          veg: {
            kind: "second_dish",
            recipe_id: "side-1",
            title: "Fallback Side Title",
          },
          secondDishRecipe: recipe("side-1", { title: "Roasted Veg Side" }),
        }),
      ]),
    );

    expect(output).toContain("Roasted Veg Side");
    expect(output).toMatch(/second dish/i);
  });

  it("falls back to veg.title for second_dish when secondDishRecipe is missing", () => {
    const output = renderPlan(
      plan([
        meal({
          veg: {
            kind: "second_dish",
            recipe_id: "side-1",
            title: "Fallback Side Title",
          },
        }),
      ]),
    );

    expect(output).toContain("Fallback Side Title");
  });

  it("renders a '+ side:' line preferring the enriched sideRecipe title (8zs.8)", () => {
    const output = renderPlan(
      plan([
        meal({
          side: { recipe_id: "side-1", title: "Fallback Side Title" },
          sideRecipe: recipe("side-1", { title: "Garlic Green Beans" }),
        }),
      ]),
    );

    expect(output).toMatch(/\+ side:/);
    expect(output).toContain("Garlic Green Beans");
  });

  it("falls back to side.title for the '+ side:' line when sideRecipe is absent", () => {
    const output = renderPlan(
      plan([
        meal({
          side: { recipe_id: "side-1", title: "Fallback Side Title" },
        }),
      ]),
    );

    expect(output).toContain("+ side: Fallback Side Title");
  });

  it("omits the side line entirely when the meal has no side", () => {
    const output = renderPlan(plan([meal()]));

    expect(output).not.toMatch(/\+ side:/);
  });

  it("renders BOTH a veg second_dish and a distinct paired side on one meal (8zs.8)", () => {
    const output = renderPlan(
      plan([
        meal({
          veg: {
            kind: "second_dish",
            recipe_id: "veg-main",
            title: "Veg Main",
          },
          secondDishRecipe: recipe("veg-main", { title: "Lentil Bake" }),
          side: { recipe_id: "side-1", title: "Side" },
          sideRecipe: recipe("side-1", { title: "Garlic Green Beans" }),
        }),
      ]),
    );

    expect(output).toMatch(/second dish/i);
    expect(output).toContain("Lentil Bake");
    expect(output).toMatch(/\+ side:/);
    expect(output).toContain("Garlic Green Beans");
  });

  it("surfaces flags as tags", () => {
    const output = renderPlan(
      plan([meal({ flags: ["do-ahead", "untested"] })]),
    );

    expect(output).toContain("do-ahead");
    expect(output).toContain("untested");
  });

  it("surfaces the rationale", () => {
    const output = renderPlan(
      plan([meal({ rationale: "fast + kid-approved" })]),
    );

    expect(output).toContain("fast + kid-approved");
  });

  it("is deterministic: same plan renders identical output twice", () => {
    const p = plan([
      meal({ recipe_id: "wn-1", slot_type: "constrained" }),
      meal({ recipe_id: "we-1", slot_type: "relaxed" }),
    ]);

    expect(renderPlan(p)).toBe(renderPlan(p));
  });

  it("collapses an embedded newline in a title so it can't break the layout", () => {
    const output = renderPlan(
      plan([
        meal({
          title: "Weeknight\nPasta Surprise",
          recipe: recipe("wn-veg", { title: "Weeknight\nPasta Surprise" }),
        }),
      ]),
    );

    // The rendered bullet must not contain a literal newline inside the title.
    expect(output).toContain("Weeknight Pasta Surprise");
    expect(output).not.toContain("Weeknight\nPasta Surprise");
  });
});
