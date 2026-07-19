import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recipe } from "../recipe-mcp/schema.js";
import { ResumeError, resumeQuietly } from "./resume.js";
import { SessionStore } from "./session-store.js";
import { onStartup } from "./startup.js";
import type { WeekKeyConfig } from "./week-key.js";

/**
 * `resumeQuietly` (ADR 0002 "Crash recovery -- resume quietly", bd6.5) tests.
 * Three things under test: (1) a valid `working_plan` parses into the typed
 * `EnrichedWeekPlan`; (2) `working_plan: null` round-trips to `null` with no
 * throw; (3) a malformed `working_plan` throws `ResumeError` rather than
 * silently returning a corrupt plan. A fourth block pins the "zero side
 * effects" guarantee that is the entire point of "quietly", and a fifth
 * confirms the real function slots into `onStartup`'s injected
 * `(row: Session) => Promise<void> | void` seam (bd6.4) without any adapter.
 */

const HOUSEHOLD_SECRET = "vegetarian daughter hates cilantro";

function makeRecipe(id: string): Recipe {
  return {
    id,
    title: `Recipe ${id}`,
    time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
    effort_tags: [],
    season_tags: [],
    veg_status: "vegetarian",
    ingredients: [],
    source_note_id: `note-${id}`,
  };
}

function makeValidWorkingPlan(weekKey: string) {
  return {
    week_key: weekKey,
    meals: [
      {
        slot_type: "constrained" as const,
        recipe_id: "r1",
        title: "Recipe r1",
        day: null,
        veg: { kind: "inherent" as const },
        flags: [],
        rationale: "quick and vegetarian",
        recipe: makeRecipe("r1"),
      },
      {
        slot_type: "relaxed" as const,
        recipe_id: "r2",
        title: "Recipe r2",
        day: null,
        veg: {
          kind: "second_dish" as const,
          recipe_id: "r2-veg",
          title: "Veg side",
        },
        flags: [],
        rationale: "weekend cook",
        recipe: makeRecipe("r2"),
        secondDishRecipe: makeRecipe("r2-veg"),
      },
    ],
    summary: "a fine week",
  };
}

let store: SessionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeStore() {
  return new SessionStore({ path: ":memory:" });
}

describe("resumeQuietly", () => {
  it("a suggested row with a valid working_plan: returns an ActiveSession with the parsed plan, thread_ts, and status", () => {
    store = makeStore();
    const plan = makeValidWorkingPlan("2026-07-12");
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      thread_ts: "1234.5678",
      working_plan: plan,
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const row = store.get("2026-07-12");
    if (!row) throw new Error("test setup: row missing");

    const active = resumeQuietly(row);

    expect(active).toEqual({
      week_key: "2026-07-12",
      status: "suggested",
      thread_ts: "1234.5678",
      working_plan: plan,
    });
  });

  it("a committed row with no working_plan: working_plan is null, no throw", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "committed",
      thread_ts: "1234.5678",
      working_plan: null,
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const row = store.get("2026-07-12");
    if (!row) throw new Error("test setup: row missing");

    const active = resumeQuietly(row);

    expect(active).toEqual({
      week_key: "2026-07-12",
      status: "committed",
      thread_ts: "1234.5678",
      working_plan: null,
    });
  });

  it("an expired row with no working_plan: working_plan is null, no throw", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-05",
      status: "expired",
      created_at: "2026-07-05T05:00:00.000Z",
      updated_at: "2026-07-05T05:00:00.000Z",
    });
    const row = store.get("2026-07-05");
    if (!row) throw new Error("test setup: row missing");

    const active = resumeQuietly(row);

    expect(active.working_plan).toBeNull();
    expect(active.thread_ts).toBeNull();
  });

  it("a malformed working_plan (missing meals): throws ResumeError, naming only the week_key -- never household prose", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      // Malformed on purpose: no `meals` array at all.
      working_plan: { week_key: "2026-07-12", note: HOUSEHOLD_SECRET },
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const row = store.get("2026-07-12");
    if (!row) throw new Error("test setup: row missing");

    expect(() => resumeQuietly(row)).toThrow(ResumeError);
    try {
      resumeQuietly(row);
      throw new Error("expected resumeQuietly to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ResumeError);
      const message = (err as ResumeError).message;
      expect(message).toContain("2026-07-12");
      expect(message).not.toContain(HOUSEHOLD_SECRET);
      expect((err as ResumeError).weekKey).toBe("2026-07-12");
    }
  });

  it("lenient read (bd6.13): a working_plan with an UNKNOWN extra field and a NULL day still parses (no throw), preserving the extra field", () => {
    store = makeStore();
    const plan = makeValidWorkingPlan("2026-07-12") as Record<
      string,
      unknown
    > & { meals: Array<Record<string, unknown>> };
    // A future schema grows the plan: an unknown top-level field and an
    // unknown per-meal field. An old daemon must still parse it rather than
    // lose the live week's plan.
    const forwardCompatible = {
      ...plan,
      calendar_context: { holiday: false }, // unknown top-level field (v2.0-ish)
      meals: [
        { ...plan.meals[0], day: null, todoist_task_id: "abc" }, // unknown per-meal field (v3.0-ish)
        plan.meals[1],
      ],
    };
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      working_plan: forwardCompatible,
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const row = store.get("2026-07-12");
    if (!row) throw new Error("test setup: row missing");

    const active = resumeQuietly(row);

    expect(active.working_plan).not.toBeNull();
    // Extra fields are tolerated AND preserved (passthrough), not dropped.
    expect(active.working_plan).toMatchObject({
      calendar_context: { holiday: false },
    });
    expect(active.working_plan?.meals[0]).toMatchObject({
      todoist_task_id: "abc",
    });
  });

  it("lenient read (bd6.13): a meal with a STRING day (v2.0 day assignment) parses without throwing", () => {
    store = makeStore();
    const plan = makeValidWorkingPlan("2026-07-12") as {
      meals: Array<Record<string, unknown>>;
    };
    const withDay = {
      ...plan,
      meals: [{ ...plan.meals[0], day: "Monday" }, plan.meals[1]],
    };
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      working_plan: withDay,
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const row = store.get("2026-07-12");
    if (!row) throw new Error("test setup: row missing");

    expect(() => resumeQuietly(row)).not.toThrow();
    expect(resumeQuietly(row).working_plan?.meals[0].day).toBe("Monday");
  });

  it("lenient read stays STRICT about the core: a plan missing `meals` still throws ResumeError", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      // No `meals` array — a genuinely malformed plan, not merely an extra
      // field. Leniency must not swallow this.
      working_plan: { week_key: "2026-07-12", summary: "no meals here" },
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const row = store.get("2026-07-12");
    if (!row) throw new Error("test setup: row missing");

    expect(() => resumeQuietly(row)).toThrow(ResumeError);
  });

  it("a malformed working_plan (meal missing recipe): throws ResumeError", () => {
    store = makeStore();
    const plan = makeValidWorkingPlan("2026-07-12");
    // Corrupt the first meal: drop its attached `recipe` (as if enrichment
    // never ran, or the row was hand-edited).
    const corrupted = {
      ...plan,
      meals: [{ ...plan.meals[0], recipe: undefined }, plan.meals[1]],
    };
    store.insert({
      week_key: "2026-07-12",
      status: "under_revision",
      working_plan: corrupted,
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    });
    const row = store.get("2026-07-12");
    if (!row) throw new Error("test setup: row missing");

    expect(() => resumeQuietly(row)).toThrow(ResumeError);
  });

  it("a working_plan stored as a raw JSON string: still parses (defensive, in case a row is constructed by hand)", () => {
    store = makeStore();
    const plan = makeValidWorkingPlan("2026-07-12");
    const row = {
      week_key: "2026-07-12",
      status: "suggested" as const,
      thread_ts: "1.1",
      working_plan: JSON.stringify(plan),
      turn_count: 0,
      token_spend: 0,
      cost_usd: 0,
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    };

    const active = resumeQuietly(row);

    expect(active.working_plan).toEqual(plan);
  });

  it("a working_plan stored as an unparseable string: throws ResumeError rather than propagating the raw JSON.parse error", () => {
    store = makeStore();
    // V8's JSON.parse error message embeds a SNIPPET of the offending input
    // (e.g. `Unexpected token 'S', "SECRET_HOU"... is not valid JSON`), so a
    // household-secret-bearing string must never reach the thrown message --
    // plant one here and assert it's absent below, not just that it throws.
    const row = {
      week_key: "2026-07-12",
      status: "suggested" as const,
      thread_ts: "1.1",
      working_plan: `${HOUSEHOLD_SECRET} not json {`,
      turn_count: 0,
      token_spend: 0,
      cost_usd: 0,
      created_at: "2026-07-12T05:00:00.000Z",
      updated_at: "2026-07-12T05:00:00.000Z",
    };

    // V8 truncates the embedded snippet (e.g. to `"vegetarian"...`), so
    // asserting the FULL secret is absent would pass even with a leak still
    // in place. Pin instead against what JSON.parse itself actually reports
    // for this exact string -- the old code interpolated that verbatim, so
    // this fails red against the bug and green once the message is generic.
    let rawParseMessage = "";
    try {
      JSON.parse(row.working_plan);
      throw new Error("test setup: expected working_plan to be invalid JSON");
    } catch (err) {
      rawParseMessage = (err as Error).message;
    }
    expect(rawParseMessage).toContain("vegetarian"); // sanity: V8 does leak a snippet

    expect(() => resumeQuietly(row)).toThrow(ResumeError);
    try {
      resumeQuietly(row);
      throw new Error("expected resumeQuietly to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ResumeError);
      const message = (err as ResumeError).message;
      expect(message).not.toContain(HOUSEHOLD_SECRET);
      expect(message).not.toContain(row.working_plan);
      expect(message).not.toContain(rawParseMessage);
    }
  });

  describe("zero side effects", () => {
    it("does not mutate the passed row (frozen row survives a call)", () => {
      store = makeStore();
      const plan = makeValidWorkingPlan("2026-07-12");
      store.insert({
        week_key: "2026-07-12",
        status: "suggested",
        thread_ts: "1.1",
        working_plan: plan,
        created_at: "2026-07-12T05:00:00.000Z",
        updated_at: "2026-07-12T05:00:00.000Z",
      });
      const row = store.get("2026-07-12");
      if (!row) throw new Error("test setup: row missing");
      const frozen = Object.freeze({ ...row });

      // If resumeQuietly ever tried to write to the row, this would throw
      // (frozen object, strict mode) before we even get to the assertion.
      expect(() => resumeQuietly(frozen)).not.toThrow();
    });

    it("touches no store write: the store's row is byte-identical before and after", () => {
      store = makeStore();
      const plan = makeValidWorkingPlan("2026-07-12");
      store.insert({
        week_key: "2026-07-12",
        status: "suggested",
        thread_ts: "1.1",
        working_plan: plan,
        created_at: "2026-07-12T05:00:00.000Z",
        updated_at: "2026-07-12T05:00:00.000Z",
      });
      const before = store.get("2026-07-12");
      if (!before) throw new Error("test setup: row missing");

      resumeQuietly(before);

      const after = store.get("2026-07-12");
      expect(after).toEqual(before);
    });
  });

  describe("composes with onStartup's injected signature", () => {
    it("the real resumeQuietly slots directly into onStartup's deps with no adapter", async () => {
      store = makeStore();
      const plan = makeValidWorkingPlan("2026-07-12");
      store.insert({
        week_key: "2026-07-12",
        status: "suggested",
        thread_ts: "1.1",
        working_plan: plan,
        created_at: "2026-07-12T05:00:00.000Z",
        updated_at: "2026-07-12T05:00:00.000Z",
      });

      const cfg: WeekKeyConfig = {
        timezone: "America/Chicago",
        triggerTime: "06:00",
      };
      const generateForWeek = vi.fn(
        async (_weekKey: string, _opts: { force?: boolean }) =>
          "generated" as const,
      );
      const alert = vi.fn(async (_message: string) => {});
      const now = () => new Date("2026-07-13T17:00:00.000Z");

      await expect(
        onStartup({
          cfg,
          store: store as SessionStore,
          generateForWeek,
          resumeQuietly,
          alert,
          now,
        }),
      ).resolves.toBeUndefined();

      expect(generateForWeek).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
    });
  });
});
