import { describe, expect, it, vi } from "vitest";
import type {
  CalendarEvent,
  CalendarReaderOptions,
} from "../calendar/calendar-reader.js";
import type { CalendarConfig } from "../config/config.js";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import type { Recipe, RecipeCandidate } from "../recipe-mcp/schema.js";
import type { SearchFilters } from "../recipe-mcp/search.js";
import { buildPlan, DEFAULT_SEEDS } from "./build-plan.js";
import type { SelectedMeal, WeekPlan } from "./select.js";
import { InsufficientPoolError } from "./validate.js";

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

// ADR-0004 D6: calendar.enabled: false makes getWeekNightSchedule return the
// static fallback sized to cookNights (all-FULL), so deriveSlots reproduces
// the OLD pre-r0o.5 static-config slots exactly for every test below that
// doesn't itself test the enabled/live-calendar path (see the "derives slots
// from a live NightSchedule" describe block further down).
const DISABLED_CALENDAR: CalendarConfig = {
  enabled: false,
  include: [],
  cookingWindow: { start: "16:30", end: "19:30" },
};

const baseCfg = {
  cookNights: { constrained: 1, relaxed: 1 },
  activeMaxMinutes: 60,
  fanoutMultiplier: 4,
  vegFloorK: 1,
  untestedRate: 0,
  timezone: "America/Chicago",
  calendar: DISABLED_CALENDAR,
  quickActiveMax: 30,
  // ADR-0003 A1 (bd bgb): no household lat/lon configured -> buildPlan skips
  // the weather fetch entirely (see `getTemperatureBand`'s "never called"
  // doc below), matching the fallback-cfg pattern.
  weather: {},
};

function fakeSearch() {
  return vi.fn(async (_query: string, filters?: SearchFilters) => {
    const isWeeknight = filters?.active_max !== undefined;
    return isWeeknight ? [candidate("wn-veg")] : [candidate("we-veg")];
  });
}

/** Never called in the disabled-calendar path; supplied for type-shape only. */
function fakeReadEvents() {
  return vi.fn(
    async (_options: CalendarReaderOptions): Promise<CalendarEvent[]> => [],
  );
}

function fakeAlert() {
  return vi.fn(async (_message: string) => {});
}

/** Never called: baseCfg.weather has no lat/lon; supplied for type-shape only. */
function fakeGetTemperatureBand() {
  return vi.fn(async () => null);
}

function planJson(): WeekPlan {
  return {
    week_key: "2026-08-02",
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
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    expect(result.week_key).toBe("2026-08-02");
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
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
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
      weekKey: "2026-08-02",
      cfg: { ...baseCfg, seeds: ["custom seed a", "custom seed b"] },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    expect(search).toHaveBeenCalledWith("custom seed a", expect.anything());
    expect(search).toHaveBeenCalledWith("custom seed b", expect.anything());
  });

  it("threads cfg.season into BOTH the search filters (hard) and the selection prompt (soft) — bd meal-planner-8zs.9", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-08-02",
      cfg: { ...baseCfg, season: "summer" },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
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
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
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
      week_key: "2026-08-02",
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
        weekKey: "2026-08-02",
        cfg: baseCfg,
        household: "Vegetarian daughter every night.",
        deps: {
          search,
          llm,
          getRecipe,
          readEvents: fakeReadEvents(),
          alert: fakeAlert(),
          getTemperatureBand: fakeGetTemperatureBand(),
        },
      }),
    ).rejects.toThrow(/ghost-id/);
  });
});

// ── Pool-sufficiency pre-check (bd meal-planner-8zs.12) ──
// A search that returns FIXED weeknight/weekend candidate arrays regardless of
// seed, so a test can starve a pool deterministically. untestedRate:0 keeps
// injectUntested a no-op; vegetarian candidates + vegFloorK:1 keep the veg-floor
// top-up from ballooning the pool.
function searchReturning(
  weeknight: RecipeCandidate[],
  weekend: RecipeCandidate[],
) {
  return vi.fn(async (_query: string, filters?: SearchFilters) => {
    const isWeeknight = filters?.active_max !== undefined;
    return isWeeknight ? weeknight : weekend;
  });
}

describe("buildPlan pool-sufficiency pre-check", () => {
  it("throws InsufficientPoolError WITHOUT calling the LLM when the weeknight pool is short", async () => {
    // 2 constrained slots but only 1 weeknight candidate.
    const search = searchReturning(
      [candidate("wn-a")],
      [candidate("we-a"), candidate("we-b")],
    );
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await expect(
      buildPlan({
        weekKey: "2026-08-02",
        cfg: { ...baseCfg, cookNights: { constrained: 2, relaxed: 1 } },
        household: "Vegetarian daughter every night.",
        deps: {
          search,
          llm,
          getRecipe,
          readEvents: fakeReadEvents(),
          alert: fakeAlert(),
          getTemperatureBand: fakeGetTemperatureBand(),
        },
      }),
    ).rejects.toThrow(InsufficientPoolError);

    expect(llm.runQuery).not.toHaveBeenCalled();
    expect(getRecipe).not.toHaveBeenCalled();
  });

  it("throws InsufficientPoolError WITHOUT calling the LLM when the weekend pool is short", async () => {
    // 2 relaxed slots but only 1 weekend candidate.
    const search = searchReturning(
      [candidate("wn-a"), candidate("wn-b")],
      [candidate("we-a")],
    );
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await expect(
      buildPlan({
        weekKey: "2026-08-02",
        cfg: { ...baseCfg, cookNights: { constrained: 1, relaxed: 2 } },
        household: "Vegetarian daughter every night.",
        deps: {
          search,
          llm,
          getRecipe,
          readEvents: fakeReadEvents(),
          alert: fakeAlert(),
          getTemperatureBand: fakeGetTemperatureBand(),
        },
      }),
    ).rejects.toThrow(InsufficientPoolError);

    expect(llm.runQuery).not.toHaveBeenCalled();
  });

  it("throws InsufficientPoolError WITHOUT calling the LLM when the distinct union across both pools is short", async () => {
    // Each pool covers its own 1-slot count, but both hold ONLY the same id, so
    // the 2 no-duplicate slots can't be filled by 1 distinct recipe.
    const search = searchReturning(
      [candidate("shared")],
      [candidate("shared")],
    );
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await expect(
      buildPlan({
        weekKey: "2026-08-02",
        cfg: { ...baseCfg, cookNights: { constrained: 1, relaxed: 1 } },
        household: "Vegetarian daughter every night.",
        deps: {
          search,
          llm,
          getRecipe,
          readEvents: fakeReadEvents(),
          alert: fakeAlert(),
          getTemperatureBand: fakeGetTemperatureBand(),
        },
      }),
    ).rejects.toThrow(InsufficientPoolError);

    expect(llm.runQuery).not.toHaveBeenCalled();
  });

  it("proceeds to the selection call when pools are exactly sufficient", async () => {
    const search = searchReturning([candidate("wn-a")], [candidate("we-a")]);
    const plan: WeekPlan = {
      week_key: "2026-08-02",
      meals: [
        meal({ recipe_id: "wn-a", slot_type: "constrained" }),
        meal({ recipe_id: "we-a", slot_type: "relaxed" }),
      ],
    };
    const llm = fakeLlm(JSON.stringify(plan));
    const getRecipe = fakeGetRecipe();

    const result = await buildPlan({
      weekKey: "2026-08-02",
      cfg: { ...baseCfg, cookNights: { constrained: 1, relaxed: 1 } },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(result.meals).toHaveLength(2);
  });
});

// ── ADR-0005 D1: NightSchedule folded into the same selection call ──
describe("buildPlan threads the NightSchedule into the selection prompt", () => {
  it("passes the SAME NightSchedule buildPlan derived slots from into the selection prompt (disabled-calendar static fallback)", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await buildPlan({
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    const prompt = (llm.runQuery as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .prompt as string;
    // The static fallback (baseCfg.cookNights: 1 constrained + 1 relaxed)
    // anchors weekKey 2026-08-02 (Sunday) -> Monday (2026-08-03, weeknight)
    // + Sunday itself (2026-08-02, weekend).
    expect(prompt).toContain("SCHEDULE");
    expect(prompt).toContain("2026-08-03");
    expect(prompt).toContain("2026-08-02");
    expect(prompt).toContain("FULL");
    expect(prompt.toLowerCase()).toMatch(/iso date/);
  });

  it("flows a stubbed selection response's populated ISO `day` through validation/enrich intact (ADR-0005 D1)", async () => {
    const search = fakeSearch();
    const plan: WeekPlan = {
      week_key: "2026-08-02",
      meals: [
        meal({
          recipe_id: "wn-veg",
          slot_type: "constrained",
          day: "2026-08-03",
        }),
        meal({
          recipe_id: "we-veg",
          slot_type: "relaxed",
          day: "2026-08-02",
        }),
      ],
    };
    const llm = fakeLlm(JSON.stringify(plan));
    const getRecipe = fakeGetRecipe();

    const result = await buildPlan({
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    expect(result.meals[0].day).toBe("2026-08-03");
    expect(result.meals[1].day).toBe("2026-08-02");
  });
});

// ── ADR-0005 D4: NightSchedule attached as render context (bd meal-planner-0v7.7) ──
describe("buildPlan attaches nightSchedule onto the returned plan", () => {
  it("returns the SAME NightSchedule it derived slots/fed the selection prompt from (disabled-calendar static fallback)", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    const result = await buildPlan({
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    // baseCfg.cookNights: 1 constrained + 1 relaxed -> the D6 static
    // fallback sizes the schedule to exactly those 2 nights (Mon + Sun).
    expect(result.nightSchedule).toBeDefined();
    expect(result.nightSchedule).toHaveLength(2);
    const dates = result.nightSchedule?.map((night) => night.date) ?? [];
    expect(dates).toContain("2026-08-02");
    expect(dates).toContain("2026-08-03");
    // Disabled-calendar static fallback (baseCfg): every night is FULL.
    expect(
      result.nightSchedule?.every((night) => night.capacity === "FULL"),
    ).toBe(true);
  });
});

// ── ADR-0004 D5: prep-unit placement wired into the pipeline (bd meal-planner-468.2) ──
describe("buildPlan places prep units before enrich/return", () => {
  it("attaches a placed PrepUnit for a do-ahead meal, reachable via result.prep", async () => {
    const search = fakeSearch();
    // baseCfg's D6 static fallback (weekKey 2026-08-02, cookNights 1+1)
    // sizes the schedule to exactly Sun 2026-08-02 (relaxed/weekend) + Mon
    // 2026-08-03 (constrained/weeknight), both FULL (see the nightSchedule
    // describe block above) — Sunday is the only earlier night Monday's
    // do-ahead meal can place onto.
    const plan: WeekPlan = {
      week_key: "2026-08-02",
      meals: [
        meal({
          recipe_id: "wn-veg",
          slot_type: "constrained",
          day: "2026-08-03",
          flags: ["do-ahead"],
        }),
        meal({
          recipe_id: "we-veg",
          slot_type: "relaxed",
          day: "2026-08-02",
        }),
      ],
    };
    const llm = fakeLlm(JSON.stringify(plan));
    const getRecipe = fakeGetRecipe();

    const result = await buildPlan({
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    expect(result.prep).toEqual([
      {
        description: "Prep: Recipe wn-veg",
        serve_date: "2026-08-03",
        prep_date: "2026-08-02",
      },
    ]);
  });

  it("attaches an empty prep array when no selected meal is flagged do-ahead", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    const result = await buildPlan({
      weekKey: "2026-08-02",
      cfg: baseCfg,
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    expect(result.prep).toEqual([]);
  });
});

// ── ADR-0004 D4/D6: slots derived from NightSchedule (bead r0o.5) ──
describe("buildPlan derives slots from NightSchedule", () => {
  const ENABLED_CALENDAR: CalendarConfig = {
    enabled: true,
    include: [{ name: "Jonathan", role: "cook" }],
    cookingWindow: { start: "16:30", end: "19:30" },
  };

  function fullyBlockingEvent(start: string, end: string): CalendarEvent {
    return {
      calendarName: "Jonathan",
      title: "Busy all evening",
      start: new Date(start),
      end: new Date(end),
      allDay: false,
      status: "confirmed",
    };
  }

  it("disabled calendar: reproduces the OLD static cfg.cookNights slots exactly (v1.0-equivalence)", async () => {
    // cookNights: 3 constrained + 2 relaxed, but the weeknight pool only has 2
    // distinct candidates — insufficient ONLY if the static cookNights count
    // (not some other derived value) is what's gating.
    const search = searchReturning(
      [candidate("wn-a"), candidate("wn-b")],
      [candidate("we-a"), candidate("we-b")],
    );
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    const err: unknown = await buildPlan({
      weekKey: "2026-08-02",
      cfg: {
        ...baseCfg,
        cookNights: { constrained: 3, relaxed: 2 },
        calendar: DISABLED_CALENDAR,
      },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(InsufficientPoolError);
    expect(
      (err as InstanceType<typeof InsufficientPoolError>).constrainedSlots,
    ).toBe(3);
    expect(
      (err as InstanceType<typeof InsufficientPoolError>).relaxedSlots,
    ).toBe(2);
    expect(llm.runQuery).not.toHaveBeenCalled();
  });

  it("enabled calendar: derives slots from the LIVE NightSchedule, not cfg.cookNights", async () => {
    // Week anchored Sun 2026-08-02. Fully block Tuesday's (2026-08-04)
    // cooking window -> that night classifies NONE. Remaining weeknights
    // (Mon, Wed, Thu, Fri) = 4 constrained; weekend (Sun, Sat) = 2 relaxed —
    // DIFFERENT from cfg.cookNights ({constrained:1, relaxed:1} below), so a
    // pool sized only to cfg.cookNights proves slots came from the schedule.
    const readEvents = vi.fn(async (_options: CalendarReaderOptions) => [
      fullyBlockingEvent("2026-08-04T20:00:00Z", "2026-08-05T01:00:00Z"), // 15:00-20:00 CDT Tue
    ]);
    const search = searchReturning(
      [candidate("wn-a")], // 1 distinct candidate: enough for cfg.cookNights.constrained(1), NOT for the derived 4
      [candidate("we-a"), candidate("we-b")],
    );
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    const err: unknown = await buildPlan({
      weekKey: "2026-08-02",
      cfg: {
        ...baseCfg,
        cookNights: { constrained: 1, relaxed: 1 },
        calendar: ENABLED_CALENDAR,
      },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents,
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(InsufficientPoolError);
    expect(
      (err as InstanceType<typeof InsufficientPoolError>).constrainedSlots,
    ).toBe(4);
    expect(
      (err as InstanceType<typeof InsufficientPoolError>).relaxedSlots,
    ).toBe(2);
    expect(llm.runQuery).not.toHaveBeenCalled();
  });
});

// ── ADR-0005 D3 (bd meal-planner-kro): calendarEnabled/quickActiveMax threaded
// from BuildPlanConfig into selectValidatedPlan's ValidatePlanConfig, so the
// day rules (0v7.3) actually fire in production instead of staying dormant. ──
describe("buildPlan threads calendarEnabled/quickActiveMax into day-rule validation (bd meal-planner-kro)", () => {
  const ENABLED_CALENDAR: CalendarConfig = {
    enabled: true,
    include: [{ name: "Jonathan", role: "cook" }],
    cookingWindow: { start: "16:30", end: "19:30" },
  };

  function fullyBlockingEvent(start: string, end: string): CalendarEvent {
    return {
      calendarName: "Jonathan",
      title: "Busy all evening",
      start: new Date(start),
      end: new Date(end),
      allDay: false,
      status: "confirmed",
    };
  }

  function partiallyBlockingEvent(start: string, end: string): CalendarEvent {
    return {
      calendarName: "Jonathan",
      title: "Quick errand",
      start: new Date(start),
      end: new Date(end),
      allDay: false,
      status: "confirmed",
    };
  }

  // Week anchored Sun 2026-08-02. Fully block Mon/Tue/Wed/Thu (08-03..08-06)
  // and Sat (08-08) -> NONE, leaving exactly 1 weeknight (Fri 08-07) + 1
  // weekend night (Sun 08-02) -> matches fakeSearch()/planJson()'s
  // single-candidate-per-pool shape with the derived (not static cookNights)
  // slot counts.
  function blockAllExceptFriAndSun(): CalendarEvent[] {
    return [
      fullyBlockingEvent("2026-08-03T20:00:00Z", "2026-08-04T01:00:00Z"), // Mon
      fullyBlockingEvent("2026-08-04T20:00:00Z", "2026-08-05T01:00:00Z"), // Tue
      fullyBlockingEvent("2026-08-05T20:00:00Z", "2026-08-06T01:00:00Z"), // Wed
      fullyBlockingEvent("2026-08-06T20:00:00Z", "2026-08-07T01:00:00Z"), // Thu
      fullyBlockingEvent("2026-08-08T20:00:00Z", "2026-08-09T01:00:00Z"), // Sat
    ];
  }

  it("calendar ENABLED: a fresh plan with a null day FAILS validation (rule fires)", async () => {
    const readEvents = vi.fn(async (_options: CalendarReaderOptions) =>
      blockAllExceptFriAndSun(),
    );
    const search = fakeSearch();
    // planJson()'s meals default `day: null` (see the `meal()` factory).
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    await expect(
      buildPlan({
        weekKey: "2026-08-02",
        cfg: { ...baseCfg, calendar: ENABLED_CALENDAR, quickActiveMax: 30 },
        household: "Vegetarian daughter every night.",
        deps: {
          search,
          llm,
          getRecipe,
          readEvents,
          alert: fakeAlert(),
          getTemperatureBand: fakeGetTemperatureBand(),
        },
      }),
    ).rejects.toThrow(/day is null but a night schedule is available/);
  });

  it("calendar DISABLED: a null-day plan still passes validation (lenient)", async () => {
    const search = fakeSearch();
    // planJson()'s meals default `day: null`; DISABLED_CALENDAR (baseCfg)
    // keeps `calendarEnabled` false, so the non-null gate stays off.
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();

    const result = await buildPlan({
      weekKey: "2026-08-02",
      cfg: { ...baseCfg, quickActiveMax: 30 },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand: fakeGetTemperatureBand(),
      },
    });

    expect(result.meals[0].day).toBeNull();
    expect(result.meals[1].day).toBeNull();
  });

  it("threads cfg.quickActiveMax into the capacity-fit rule: a non-quick-eligible meal on a QUICK night fails validation", async () => {
    // Same as blockAllExceptFriAndSun, but Friday gets only a PARTIAL cook
    // overlap -> QUICK (not FULL). Sunday stays fully open -> FULL.
    const readEvents = vi.fn(async (_options: CalendarReaderOptions) => [
      ...blockAllExceptFriAndSun(),
      partiallyBlockingEvent("2026-08-07T20:00:00Z", "2026-08-07T22:00:00Z"), // Fri, 15:00-17:00 CDT
    ]);
    const search = fakeSearch();
    const plan: WeekPlan = {
      week_key: "2026-08-02",
      meals: [
        // wn-veg's candidate() default active time is 20 min (see the
        // `candidate()` factory) -> exceeds a quickActiveMax of 5, and is not
        // flagged "do-ahead".
        meal({
          recipe_id: "wn-veg",
          slot_type: "constrained",
          day: "2026-08-07",
        }),
        meal({
          recipe_id: "we-veg",
          slot_type: "relaxed",
          day: "2026-08-02",
        }),
      ],
    };
    const llm = fakeLlm(JSON.stringify(plan));
    const getRecipe = fakeGetRecipe();

    await expect(
      buildPlan({
        weekKey: "2026-08-02",
        cfg: { ...baseCfg, calendar: ENABLED_CALENDAR, quickActiveMax: 5 },
        household: "Vegetarian daughter every night.",
        deps: {
          search,
          llm,
          getRecipe,
          readEvents,
          alert: fakeAlert(),
          getTemperatureBand: fakeGetTemperatureBand(),
        },
      }),
    ).rejects.toThrow(/5-min quick ceiling/);
  });
});

// ── ADR-0003 A1 (bd bgb): temperature_band fetched + threaded, silent degrade ──
describe("buildPlan threads temperature_band (ADR-0003 A1, bd bgb)", () => {
  it("fetches the band with the configured location + weekKey/timezone and threads it into the selection prompt", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();
    const getTemperatureBand = vi.fn(async () => "hot" as const);

    await buildPlan({
      weekKey: "2026-08-02",
      cfg: { ...baseCfg, weather: { latitude: 41.88, longitude: -87.63 } },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand,
      },
    });

    expect(getTemperatureBand).toHaveBeenCalledWith({
      weekKey: "2026-08-02",
      timezone: "America/Chicago",
      latitude: 41.88,
      longitude: -87.63,
    });
    const prompt = (llm.runQuery as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .prompt as string;
    expect(prompt).toContain('"hot"');
  });

  it("skips the fetch entirely (never calls deps.getTemperatureBand) when weather lat/lon is unconfigured", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();
    const getTemperatureBand = vi.fn(async () => "hot" as const);

    await buildPlan({
      weekKey: "2026-08-02",
      cfg: baseCfg, // weather: {} — no lat/lon
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert: fakeAlert(),
        getTemperatureBand,
      },
    });

    expect(getTemperatureBand).not.toHaveBeenCalled();
  });

  it("SILENTLY degrades to seasonal-only (no alert call) when deps.getTemperatureBand resolves null", async () => {
    const search = fakeSearch();
    const llm = fakeLlm(JSON.stringify(planJson()));
    const getRecipe = fakeGetRecipe();
    const getTemperatureBand = vi.fn(async () => null);
    const alert = fakeAlert();

    await buildPlan({
      weekKey: "2026-08-02",
      cfg: { ...baseCfg, weather: { latitude: 41.88, longitude: -87.63 } },
      household: "Vegetarian daughter every night.",
      deps: {
        search,
        llm,
        getRecipe,
        readEvents: fakeReadEvents(),
        alert,
        getTemperatureBand,
      },
    });

    // baseCfg's DISABLED calendar has its OWN alert-once degrade (ADR-0004
    // D6) — this asserts the WEATHER degrade path never adds an alert of its
    // own on top of that, not that `alert` is never called at all.
    for (const call of alert.mock.calls) {
      expect(String(call[0]).toLowerCase()).not.toMatch(/weather|temperature/);
    }
    const prompt = (llm.runQuery as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .prompt as string;
    expect(prompt.toLowerCase()).not.toMatch(/temperature.*trends/);
  });
});
