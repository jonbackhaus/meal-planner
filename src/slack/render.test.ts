import { describe, expect, it } from "vitest";
import type { NightSchedule } from "../calendar/night-schedule.js";
import type { EnrichedMeal, EnrichedWeekPlan } from "../planner/enrich.js";
import type { PrepUnit } from "../planner/select.js";
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

  describe("day-ordered render (ADR 0005 D4)", () => {
    // A real week: Sunday 2026-07-26 .. Saturday 2026-08-01.
    const SUN = "2026-07-26";
    const MON = "2026-07-27";
    const TUE = "2026-07-28";
    const WED = "2026-07-29";
    const THU = "2026-07-30";
    const FRI = "2026-07-31";
    const SAT = "2026-08-01";

    function night(
      date: string,
      weekday: string,
      capacity: NightSchedule[number]["capacity"] = "FULL",
    ): NightSchedule[number] {
      return { date, weekday, capacity, blocking_events: [] };
    }

    const fullWeekSchedule: NightSchedule = [
      night(SUN, "Sunday"),
      night(MON, "Monday"),
      night(TUE, "Tuesday", "QUICK"),
      night(WED, "Wednesday"),
      night(THU, "Thursday", "NONE"),
      night(FRI, "Friday"),
      night(SAT, "Saturday"),
    ];

    it("orders meals Monday->Sunday by their ISO day, with weekday labels derived from the date", () => {
      const output = renderPlan(
        plan([
          meal({ recipe_id: "sun-1", title: "Sunday Meal", day: SUN }),
          meal({ recipe_id: "mon-1", title: "Monday Meal", day: MON }),
          meal({ recipe_id: "wed-1", title: "Wednesday Meal", day: WED }),
          meal({ recipe_id: "sat-1", title: "Saturday Meal", day: SAT }),
        ]),
      );

      expect(output).toContain("*Monday*");
      expect(output).toContain("*Wednesday*");
      expect(output).toContain("*Saturday*");
      expect(output).toContain("*Sunday*");

      const monIdx = output.indexOf("*Monday*");
      const wedIdx = output.indexOf("*Wednesday*");
      const satIdx = output.indexOf("*Saturday*");
      const sunIdx = output.indexOf("*Sunday*");

      expect(monIdx).toBeLessThan(wedIdx);
      expect(wedIdx).toBeLessThan(satIdx);
      expect(satIdx).toBeLessThan(sunIdx);

      // Meal titles land under their own weekday, in order.
      expect(output.indexOf("Monday Meal")).toBeGreaterThan(monIdx);
      expect(output.indexOf("Monday Meal")).toBeLessThan(wedIdx);
      expect(output.indexOf("Sunday Meal")).toBeGreaterThan(sunIdx);

      // The v1.0 slot headings must not appear in day-ordered mode.
      expect(output).not.toContain("*Weeknights*");
      expect(output).not.toContain("*Weekend*");
    });

    it("annotates a QUICK night's capacity from the NightSchedule", () => {
      const output = renderPlan(
        plan([
          meal({ recipe_id: "mon-1", title: "Monday Meal", day: MON }),
          meal({ recipe_id: "tue-1", title: "Tuesday Meal", day: TUE }),
        ]),
        { nightSchedule: fullWeekSchedule },
      );

      const tueIdx = output.indexOf("*Tuesday*");
      expect(tueIdx).toBeGreaterThanOrEqual(0);
      expect(output).toMatch(/\*Tuesday\*.*quick/i);

      // A FULL night (Monday) gets no capacity annotation.
      const monLineEnd = output.indexOf("\n", output.indexOf("*Monday*"));
      expect(output.slice(output.indexOf("*Monday*"), monLineEnd)).toBe(
        "*Monday*",
      );
    });

    it("shows a NONE night with no meal as a leftovers line, in its correct day position", () => {
      const output = renderPlan(
        plan([
          meal({ recipe_id: "wed-1", title: "Wednesday Meal", day: WED }),
          meal({ recipe_id: "fri-1", title: "Friday Meal", day: FRI }),
        ]),
        { nightSchedule: fullWeekSchedule },
      );

      expect(output).toMatch(/\*Thursday\*.*leftovers/i);

      const wedIdx = output.indexOf("*Wednesday*");
      const thuIdx = output.indexOf("*Thursday*");
      const friIdx = output.indexOf("*Friday*");
      expect(wedIdx).toBeLessThan(thuIdx);
      expect(thuIdx).toBeLessThan(friIdx);
    });

    it("renders a prep note ('prep Sun -> serve Tue') from WeekPlan.prep", () => {
      const prep: PrepUnit[] = [
        {
          description: "marinate the chicken",
          serve_date: TUE,
          prep_date: SUN,
        },
      ];

      const output = renderPlan(
        plan([meal({ recipe_id: "tue-1", title: "Tuesday Meal", day: TUE })]),
        { prep },
      );

      expect(output).toContain("prep Sun → serve Tue");
      expect(output).toContain("marinate the chicken");
    });

    it("omits a prep note when prep_date hasn't been placed yet (still null)", () => {
      const prep: PrepUnit[] = [
        {
          description: "marinate the chicken",
          serve_date: TUE,
          prep_date: null,
        },
      ];

      const output = renderPlan(
        plan([meal({ recipe_id: "tue-1", title: "Tuesday Meal", day: TUE })]),
        { prep },
      );

      expect(output).not.toContain("prep");
    });

    it("falls back to the unordered v1.0 slot-typed render when every meal has day: null", () => {
      const wn = meal({
        recipe_id: "wn-1",
        title: "Weeknight One",
        slot_type: "constrained",
        day: null,
      });
      const we = meal({
        recipe_id: "we-1",
        title: "Weekend One",
        slot_type: "relaxed",
        day: null,
      });

      // Even with nightSchedule/prep supplied, an all-null-day plan must
      // still render the unchanged v1.0 unordered slot-typed sections, not
      // crash, and not render blank days.
      const output = renderPlan(plan([wn, we]), {
        nightSchedule: fullWeekSchedule,
        prep: [{ description: "prep", serve_date: TUE, prep_date: SUN }],
      });

      expect(output).toContain("*Weeknights*");
      expect(output).toContain("*Weekend*");
      expect(output).toContain("Weeknight One");
      expect(output).toContain("Weekend One");
      expect(output).not.toMatch(
        /\*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\*/,
      );
    });
  });
});
