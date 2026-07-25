import type { LlmClient } from "../llm/llm-client.js";
import { type EnrichedWeekPlan, enrichPlan } from "../planner/enrich.js";
import type { Pools } from "../planner/pools.js";
import {
  llmSelectFromPrompt,
  resolvePrepUnits,
  type WeekPlan,
} from "../planner/select.js";
import {
  PlanValidationError,
  type ValidatePlanConfig,
  type ValidationIssue,
  validateWeekPlan,
} from "../planner/validate.js";
import type { Recipe, RecipeCandidate } from "../recipe-mcp/schema.js";
import { renderPlan } from "../slack/render.js";
import { buildRevisionPrompt, type RevisionResult } from "./revision.js";

/**
 * B2 (bd meal-planner-3e2.3, ADR 0007 D2): the `onRevised` seam B1
 * (`./revision.ts`, bd meal-planner-3e2.2) hands a completed mutation to.
 * Runs the revised `WeekPlan` through the SAME deterministic validation +
 * one bounded repair retry generation uses (ADR 0003 D5, `../planner/
 * validate.js`'s `validateWeekPlan`/`PlanValidationError` — reused, never
 * redefined), then renders it with the SAME `renderPlan` (`../slack/
 * render.js`) generation uses and posts it as a NEW reply in the session's
 * thread (`chat.postMessage` with `thread_ts` set) — never an edit.
 *
 * Deliberately OUT of scope here (left to their own beads):
 *  - debouncing rapid replies (ADR 0007 D3) — bd meal-planner-3e2.4 (B3).
 *  - single-writer serialization, the `under_revision` transition, and
 *    writing the revised plan back onto the session row (ADR 0007 D4) — bd
 *    meal-planner-3e2.5 (B4). This module never touches `SessionStore`.
 *  - the shared per-thread cost budget / pause-resume (ADR 0007 D5/D6/D7) —
 *    bd meal-planner-3e2.6 (B5).
 *  - wiring `createRevisionPostHandler`'s output into `createRevisionHandler`
 *    / the daemon boot path (index.ts) — left as a follow-up; this module
 *    only builds and exports the real seam implementation.
 */

/**
 * `validateWeekPlan` (ADR 0003 D5) checks pool MEMBERSHIP against the
 * candidate pools composed at GENERATION time — but those pools are never
 * persisted (ADR 0002's session row carries `working_plan` only), and a
 * revision mutates the plan directly rather than re-running retrieval (ADR
 * 0007 D1). So there is no stale retrieval pool to validate a revision
 * against.
 *
 * Instead, this builds a ground-truth pool via a live `get_recipe` lookup
 * (the SAME Recipe MCP primitive `enrichPlan` already uses, `../planner/
 * enrich.js`) for every id the revised plan actually references — its
 * "real recipe_id" guarantee (ADR 0007 D2) is at least as strong as
 * membership in a possibly-hours-stale retrieval pool. A `Recipe` is a
 * structural superset of `RecipeCandidate` (`recipe-mcp/schema.ts`), so the
 * fetched records slot directly into `validateWeekPlan`'s `Pools` shape with
 * no reshaping. An id `get_recipe` can't resolve is simply left OUT of the
 * pool — `validateWeekPlan`'s existing membership check then reports it as a
 * violation (a hallucinated/deleted id), exactly as it does at generation
 * time for an id missing from the real retrieval pool.
 *
 * Mains are placed in the pool matching their own `slot_type` (mirrors
 * `composePools`'s weeknight/weekend split); a `second_dish` id is placed in
 * BOTH (its own `checkMealsIndividually` check accepts either, via
 * `findInPools`); a `side` id is placed in `sides`.
 */
async function buildRevisionValidationPools(
  plan: WeekPlan,
  getRecipe: (id: string) => Promise<Recipe | null>,
): Promise<Pools> {
  const weeknight: RecipeCandidate[] = [];
  const weekend: RecipeCandidate[] = [];
  const sides: RecipeCandidate[] = [];
  const cache = new Map<string, RecipeCandidate | null>();

  const fetchCandidate = async (
    id: string,
  ): Promise<RecipeCandidate | null> => {
    if (cache.has(id)) {
      return cache.get(id) ?? null;
    }
    const recipe = await getRecipe(id);
    cache.set(id, recipe);
    return recipe;
  };

  for (const meal of plan.meals) {
    const own = await fetchCandidate(meal.recipe_id);
    if (own) {
      (meal.slot_type === "constrained" ? weeknight : weekend).push(own);
    }
    if (meal.veg.kind === "second_dish") {
      const second = await fetchCandidate(meal.veg.recipe_id);
      if (second) {
        weeknight.push(second);
        weekend.push(second);
      }
    }
    if (meal.side) {
      const side = await fetchCandidate(meal.side.recipe_id);
      if (side) {
        sides.push(side);
      }
    }
  }

  return { weeknight, weekend, sides };
}

/**
 * Builds the ONE repair prompt for a revised plan that failed validation —
 * mirrors `../planner/validate.js`'s `buildRepairPrompt` PATTERN (re-render
 * the base prompt, then append a REPAIR section quoting the invalid response
 * plus every violation) but built on `buildRevisionPrompt` (the MUTATION
 * base prompt, `./revision.js`) rather than generation's
 * `buildSelectionPrompt` — a revision has no `PlannerInput`/candidate pools
 * to re-render.
 */
export function buildRevisionRepairPrompt(
  currentPlan: WeekPlan,
  messages: string[],
  invalidPlan: WeekPlan,
  issues: ValidationIssue[],
): string {
  const basePrompt = buildRevisionPrompt(currentPlan, messages);
  const issueLines = issues.map((issue) => `- ${issue}`).join("\n");

  return (
    `${basePrompt}\n\n` +
    "REPAIR\n" +
    "Your previous revised plan below FAILED validation. Previous response:\n" +
    `${JSON.stringify(invalidPlan)}\n\n` +
    "Problems (fix EVERY one of these; do not introduce new ones):\n" +
    `${issueLines}\n\n` +
    "Return ONLY a corrected WeekPlan JSON object, in the exact same shape as " +
    "CURRENT PLAN above, that resolves every problem above. No prose, no markdown fences."
  );
}

/**
 * The slice of a Slack Web API client this module needs to post a THREAD
 * REPLY (`thread_ts` set) — narrower than (but structurally satisfied by) a
 * real `@slack/web-api` `WebClient`, mirroring `../slack/slack-poster.js`'s
 * own `SlackPostMessageClient` narrowing, extended with the `thread_ts` this
 * module always sets (append-only, ADR 0007 D2 — this module never calls
 * `chat.update`).
 */
export interface RevisionSlackClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      mrkdwn: boolean;
      thread_ts: string;
    }): Promise<{ ok?: boolean; ts?: string; error?: string }>;
  };
}

/**
 * Posts `plan` as a NEW reply in the thread named by `threadTs` — never an
 * edit. Mirrors `SlackPoster.post`'s render + error-handling shape
 * (`../slack/slack-poster.js`) exactly, with `thread_ts` added; deliberately
 * does not reuse `SlackPoster` itself (that class has no thread-reply mode)
 * to avoid widening its top-level-post contract for this one caller.
 */
async function postRevisionReply(
  plan: EnrichedWeekPlan,
  threadTs: string,
  deps: { slack: RevisionSlackClient; channelId: string },
): Promise<{ ts: string }> {
  const text = renderPlan(plan, {
    nightSchedule: plan.nightSchedule,
    prep: resolvePrepUnits(plan),
  });

  let response: { ok?: boolean; ts?: string; error?: string };
  try {
    response = await deps.slack.chat.postMessage({
      channel: deps.channelId,
      text,
      mrkdwn: true,
      thread_ts: threadTs,
    });
  } catch (err) {
    // Same no-secret-leakage discipline as SlackPoster.post: only the
    // typed, safe Slack error code (never .message/.stack/.original).
    const code =
      typeof (err as { data?: { error?: unknown } })?.data?.error === "string"
        ? (err as { data: { error: string } }).data.error
        : undefined;
    throw new Error(
      `Slack chat.postMessage (revision reply) failed for channel ${deps.channelId}` +
        (code ? ` (error: ${code})` : ""),
    );
  }

  if (response.ok === false) {
    throw new Error(
      `Slack chat.postMessage (revision reply) returned ok:false for channel ${deps.channelId}${
        response.error ? ` (error: ${response.error})` : ""
      }`,
    );
  }

  if (!response.ts) {
    throw new Error(
      `Slack chat.postMessage (revision reply) returned no ts for channel ${deps.channelId}`,
    );
  }

  return { ts: response.ts };
}

export interface RevisionPostDeps {
  /**
   * Recipe MCP `get_recipe` lookup, bound (mirrors `EnrichPlanDeps.
   * getRecipe`, `../planner/enrich.js`) — used both to build the ground-truth
   * validation pool (see `buildRevisionValidationPools`) and to re-enrich the
   * validated plan for rendering.
   */
  getRecipe: (id: string) => Promise<Recipe | null>;
  /**
   * The LLM client for the ONE bounded repair retry (ADR 0003 D5). Callers
   * should bind the SAME effort-capped client B1 already uses for the
   * mutation call (SPEC §9.3) — this module has no `Config` dependency of
   * its own and trusts the caller, the same way `RevisionHandlerDeps.llm`
   * already works.
   */
  llm: LlmClient;
  /**
   * Slot counts + optional overrides `validateWeekPlan` needs — the SAME
   * config generation validates against (`Config`'s slots/quickActiveMax/
   * maxPairedSides/calendarEnabled).
   */
  validateConfig: ValidatePlanConfig;
  /** Slack client + target channel for the new thread reply. */
  slack: RevisionSlackClient;
  channelId: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Builds the real `onRevised` implementation (`RevisionHandlerDeps.
 * onRevised`, `./revision.js`): validate (+ one bounded repair) the revised
 * plan (ADR 0003 D5), then post it as a NEW thread reply (ADR 0007 D2).
 *
 * On a residual validation failure (still invalid after the one repair),
 * throws `PlanValidationError` — `createRevisionHandler`'s `onReply` already
 * wraps its `onRevised` call in a catch-and-log (`./revision.js`), so this
 * never needs its own top-level guard; callers invoking this function
 * directly (e.g. tests) see the throw.
 *
 * Never writes to the session store: persisting the revised `working_plan`
 * and the `under_revision` transition is bd meal-planner-3e2.5 (B4)'s job.
 */
export function createRevisionPostHandler(
  deps: RevisionPostDeps,
): (result: RevisionResult) => Promise<void> {
  const logger = deps.logger ?? console;

  return async (result: RevisionResult): Promise<void> => {
    let plan = result.revisedPlan;
    let pools = await buildRevisionValidationPools(plan, deps.getRecipe);
    let issues = validateWeekPlan(plan, pools, deps.validateConfig);

    if (issues.length > 0) {
      logger.warn(
        `[revision-post] revised plan for week ${result.weekKey} failed validation ` +
          `(${issues.length} issue(s)); attempting the one bounded repair retry`,
      );
      const repairPrompt = buildRevisionRepairPrompt(
        result.sourcePlan,
        result.messages,
        plan,
        issues,
      );
      plan = await llmSelectFromPrompt(repairPrompt, { llm: deps.llm });
      pools = await buildRevisionValidationPools(plan, deps.getRecipe);
      issues = validateWeekPlan(plan, pools, deps.validateConfig);
      if (issues.length > 0) {
        throw new PlanValidationError(issues);
      }
    }

    const enriched = await enrichPlan(plan, { getRecipe: deps.getRecipe });
    const { ts } = await postRevisionReply(enriched, result.threadTs, {
      slack: deps.slack,
      channelId: deps.channelId,
    });

    logger.log(
      `[revision-post] posted revised plan for week ${result.weekKey} as a NEW ` +
        `thread reply (ts=${ts}, thread_ts=${result.threadTs}); session row ` +
        "write-back (working_plan/under_revision) is bd meal-planner-3e2.5 (B4)'s job",
    );
  };
}
