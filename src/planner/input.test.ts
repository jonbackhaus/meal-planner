import { describe, expect, it } from "vitest";
import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import {
  buildPlannerInput,
  buildSelectionPrompt,
  type PlannerInput,
} from "./input.js";

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
    veg_status: "contains_meat",
    ...overrides,
  };
}

const HOUSEHOLD_PROSE =
  "Vegetarian daughter (hard, every night). Picky youngest likes pasta " +
  "and plain proteins, dislikes strong spices. Smaller appetites overall. " +
  "Cook 5-6 nights/week.";

describe("buildPlannerInput", () => {
  const baseArgs = {
    weekKey: "2026-W29",
    slots: { constrained: 4, relaxed: 2 },
    household: HOUSEHOLD_PROSE,
  };

  it("assembles week_key, slots, pools, and household verbatim", () => {
    const pools = {
      weeknight: [candidate("wn-1")],
      weekend: [candidate("we-1")],
    };

    const input = buildPlannerInput({ ...baseArgs, pools });

    expect(input.week_key).toBe("2026-W29");
    expect(input.slots).toEqual({ constrained: 4, relaxed: 2 });
    expect(input.pools).toBe(pools);
    expect(input.household).toBe(HOUSEHOLD_PROSE);
  });

  it("computes untested_present true when a pool has an untested candidate", () => {
    const pools = {
      weeknight: [candidate("wn-1", { quality: "untested" })],
      weekend: [candidate("we-1")],
    };

    const input = buildPlannerInput({ ...baseArgs, pools });

    expect(input.untested_present).toBe(true);
  });

  it("computes untested_present true when only the weekend pool has an untested candidate", () => {
    const pools = {
      weeknight: [candidate("wn-1")],
      weekend: [candidate("we-1", { quality: "untested" })],
    };

    const input = buildPlannerInput({ ...baseArgs, pools });

    expect(input.untested_present).toBe(true);
  });

  it("computes untested_present false when no candidate is untested", () => {
    const pools = {
      weeknight: [candidate("wn-1", { quality: 4 })],
      weekend: [candidate("we-1", { quality: 5 })],
    };

    const input = buildPlannerInput({ ...baseArgs, pools });

    expect(input.untested_present).toBe(false);
  });

  it("carries current_season through when provided, and omits it when not", () => {
    const pools = {
      weeknight: [candidate("wn-1")],
      weekend: [candidate("we-1")],
    };

    const withSeason = buildPlannerInput({
      ...baseArgs,
      pools,
      currentSeason: "summer",
    });
    expect(withSeason.current_season).toBe("summer");

    const withoutSeason = buildPlannerInput({ ...baseArgs, pools });
    expect(withoutSeason.current_season).toBeUndefined();
  });
});

describe("buildSelectionPrompt", () => {
  function makeInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
    return {
      week_key: "2026-W29",
      slots: { constrained: 4, relaxed: 2 },
      pools: {
        weeknight: [
          candidate("wn-1", {
            title: "Weeknight Chili",
            quality: 4,
            season_tags: ["fall", "winter"],
            veg_status: "contains_meat",
          }),
          candidate("wn-2", {
            title: "Veggie Stir Fry",
            quality: "untested",
            veg_status: "vegetarian",
          }),
        ],
        weekend: [
          candidate("we-1", {
            title: "Slow Roast",
            quality: 5,
            veg_status: "contains_meat",
          }),
        ],
      },
      household: HOUSEHOLD_PROSE,
      untested_present: false,
      ...overrides,
    };
  }

  it("contains the household prose verbatim and states the veg constraint is hard/every-night", () => {
    const prompt = buildSelectionPrompt(makeInput());

    expect(prompt).toContain(HOUSEHOLD_PROSE);
    expect(prompt.toLowerCase()).toMatch(/hard/);
    expect(prompt.toLowerCase()).toMatch(/every night/);
  });

  it("states the exact slot counts, tagged by slot_type, without assigning days", () => {
    const prompt = buildSelectionPrompt(makeInput());

    expect(prompt).toContain("4");
    expect(prompt).toContain("2");
    expect(prompt.toLowerCase()).toContain("slot_type");
    expect(prompt.toLowerCase()).toMatch(
      /do not assign days|don't assign days/,
    );
  });

  it("includes every candidate id from both pools", () => {
    const input = makeInput();
    const prompt = buildSelectionPrompt(input);

    for (const c of [...input.pools.weeknight, ...input.pools.weekend]) {
      expect(prompt).toContain(c.id);
    }
  });

  it("renders soft-signal fields (time, quality, veg_status) per candidate", () => {
    const prompt = buildSelectionPrompt(makeInput());

    expect(prompt).toContain("wn-1");
    expect(prompt).toContain("Weeknight Chili");
    // active/total time
    expect(prompt).toMatch(/20/);
    expect(prompt).toMatch(/30/);
    expect(prompt).toContain("fall");
    expect(prompt).toContain("winter");
    expect(prompt).toContain("contains_meat");
    expect(prompt).toContain("vegetarian");
    expect(prompt).toContain("untested");
  });

  it("does not include an ingredient block for candidates", () => {
    const prompt = buildSelectionPrompt(makeInput());

    expect(prompt.toLowerCase()).not.toContain("ingredient");
  });

  it("includes the HARD veg-satisfiable and no-repeat rules", () => {
    const prompt = buildSelectionPrompt(makeInput());

    expect(prompt.toLowerCase()).toMatch(
      /veg[- ]satisfiable|vegetarian.{0,20}path/,
    );
    expect(prompt.toLowerCase()).toMatch(/second_dish/);
    expect(prompt.toLowerCase()).toMatch(
      /no[\s\S]{0,40}repeat|not[\s\S]{0,40}repeat/,
    );
  });

  it("includes the untested POOL clause only when untested_present is true", () => {
    // Use pools with no `quality: "untested"` candidates so the clause's
    // presence/absence is what's under test, not incidental candidate data.
    const ratedPools = {
      weeknight: [candidate("wn-1", { quality: 4 })],
      weekend: [candidate("we-1", { quality: 5 })],
    };

    const withUntested = buildSelectionPrompt(
      makeInput({ pools: ratedPools, untested_present: true }),
    );
    expect(withUntested.toLowerCase()).toMatch(/untested|try this/);

    const withoutUntested = buildSelectionPrompt(
      makeInput({ pools: ratedPools, untested_present: false }),
    );
    expect(withoutUntested.toLowerCase()).not.toMatch(/untested|try this/);
  });

  it("includes the season SOFT clause only when current_season is set", () => {
    const withSeason = buildSelectionPrompt(
      makeInput({ current_season: "summer" }),
    );
    expect(withSeason).toContain("summer");
    expect(withSeason.toLowerCase()).toMatch(/season/);

    const withoutSeason = buildSelectionPrompt(
      makeInput({ current_season: undefined }),
    );
    expect(withoutSeason.toLowerCase()).not.toMatch(
      /current.season|respect.*season/,
    );
  });

  it("instructs a single WeekPlan JSON object as output", () => {
    const prompt = buildSelectionPrompt(makeInput());

    expect(prompt).toContain("WeekPlan");
    expect(prompt.toLowerCase()).toMatch(/json/);
  });
});
