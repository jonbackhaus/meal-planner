import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import { enrichPlan } from "../planner/enrich.js";
import type { SelectedMeal, WeekPlan } from "../planner/select.js";
import type { Recipe } from "../recipe-mcp/schema.js";
import type { InboundThreadReply } from "../slack/inbound-router.js";
import {
  buildRevisionPrompt,
  createRevisionHandler,
  extractCurrentPlan,
  mutateWorkingPlan,
  type RevisionResult,
} from "./revision.js";
import type { Session, SessionStore } from "./session-store.js";

/**
 * `revision.ts` tests (bd meal-planner-3e2.2, ADR 0007 D1). No real network:
 * `LlmClient` is a `vi.fn` stand-in exactly like `planner/select.test.ts`'s
 * `makeFakeLlm`, never the real `@anthropic-ai/claude-agent-sdk` adapter.
 */

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

function meal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
  return {
    slot_type: "constrained",
    recipe_id: "recipe-1",
    title: "Veggie Chili",
    day: "2026-07-14",
    veg: { kind: "inherent" },
    flags: [],
    rationale: "Quick, vegetarian, high quality.",
    ...overrides,
  };
}

function weekPlan(meals: SelectedMeal[] = [meal()]): WeekPlan {
  return { week_key: "2026-07-12", meals, summary: "A tasty week." };
}

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
    source_note_id: id,
    ...overrides,
  };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    week_key: "2026-07-12",
    status: "suggested",
    thread_ts: "1000.0001",
    working_plan: null,
    last_posted_plan: null,
    turn_count: 0,
    token_spend: 0,
    cost_usd: 0,
    created_at: "2026-07-12T06:00:00.000Z",
    updated_at: "2026-07-12T06:00:00.000Z",
    ...overrides,
  };
}

function fakeSessionStore(session: Session | null): Pick<SessionStore, "get"> {
  return { get: vi.fn(() => session) };
}

function threadReply(
  overrides: Partial<InboundThreadReply> = {},
): InboundThreadReply {
  return {
    weekKey: "2026-07-12",
    threadTs: "1000.0001",
    event: {
      type: "message",
      channel: "C123",
      user: "U123",
      ts: "1000.0002",
      thread_ts: "1000.0001",
      text: "how about tacos instead of the stir fry",
    },
    ...overrides,
  };
}

describe("buildRevisionPrompt", () => {
  it("carries the current plan (verbatim) and every message, and frames a MUTATION not a fresh selection", () => {
    const plan = weekPlan([
      meal({ recipe_id: "recipe-1", title: "Veggie Chili" }),
    ]);

    const prompt = buildRevisionPrompt(plan, [
      "how about tacos instead of the stir fry",
      "actually let's keep Tuesday as-is",
    ]);

    // The plan going in is present verbatim (ids/titles), not re-derived --
    // this is what proves the call is a MUTATION of the given plan, not a
    // from-scratch selection over some candidate pool (which this module
    // never even has access to).
    expect(prompt).toContain('"recipe_id": "recipe-1"');
    expect(prompt).toContain('"title": "Veggie Chili"');
    expect(prompt).toContain('"week_key": "2026-07-12"');
    expect(prompt).toContain("how about tacos instead of the stir fry");
    expect(prompt).toContain("actually let's keep Tuesday as-is");
    expect(prompt.toUpperCase()).toContain("MUTATE");
    expect(prompt).not.toContain("search_recipes");
  });
});

describe("mutateWorkingPlan", () => {
  it("returns the LLM's mutated WeekPlan, parsed via the existing WeekPlanSchema", async () => {
    const currentPlan = weekPlan([
      meal({ recipe_id: "recipe-1", title: "Veggie Chili" }),
    ]);
    const revised: WeekPlan = {
      week_key: "2026-07-12",
      meals: [meal({ recipe_id: "recipe-9", title: "Bean Tacos" })],
    };
    const llm = makeFakeLlm(JSON.stringify(revised));

    const result = await mutateWorkingPlan(
      currentPlan,
      ["swap Tuesday for tacos"],
      { llm },
    );

    expect(result.meals[0].recipe_id).toBe("recipe-9");
    expect(result.meals[0].title).toBe("Bean Tacos");
    // Exactly one bounded call -- no agentic loop, no repair retry (that's B2).
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });

  it("propagates a PlanSelectionError when the LLM response doesn't shape-validate", async () => {
    const currentPlan = weekPlan();
    const llm = makeFakeLlm("not json at all");

    await expect(
      mutateWorkingPlan(currentPlan, ["swap Tuesday"], { llm }),
    ).rejects.toThrow(/plan selection failed/);
  });
});

describe("extractCurrentPlan", () => {
  it("strips enrichment (recipe/secondDishRecipe/sideRecipe) off a stored EnrichedWeekPlan", async () => {
    const bare = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const enriched = await enrichPlan(bare, {
      getRecipe: async (id) => recipe(id),
    });

    const extracted = extractCurrentPlan(enriched);

    expect(extracted).not.toBeNull();
    const extractedMeal = (extracted as WeekPlan).meals[0];
    expect(extractedMeal).toEqual(bare.meals[0]);
    // biome-ignore lint/suspicious/noExplicitAny: reaching into extractedMeal for a negative assertion
    expect((extractedMeal as any).recipe).toBeUndefined();
  });

  it("accepts a bare (pre-enrichment) WeekPlan as-is", () => {
    const bare = weekPlan();
    expect(extractCurrentPlan(bare)).toEqual(bare);
  });

  it("returns null for null/undefined/garbage", () => {
    expect(extractCurrentPlan(null)).toBeNull();
    expect(extractCurrentPlan(undefined)).toBeNull();
    expect(extractCurrentPlan({ not: "a plan" })).toBeNull();
  });
});

describe("createRevisionHandler", () => {
  it("mutates the session's working_plan and hands the result to onRevised, carrying the plan as mutation context (not a fresh selection)", async () => {
    const bare = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const enriched = await enrichPlan(bare, {
      getRecipe: async (id) => recipe(id),
    });
    const session = fakeSession({ working_plan: enriched });
    const sessionStore = fakeSessionStore(session);

    const revised: WeekPlan = {
      week_key: "2026-07-12",
      meals: [meal({ recipe_id: "recipe-9", title: "Bean Tacos" })],
    };
    const llm = makeFakeLlm(JSON.stringify(revised));
    const onRevised = vi.fn<(result: RevisionResult) => void>();

    const handler = createRevisionHandler({
      sessionStore,
      llm,
      onRevised,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.onReply(threadReply());

    expect(onRevised).toHaveBeenCalledTimes(1);
    const result = onRevised.mock.calls[0][0];
    expect(result.weekKey).toBe("2026-07-12");
    expect(result.threadTs).toBe("1000.0001");
    expect(result.messages).toEqual([
      "how about tacos instead of the stir fry",
    ]);
    expect(result.revisedPlan.meals[0].recipe_id).toBe("recipe-9");

    // Assert the mutation prompt sent to the LLM carried the CURRENT plan's
    // ids -- i.e. this was a mutation of the given plan, not a from-scratch
    // selection over some pool.
    const sentPrompt = (llm.runQuery as ReturnType<typeof vi.fn>).mock
      .calls[0][0].prompt as string;
    expect(sentPrompt).toContain('"recipe_id": "recipe-1"');
    expect(sentPrompt).toContain("how about tacos instead of the stir fry");
  });

  it("never writes to the session store -- persisting the revised plan is B2's job", async () => {
    const bare = weekPlan();
    const enriched = await enrichPlan(bare, {
      getRecipe: async (id) => recipe(id),
    });
    const session = fakeSession({ working_plan: enriched });
    const get = vi.fn(() => session);
    const sessionStore: Pick<SessionStore, "get"> = { get };

    const llm = makeFakeLlm(JSON.stringify(weekPlan()));
    const handler = createRevisionHandler({ sessionStore, llm });

    await handler.onReply(threadReply());

    // Only a read (`get`) is exercised; no `update`/`insert` surface was even
    // supplied, so any attempt to write would throw -- it didn't.
    expect(get).toHaveBeenCalledWith("2026-07-12");
  });

  it("drops the reply (no LLM call) when the session has no working_plan", async () => {
    const sessionStore = fakeSessionStore(fakeSession({ working_plan: null }));
    const llm = makeFakeLlm(JSON.stringify(weekPlan()));
    const onRevised = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const handler = createRevisionHandler({
      sessionStore,
      llm,
      onRevised,
      logger,
    });
    await handler.onReply(threadReply());

    expect(llm.runQuery).not.toHaveBeenCalled();
    expect(onRevised).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("drops the reply (no LLM call) when no session row matches the week", async () => {
    const sessionStore = fakeSessionStore(null);
    const llm = makeFakeLlm(JSON.stringify(weekPlan()));
    const onRevised = vi.fn();

    const handler = createRevisionHandler({ sessionStore, llm, onRevised });
    await handler.onReply(threadReply());

    expect(llm.runQuery).not.toHaveBeenCalled();
    expect(onRevised).not.toHaveBeenCalled();
  });

  it("drops the reply (no LLM call) when the event carries no text", async () => {
    const bare = weekPlan();
    const enriched = await enrichPlan(bare, {
      getRecipe: async (id) => recipe(id),
    });
    const sessionStore = fakeSessionStore(
      fakeSession({ working_plan: enriched }),
    );
    const llm = makeFakeLlm(JSON.stringify(weekPlan()));
    const onRevised = vi.fn();

    const handler = createRevisionHandler({ sessionStore, llm, onRevised });
    await handler.onReply(
      threadReply({
        event: {
          type: "message",
          subtype: "channel_join",
          thread_ts: "1000.0001",
        },
      }),
    );

    expect(llm.runQuery).not.toHaveBeenCalled();
    expect(onRevised).not.toHaveBeenCalled();
  });

  it("never throws out of onReply when the LLM call fails -- logs and drops instead", async () => {
    const bare = weekPlan();
    const enriched = await enrichPlan(bare, {
      getRecipe: async (id) => recipe(id),
    });
    const sessionStore = fakeSessionStore(
      fakeSession({ working_plan: enriched }),
    );
    const runQuery = vi.fn().mockRejectedValue(new Error("boom"));
    const onRevised = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const handler = createRevisionHandler({
      sessionStore,
      llm: { runQuery },
      onRevised,
      logger,
    });

    await expect(handler.onReply(threadReply())).resolves.toBeUndefined();
    expect(onRevised).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("defaults onRevised to a log-only no-op (never throws) when none is injected", async () => {
    const bare = weekPlan();
    const enriched = await enrichPlan(bare, {
      getRecipe: async (id) => recipe(id),
    });
    const sessionStore = fakeSessionStore(
      fakeSession({ working_plan: enriched }),
    );
    const llm = makeFakeLlm(JSON.stringify(weekPlan()));

    const handler = createRevisionHandler({ sessionStore, llm });

    await expect(handler.onReply(threadReply())).resolves.toBeUndefined();
  });
});
