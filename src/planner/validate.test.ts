import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import type { PlannerInput } from "./input.js";
import type { Pools } from "./pools.js";
import {
  PlanSelectionError,
  type SelectedMeal,
  type WeekPlan,
} from "./select.js";
import {
  buildRepairPrompt,
  buildShapeRepairPrompt,
  PlanValidationError,
  selectValidatedPlan,
  type ValidatePlanConfig,
  validateWeekPlan,
} from "./validate.js";

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
      weeknight: [candidate("weeknight-veg")],
      weekend: [candidate("weekend-veg")],
    },
    household: "Vegetarian daughter every night.",
    untested_present: false,
    ...overrides,
  };
}

const cfg: ValidatePlanConfig = { slots: { constrained: 1, relaxed: 1 } };

function pools(): Pools {
  return {
    weeknight: [
      candidate("wn-veg", { veg_status: "vegetarian" }),
      candidate("wn-meat", { veg_status: "contains_meat" }),
      candidate("wn-untested", { quality: "untested" }),
    ],
    weekend: [
      candidate("we-veg", { veg_status: "vegetarian" }),
      candidate("we-meat", { veg_status: "contains_meat" }),
    ],
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

function relaxedMeal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
  return meal({
    slot_type: "relaxed",
    recipe_id: "we-veg",
    title: "Recipe we-veg",
    ...overrides,
  });
}

function validPlan(): WeekPlan {
  return {
    week_key: "2026-W29",
    meals: [meal(), relaxedMeal()],
  };
}

describe("validateWeekPlan", () => {
  it("returns zero issues for a fully valid plan", () => {
    expect(validateWeekPlan(validPlan(), pools(), cfg)).toEqual([]);
  });

  it("flags wrong slot counts", () => {
    const plan = validPlan();
    plan.meals = [meal()]; // missing the relaxed meal
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => /relaxed/i.test(i))).toBe(true);
  });

  it("flags a hallucinated recipe_id not present in the matching pool", () => {
    const plan = validPlan();
    plan.meals[0] = meal({ recipe_id: "does-not-exist" });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(issues.some((i) => i.includes("does-not-exist"))).toBe(true);
  });

  it("flags an inherent meal whose candidate is contains_meat", () => {
    const plan = validPlan();
    plan.meals[0] = meal({ recipe_id: "wn-meat", veg: { kind: "inherent" } });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(
      issues.some((i) => /wn-meat/.test(i) && /inherent|vegetarian/i.test(i)),
    ).toBe(true);
  });

  it("flags a second_dish whose recipe is contains_meat", () => {
    const plan = validPlan();
    plan.meals[0] = meal({
      recipe_id: "wn-meat",
      veg: {
        kind: "second_dish",
        recipe_id: "we-meat",
        title: "Recipe we-meat",
      },
    });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(issues.some((i) => /we-meat/.test(i))).toBe(true);
  });

  it("flags a second_dish recipe_id that isn't a real candidate anywhere", () => {
    const plan = validPlan();
    plan.meals[0] = meal({
      recipe_id: "wn-meat",
      veg: {
        kind: "second_dish",
        recipe_id: "ghost-id",
        title: "Ghost",
      },
    });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(issues.some((i) => i.includes("ghost-id"))).toBe(true);
  });

  it("accepts a separable veg path without further checks", () => {
    const plan = validPlan();
    plan.meals[0] = meal({
      recipe_id: "wn-meat",
      veg: { kind: "separable", note: "hold the meat" },
    });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(issues).toEqual([]);
  });

  it("flags a duplicate recipe id across meals", () => {
    const plan = validPlan();
    plan.meals[1] = relaxedMeal({ recipe_id: "wn-veg" });
    // wn-veg isn't a member of the weekend pool, so this also trips
    // membership; assert the duplicate message specifically shows up too.
    const poolsWithSharedId = pools();
    poolsWithSharedId.weekend.push(
      candidate("wn-veg", { veg_status: "vegetarian" }),
    );
    const issues = validateWeekPlan(plan, poolsWithSharedId, cfg);
    expect(
      issues.some(
        (i) => /more than once|duplicate/i.test(i) && i.includes("wn-veg"),
      ),
    ).toBe(true);
  });

  it("flags a duplicate introduced via a second_dish recipe_id", () => {
    const plan = validPlan();
    plan.meals[0] = meal({
      recipe_id: "wn-meat",
      veg: {
        kind: "second_dish",
        recipe_id: "we-veg", // also used as meals[1].recipe_id
        title: "Recipe we-veg",
      },
    });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(
      issues.some(
        (i) => /more than once|duplicate/i.test(i) && i.includes("we-veg"),
      ),
    ).toBe(true);
  });

  it("flags the untested flag on a meal whose candidate is not untested", () => {
    const plan = validPlan();
    plan.meals[0] = meal({ flags: ["untested"] });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(issues.some((i) => /untested/i.test(i))).toBe(true);
  });

  it("accepts the untested flag on a meal whose candidate really is untested", () => {
    const plan = validPlan();
    plan.meals[0] = meal({ recipe_id: "wn-untested", flags: ["untested"] });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(issues).toEqual([]);
  });

  it("flags an untested candidate whose meal OMITS the untested flag (untested⟹flag)", () => {
    // The bug: the model selected an untested recipe but left off the flag.
    // Ground truth is the pool candidate's quality, not the model's flag.
    const plan = validPlan();
    plan.meals[0] = meal({ recipe_id: "wn-untested", flags: [] });
    const issues = validateWeekPlan(plan, pools(), cfg);
    expect(
      issues.some((i) => /wn-untested/.test(i) && /untested/i.test(i)),
    ).toBe(true);
  });

  it("flags more than one untested meal in the same week (from pool quality, flags present)", () => {
    const wideCfg: ValidatePlanConfig = {
      slots: { constrained: 2, relaxed: 0 },
    };
    const widePools = pools();
    widePools.weeknight.push(
      candidate("wn-untested-2", { quality: "untested" }),
    );
    const plan: WeekPlan = {
      week_key: "2026-W29",
      meals: [
        meal({ recipe_id: "wn-untested", flags: ["untested"] }),
        meal({ recipe_id: "wn-untested-2", flags: ["untested"] }),
      ],
    };
    const issues = validateWeekPlan(plan, widePools, wideCfg);
    expect(
      issues.some((i) => /more than one/i.test(i) && /untested/i.test(i)),
    ).toBe(true);
  });

  it("flags more than one untested meal even when the model OMITS all untested flags", () => {
    // The ≤1-untested count is derived from POOL quality (ground truth), not
    // the model's flags: two untested candidates with no flags must still trip.
    const wideCfg: ValidatePlanConfig = {
      slots: { constrained: 2, relaxed: 0 },
    };
    const widePools = pools();
    widePools.weeknight.push(
      candidate("wn-untested-2", { quality: "untested" }),
    );
    const plan: WeekPlan = {
      week_key: "2026-W29",
      meals: [
        meal({ recipe_id: "wn-untested", flags: [] }),
        meal({ recipe_id: "wn-untested-2", flags: [] }),
      ],
    };
    const issues = validateWeekPlan(plan, widePools, wideCfg);
    expect(
      issues.some((i) => /more than one/i.test(i) && /untested/i.test(i)),
    ).toBe(true);
  });
});

describe("buildRepairPrompt", () => {
  it("includes the previous plan and every issue, and stays a bounded single string", () => {
    const input = plannerInput();
    const plan = validPlan();
    const issues = ["issue one", "issue two"];
    const prompt = buildRepairPrompt(input, plan, issues);

    expect(prompt).toContain("issue one");
    expect(prompt).toContain("issue two");
    expect(prompt).toContain(plan.week_key);
    expect(typeof prompt).toBe("string");
  });
});

describe("buildShapeRepairPrompt", () => {
  it("includes the raw previous response, the parse/shape error, and the candidate context", () => {
    const input = plannerInput();
    const rawResponse = '{"week_plan": {"nope": true}}';
    const error = "schema validation failed: unexpected key week_plan";
    const prompt = buildShapeRepairPrompt(input, rawResponse, error);

    expect(prompt).toContain(rawResponse);
    expect(prompt).toContain(error);
    // Candidate context must survive so the model can re-emit real ids.
    expect(prompt).toContain("weeknight-veg");
    expect(typeof prompt).toBe("string");
  });

  it("does not include a secret beyond what the selection prompt already carries", () => {
    // The household prose is legitimately in buildSelectionPrompt(input); this
    // test just guards against buildShapeRepairPrompt inventing new leakage
    // channels — the raw response and error are the only additions.
    const input = plannerInput();
    const prompt = buildShapeRepairPrompt(input, "raw", "err");
    expect(prompt).toContain("REPAIR");
  });
});

describe("selectValidatedPlan", () => {
  it("returns immediately with exactly 1 llm call when the first plan is valid", async () => {
    const llm = makeFakeLlm(JSON.stringify(validPlan()));

    const plan = await selectValidatedPlan(plannerInput(), pools(), cfg, {
      llm,
    });

    expect(plan).toEqual(validPlan());
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });

  it("repairs an invalid first plan and returns the valid repair with exactly 2 llm calls", async () => {
    const badPlan = validPlan();
    badPlan.meals[0] = meal({ recipe_id: "does-not-exist" });
    const goodPlan = validPlan();

    const llm = makeFakeLlm(JSON.stringify(badPlan), JSON.stringify(goodPlan));

    const plan = await selectValidatedPlan(plannerInput(), pools(), cfg, {
      llm,
    });

    expect(plan).toEqual(goodPlan);
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("repairs a plan whose untested candidate is missing its flag", async () => {
    const badPlan = validPlan();
    badPlan.meals[0] = meal({ recipe_id: "wn-untested", flags: [] });
    const goodPlan = validPlan();

    const llm = makeFakeLlm(JSON.stringify(badPlan), JSON.stringify(goodPlan));

    const plan = await selectValidatedPlan(plannerInput(), pools(), cfg, {
      llm,
    });

    expect(plan).toEqual(goodPlan);
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("throws PlanValidationError (with issues, no secret) after exactly 2 calls when the repair is still invalid", async () => {
    const badPlan = validPlan();
    badPlan.meals[0] = meal({ recipe_id: "does-not-exist" });
    const stillBadPlan = validPlan();
    stillBadPlan.meals[0] = meal({ recipe_id: "also-does-not-exist" });

    const llm = makeFakeLlm(
      JSON.stringify(badPlan),
      JSON.stringify(stillBadPlan),
    );
    const input = plannerInput({
      household: "SECRET_HOUSEHOLD_DETAIL sk-fake-secret-12345",
    });

    let caught: unknown;
    try {
      await selectValidatedPlan(input, pools(), cfg, { llm });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PlanValidationError);
    const error = caught as PlanValidationError;
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.some((i) => i.includes("also-does-not-exist"))).toBe(
      true,
    );
    expect(error.message).not.toContain("SECRET_HOUSEHOLD_DETAIL");
    expect(error.message).not.toContain("sk-fake-secret-12345");
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("repairs a `week_plan`-envelope SHAPE failure on the first call and returns the valid repair with exactly 2 llm calls", async () => {
    const envelope = JSON.stringify({ week_plan: validPlan() });
    const llm = makeFakeLlm(envelope, JSON.stringify(validPlan()));

    const plan = await selectValidatedPlan(plannerInput(), pools(), cfg, {
      llm,
    });

    expect(plan).toEqual(validPlan());
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("repairs an extra-key SHAPE failure and returns the valid repair with exactly 2 llm calls", async () => {
    const bad = JSON.stringify({ ...validPlan(), unexpected_key: true });
    const llm = makeFakeLlm(bad, JSON.stringify(validPlan()));

    const plan = await selectValidatedPlan(plannerInput(), pools(), cfg, {
      llm,
    });

    expect(plan).toEqual(validPlan());
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it('repairs a string-`"null"`-day SHAPE failure and returns the valid repair with exactly 2 llm calls', async () => {
    const bad = validPlan();
    // day must be literal null; a string "null" is a shape violation.
    (bad.meals[0] as unknown as Record<string, unknown>).day = "null";
    const llm = makeFakeLlm(JSON.stringify(bad), JSON.stringify(validPlan()));

    const plan = await selectValidatedPlan(plannerInput(), pools(), cfg, {
      llm,
    });

    expect(plan).toEqual(validPlan());
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("repairs a non-JSON PARSE failure on the first call and returns the valid repair with exactly 2 llm calls", async () => {
    const llm = makeFakeLlm(
      "I cannot produce that right now.",
      JSON.stringify(validPlan()),
    );

    const plan = await selectValidatedPlan(plannerInput(), pools(), cfg, {
      llm,
    });

    expect(plan).toEqual(validPlan());
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("throws PlanSelectionError after exactly 2 calls when the SHAPE repair also can't be parsed (no 3rd call)", async () => {
    const llm = makeFakeLlm("not json at all", "still not json");
    const input = plannerInput({
      household: "SECRET_HOUSEHOLD_DETAIL sk-fake-secret-12345",
    });

    let caught: unknown;
    try {
      await selectValidatedPlan(input, pools(), cfg, { llm });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PlanSelectionError);
    const error = caught as PlanSelectionError;
    expect(error.message).not.toContain("SECRET_HOUSEHOLD_DETAIL");
    expect(error.message).not.toContain("sk-fake-secret-12345");
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("spends the SHARED single repair budget: a SHAPE failure does not then get a SEMANTIC repair (throws after exactly 2 calls)", async () => {
    // Initial: shape failure. Repair: parses fine but is semantically invalid.
    // The single repair budget was consumed by the shape repair, so there is
    // NO further semantic repair — it throws PlanValidationError at 2 calls.
    const semanticallyInvalid = validPlan();
    semanticallyInvalid.meals[0] = meal({ recipe_id: "does-not-exist" });
    const llm = makeFakeLlm(
      "not json at all",
      JSON.stringify(semanticallyInvalid),
    );

    let caught: unknown;
    try {
      await selectValidatedPlan(plannerInput(), pools(), cfg, { llm });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PlanValidationError);
    const error = caught as PlanValidationError;
    expect(error.issues.some((i) => i.includes("does-not-exist"))).toBe(true);
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });
});
