import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import type { PlannerInput } from "./input.js";
import { placePrepUnits } from "./place-prep.js";
import {
  llmSelect,
  PlanSelectionError,
  PrepUnitSchema,
  resolvePrepUnits,
  SelectedMealSchema,
  sanitizeFlag,
  VegPathSchema,
  type WeekPlan,
  WeekPlanSchema,
} from "./select.js";

function llmResult(text: string): LlmResult {
  return { text, usage: { inputTokens: 1, outputTokens: 1 } };
}

function makeFakeLlm(...responses: string[]): LlmClient {
  const runQuery = vi.fn();
  for (const response of responses) {
    runQuery.mockResolvedValueOnce(llmResult(response));
  }
  return { runQuery };
}

function plannerInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    week_key: "2026-W29",
    slots: { constrained: 1, relaxed: 1 },
    pools: {
      weeknight: [],
      weekend: [],
    },
    night_schedule: [],
    household: "Vegetarian daughter every night.",
    untested_present: false,
    ...overrides,
  };
}

function inherentMeal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    slot_type: "constrained",
    recipe_id: "recipe-1",
    title: "Veggie Chili",
    day: null,
    veg: { kind: "inherent" },
    flags: [],
    rationale: "Quick, vegetarian, high quality.",
    ...overrides,
  };
}

function separableMeal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    slot_type: "relaxed",
    recipe_id: "recipe-2",
    title: "Roast Chicken",
    day: null,
    veg: { kind: "separable", note: "hold the chicken; she has pasta+sauce" },
    flags: ["do-ahead"],
    rationale: "Weekend classic, separable for the vegetarian daughter.",
    ...overrides,
  };
}

function secondDishMeal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    slot_type: "constrained",
    recipe_id: "recipe-3",
    title: "Beef Tacos",
    day: null,
    veg: {
      kind: "second_dish",
      recipe_id: "recipe-4",
      title: "Black Bean Tacos",
    },
    flags: [],
    rationale: "Not cleanly separable, so a second dish covers her.",
    ...overrides,
  };
}

function validWeekPlan() {
  return {
    week_key: "2026-W29",
    meals: [inherentMeal(), separableMeal(), secondDishMeal()],
    summary: "A varied week with one do-ahead.",
  };
}

describe("VegPathSchema", () => {
  it("accepts an inherent path", () => {
    expect(VegPathSchema.safeParse({ kind: "inherent" }).success).toBe(true);
  });

  it("accepts a separable path with a note", () => {
    expect(
      VegPathSchema.safeParse({ kind: "separable", note: "hold the chicken" })
        .success,
    ).toBe(true);
  });

  it("rejects a separable path missing its note", () => {
    expect(VegPathSchema.safeParse({ kind: "separable" }).success).toBe(false);
  });

  it("accepts a second_dish path with recipe_id and title", () => {
    expect(
      VegPathSchema.safeParse({
        kind: "second_dish",
        recipe_id: "recipe-4",
        title: "Black Bean Tacos",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(VegPathSchema.safeParse({ kind: "not-a-real-kind" }).success).toBe(
      false,
    );
  });
});

describe("sanitizeFlag (bd meal-planner-600)", () => {
  it("converts underscores to a hyphen", () => {
    expect(sanitizeFlag("do_ahead")).toBe("do-ahead");
    expect(sanitizeFlag("try_this")).toBe("try-this");
  });

  it("lowercases mixed-case and hyphenated input", () => {
    expect(sanitizeFlag("DO-AHEAD")).toBe("do-ahead");
    expect(sanitizeFlag("Do Ahead")).toBe("do-ahead");
  });

  it("trims surrounding whitespace and collapses internal whitespace runs", () => {
    expect(sanitizeFlag("  do ahead ")).toBe("do-ahead");
  });

  it("leaves an already-canonical token unchanged", () => {
    expect(sanitizeFlag("do-ahead")).toBe("do-ahead");
  });

  it("collapses repeated hyphens and strips leading/trailing hyphens", () => {
    expect(sanitizeFlag("--do--ahead--")).toBe("do-ahead");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeFlag("")).toBe("");
    expect(sanitizeFlag("   ")).toBe("");
  });
});

describe("SelectedMealSchema", () => {
  it("accepts a well-formed meal", () => {
    expect(SelectedMealSchema.safeParse(inherentMeal()).success).toBe(true);
  });

  it("rejects a bad slot_type", () => {
    expect(
      SelectedMealSchema.safeParse(inherentMeal({ slot_type: "midweek" }))
        .success,
    ).toBe(false);
  });

  it("rejects a meal missing veg", () => {
    const meal = inherentMeal();
    delete (meal as Record<string, unknown>).veg;
    expect(SelectedMealSchema.safeParse(meal).success).toBe(false);
  });

  it("accepts day: null (v1.0 back-compat / degraded no-calendar path)", () => {
    expect(
      SelectedMealSchema.safeParse(inherentMeal({ day: null })).success,
    ).toBe(true);
  });

  it("accepts a valid ISO calendar date for day (ADR-0005 D2)", () => {
    expect(
      SelectedMealSchema.safeParse(inherentMeal({ day: "2026-07-28" })).success,
    ).toBe(true);
  });

  it("rejects a weekday name for day", () => {
    expect(
      SelectedMealSchema.safeParse(inherentMeal({ day: "Monday" })).success,
    ).toBe(false);
  });

  it("rejects a full datetime for day", () => {
    expect(
      SelectedMealSchema.safeParse(
        inherentMeal({ day: "2026-07-28T00:00:00Z" }),
      ).success,
    ).toBe(false);
  });

  it("rejects a malformed date for day", () => {
    expect(
      SelectedMealSchema.safeParse(inherentMeal({ day: "2026/07/28" })).success,
    ).toBe(false);
  });

  it("normalizes an underscored 'do_ahead' flag to 'do-ahead' on parse (bd meal-planner-600 regression)", () => {
    const parsed = SelectedMealSchema.parse(
      inherentMeal({ flags: ["do_ahead"] }),
    );
    expect(parsed.flags).toEqual(["do-ahead"]);
  });

  it("dedupes flags that normalize to the same token", () => {
    const parsed = SelectedMealSchema.parse(
      inherentMeal({ flags: ["do_ahead", "do-ahead", "DO AHEAD"] }),
    );
    expect(parsed.flags).toEqual(["do-ahead"]);
  });

  it("normalizing a plan's flags at the parse boundary makes place-prep fire (bd meal-planner-600 end-to-end)", () => {
    const parsed = SelectedMealSchema.parse(
      separableMeal({ flags: ["do_ahead"], day: "2026-08-03" }),
    );
    expect(parsed.flags.includes("do-ahead")).toBe(true);

    const units = placePrepUnits(
      [parsed],
      [
        {
          date: "2026-08-01",
          weekday: "Saturday",
          capacity: "FULL",
          blocking_events: [],
        },
        {
          date: "2026-08-03",
          weekday: "Monday",
          capacity: "FULL",
          blocking_events: [],
        },
      ],
    );
    expect(units).toHaveLength(1);
    expect(units[0]?.serve_date).toBe("2026-08-03");
  });
});

describe("WeekPlanSchema", () => {
  it("accepts a valid plan with each VegPath kind represented", () => {
    const result = WeekPlanSchema.safeParse(validWeekPlan());
    expect(result.success).toBe(true);
  });

  it("accepts a plan without the optional summary", () => {
    const plan = validWeekPlan();
    delete (plan as Record<string, unknown>).summary;
    expect(WeekPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects a plan with a malformed meal", () => {
    const plan = validWeekPlan();
    plan.meals = [inherentMeal({ day: "Monday" })];
    expect(WeekPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("accepts a plan without the optional prep field (old plan back-compat, ADR 0004 D5)", () => {
    const plan = validWeekPlan();
    expect((plan as Record<string, unknown>).prep).toBeUndefined();
    expect(WeekPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("accepts a plan with a prep array (placed and unplaced units)", () => {
    const plan = {
      ...validWeekPlan(),
      prep: [
        {
          description: "Marinate the chicken",
          serve_date: "2026-07-28",
          prep_date: "2026-07-26",
        },
        {
          description: "Soak the beans",
          serve_date: "2026-07-30",
          prep_date: null,
        },
      ],
    };
    expect(WeekPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects a plan with a malformed prep unit", () => {
    const plan = {
      ...validWeekPlan(),
      prep: [
        {
          description: "Marinate the chicken",
          serve_date: "07/28/2026",
          prep_date: null,
        },
      ],
    };
    expect(WeekPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe("PrepUnitSchema", () => {
  it("accepts a prep unit with a placed (non-null) prep_date", () => {
    expect(
      PrepUnitSchema.safeParse({
        description: "Marinate the chicken",
        serve_date: "2026-07-28",
        prep_date: "2026-07-26",
      }).success,
    ).toBe(true);
  });

  it("accepts a prep unit with an unplaced (null) prep_date", () => {
    expect(
      PrepUnitSchema.safeParse({
        description: "Soak the beans",
        serve_date: "2026-07-30",
        prep_date: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a malformed serve_date", () => {
    expect(
      PrepUnitSchema.safeParse({
        description: "Marinate the chicken",
        serve_date: "2026/07/28",
        prep_date: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed prep_date", () => {
    expect(
      PrepUnitSchema.safeParse({
        description: "Marinate the chicken",
        serve_date: "2026-07-28",
        prep_date: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing description", () => {
    const unit: Record<string, unknown> = {
      description: "Marinate the chicken",
      serve_date: "2026-07-28",
      prep_date: null,
    };
    delete unit.description;
    expect(PrepUnitSchema.safeParse(unit).success).toBe(false);
  });
});

describe("resolvePrepUnits (ADR 0004 D5 forward-migration read helper, bd6.13)", () => {
  it("backfills an old plan (no prep key) to an empty array", () => {
    const plan = validWeekPlan();
    expect((plan as Record<string, unknown>).prep).toBeUndefined();
    expect(resolvePrepUnits(plan as Pick<WeekPlan, "prep">)).toEqual([]);
  });

  it("returns the plan's prep array unchanged when present", () => {
    const prep = [
      {
        description: "Marinate the chicken",
        serve_date: "2026-07-28",
        prep_date: "2026-07-26",
      },
    ];
    const plan = { ...validWeekPlan(), prep };
    expect(resolvePrepUnits(plan)).toEqual(prep);
  });
});

describe("llmSelect", () => {
  it("calls runQuery exactly once and returns the parsed WeekPlan", async () => {
    const llm = makeFakeLlm(JSON.stringify(validWeekPlan()));

    const plan = await llmSelect(plannerInput(), { llm });

    expect(plan).toEqual(validWeekPlan());
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });

  it("extracts JSON wrapped in prose and ```json fences", async () => {
    const llm = makeFakeLlm(
      `Here is the plan:\n\`\`\`json\n${JSON.stringify(validWeekPlan())}\n\`\`\`\nEnjoy!`,
    );

    const plan = await llmSelect(plannerInput(), { llm });

    expect(plan).toEqual(validWeekPlan());
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });

  it("throws PlanSelectionError when the response has no JSON at all", async () => {
    const llm = makeFakeLlm("I cannot help with that.");

    await expect(llmSelect(plannerInput(), { llm })).rejects.toThrow(
      PlanSelectionError,
    );
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });

  it("throws PlanSelectionError when the JSON doesn't match the WeekPlan shape", async () => {
    const llm = makeFakeLlm(
      JSON.stringify({ week_key: "2026-W29", meals: [{ bogus: true }] }),
    );

    await expect(llmSelect(plannerInput(), { llm })).rejects.toThrow(
      PlanSelectionError,
    );
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });

  it("does not leak the prompt or any secret-shaped text into the thrown error", async () => {
    const llm = makeFakeLlm("not json at all");
    const input = plannerInput({
      household: "SECRET_HOUSEHOLD_DETAIL sk-fake-secret-12345",
    });

    await expect(llmSelect(input, { llm })).rejects.toMatchObject({
      message: expect.not.stringContaining("SECRET_HOUSEHOLD_DETAIL"),
    });
    await expect(llmSelect(input, { llm })).rejects.toMatchObject({
      message: expect.not.stringContaining("sk-fake-secret-12345"),
    });
  });

  it("does NOT attempt a repair retry on failure (single call only)", async () => {
    const llm = makeFakeLlm("nope");

    await expect(llmSelect(plannerInput(), { llm })).rejects.toThrow();
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });
});
