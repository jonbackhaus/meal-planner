import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import type { PlannerInput } from "./input.js";
import {
  llmSelect,
  PlanSelectionError,
  SelectedMealSchema,
  VegPathSchema,
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

  it("rejects a meal where day is not null", () => {
    expect(
      SelectedMealSchema.safeParse(inherentMeal({ day: "Monday" })).success,
    ).toBe(false);
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
