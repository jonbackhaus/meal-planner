import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import type { SelectedMeal, WeekPlan } from "../planner/select.js";
import type { ValidatePlanConfig } from "../planner/validate.js";
import type { Recipe } from "../recipe-mcp/schema.js";
import type { RevisionResult } from "./revision.js";
import {
  buildRevisionRepairPrompt,
  createRevisionPostHandler,
  type RevisionSlackClient,
} from "./revision-post.js";

/**
 * `revision-post.ts` tests (bd meal-planner-3e2.3, ADR 0007 D2). No real
 * network: the LLM and Slack client are both plain `vi.fn` stand-ins, and
 * `getRecipe` is a local in-memory fake -- never the real Recipe MCP or
 * `@slack/web-api` `WebClient`.
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

function meal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
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

function weekPlan(meals: SelectedMeal[] = [meal()]): WeekPlan {
  return { week_key: "2026-07-12", meals, summary: "A tasty week." };
}

function revisionResult(
  overrides: Partial<RevisionResult> = {},
): RevisionResult {
  return {
    weekKey: "2026-07-12",
    threadTs: "1000.0001",
    sourcePlan: weekPlan(),
    revisedPlan: weekPlan(),
    messages: ["swap Tuesday for tacos"],
    ...overrides,
  };
}

const cfg: ValidatePlanConfig = { slots: { constrained: 1, relaxed: 0 } };

function fakeRecipeStore(
  recipes: Record<string, Recipe>,
): (id: string) => Promise<Recipe | null> {
  return async (id: string) => recipes[id] ?? null;
}

function fakeSlack(
  response: { ok?: boolean; ts?: string; error?: string } = {
    ok: true,
    ts: "2000.0001",
  },
): { slack: RevisionSlackClient; postMessage: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn().mockResolvedValue(response);
  return { slack: { chat: { postMessage } }, postMessage };
}

describe("createRevisionPostHandler", () => {
  it("posts a VALID revised plan as a NEW thread reply (thread_ts set, never chat.update) without repairing", async () => {
    const revised = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const { slack, postMessage } = fakeSlack();
    const llm = makeFakeLlm(); // no repair call expected
    const getRecipe = fakeRecipeStore({ "recipe-1": recipe("recipe-1") });

    const handler = createRevisionPostHandler({
      getRecipe,
      llm,
      validateConfig: cfg,
      slack,
      channelId: "C123",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler(
      revisionResult({ revisedPlan: revised, threadTs: "1000.0001" }),
    );

    expect(llm.runQuery).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0];
    expect(call.channel).toBe("C123");
    expect(call.thread_ts).toBe("1000.0001");
    expect(call.mrkdwn).toBe(true);
    // The posted text is the rendered plan -- proves the EXISTING renderPlan
    // is reused, not a redefined renderer.
    expect(call.text).toContain("Veggie Chili");
  });

  it("repairs an INVALID revised plan once (via the LLM), then posts the repaired plan", async () => {
    // Invalid: recipe_id "ghost" does not resolve via getRecipe -- a
    // hallucinated / unknown id, the same failure mode a stale retrieval
    // pool would catch at generation time.
    const invalid = weekPlan([meal({ recipe_id: "ghost" })]);
    const repaired = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const { slack, postMessage } = fakeSlack();
    const llm = makeFakeLlm(JSON.stringify(repaired));
    const getRecipe = fakeRecipeStore({ "recipe-1": recipe("recipe-1") });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const handler = createRevisionPostHandler({
      getRecipe,
      llm,
      validateConfig: cfg,
      slack,
      channelId: "C123",
      logger,
    });

    await handler(revisionResult({ revisedPlan: invalid }));

    // Exactly ONE bounded repair call -- no unbounded retry loop.
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toContain("Veggie Chili");
  });

  it("throws PlanValidationError (never posts) when the plan is STILL invalid after the one repair", async () => {
    const invalid = weekPlan([meal({ recipe_id: "ghost" })]);
    const stillInvalid = weekPlan([meal({ recipe_id: "still-ghost" })]);
    const { slack, postMessage } = fakeSlack();
    const llm = makeFakeLlm(JSON.stringify(stillInvalid));
    const getRecipe = fakeRecipeStore({ "recipe-1": recipe("recipe-1") });

    const handler = createRevisionPostHandler({
      getRecipe,
      llm,
      validateConfig: cfg,
      slack,
      channelId: "C123",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      handler(revisionResult({ revisedPlan: invalid })),
    ).rejects.toThrow(/plan validation failed/);

    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("never calls chat.update -- the Slack client fake exposes no such method to call", async () => {
    const revised = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const { slack, postMessage } = fakeSlack();
    const llm = makeFakeLlm();
    const getRecipe = fakeRecipeStore({ "recipe-1": recipe("recipe-1") });

    const handler = createRevisionPostHandler({
      getRecipe,
      llm,
      validateConfig: cfg,
      slack,
      channelId: "C123",
    });

    await handler(revisionResult({ revisedPlan: revised }));

    // Only postMessage exists on the fake client at all -- an edit-in-place
    // implementation would need to call something else (chat.update), which
    // this fake doesn't even provide.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(slack.chat)).toEqual(["postMessage"]);
  });

  it("posts to the SAME thread_ts across repeated revisions -- always append, never a different message", async () => {
    const revised = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const { slack, postMessage } = fakeSlack();
    const getRecipe = fakeRecipeStore({ "recipe-1": recipe("recipe-1") });

    const handler = createRevisionPostHandler({
      getRecipe,
      llm: makeFakeLlm(),
      validateConfig: cfg,
      slack,
      channelId: "C123",
    });

    await handler(
      revisionResult({ revisedPlan: revised, threadTs: "1000.0001" }),
    );
    await handler(
      revisionResult({ revisedPlan: revised, threadTs: "1000.0001" }),
    );

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0][0].thread_ts).toBe("1000.0001");
    expect(postMessage.mock.calls[1][0].thread_ts).toBe("1000.0001");
  });

  it("throws (never posts) when the Slack postMessage rejects", async () => {
    const revised = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const postMessage = vi.fn().mockRejectedValue(new Error("network down"));
    const slack: RevisionSlackClient = { chat: { postMessage } };
    const getRecipe = fakeRecipeStore({ "recipe-1": recipe("recipe-1") });

    const handler = createRevisionPostHandler({
      getRecipe,
      llm: makeFakeLlm(),
      validateConfig: cfg,
      slack,
      channelId: "C123",
    });

    await expect(
      handler(revisionResult({ revisedPlan: revised })),
    ).rejects.toThrow();
  });
});

describe("buildRevisionRepairPrompt", () => {
  it("carries the current plan, the family messages, the invalid response, and every issue", () => {
    const current = weekPlan([meal({ recipe_id: "recipe-1" })]);
    const invalid = weekPlan([meal({ recipe_id: "ghost" })]);

    const prompt = buildRevisionRepairPrompt(
      current,
      ["swap Tuesday for tacos"],
      invalid,
      [
        'meal 1 (recipe_id="ghost", slot_type=constrained): recipe_id not found in the weeknight pool',
      ],
    );

    expect(prompt).toContain('"recipe_id": "recipe-1"'); // current plan, verbatim
    expect(prompt).toContain("swap Tuesday for tacos"); // family message
    expect(prompt).toContain('"recipe_id":"ghost"'); // invalid previous response (compact JSON)
    expect(prompt).toContain("recipe_id not found in the weeknight pool"); // the issue
    expect(prompt.toUpperCase()).toContain("REPAIR");
  });
});
