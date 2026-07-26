import type { LlmClient } from "../llm/llm-client.js";
import {
  type EnrichedWeekPlan,
  EnrichedWeekPlanSchema,
} from "../planner/enrich.js";
import {
  type LlmSelectDeps,
  llmSelectFromPrompt,
  type WeekPlan,
  WeekPlanSchema,
} from "../planner/select.js";
import type {
  InboundThreadReply,
  RevisionHandler,
} from "../slack/inbound-router.js";
import type { SessionStore } from "./session-store.js";

/**
 * B1 (bd meal-planner-3e2.2, ADR 0007 D1): a real `RevisionHandler` — plugged
 * into the A4 seam (`../slack/inbound-router.js`) via `runDaemon`'s
 * `revisionHandler` injection point — that runs a single BOUNDED LLM call to
 * MUTATE the active week's current `working_plan`, never a blind
 * `search_recipes` -> select re-run over the whole pool (D1's whole point:
 * unrelated meals stay stable across a reply that only touches one slot).
 *
 * Deliberately OUT of scope here (left as explicit seams below, NOT
 * implemented):
 *  - re-validating the mutated plan (ADR 0003 D5) and re-posting it as a new
 *    thread message (ADR 0007 D2) — bd meal-planner-3e2.3 (B2), now built as
 *    `createRevisionPostHandler` in `./revision-post.js`, which produces a
 *    real `onRevised` callback for a caller to inject here. This module
 *    itself only produces the revised `WeekPlan` and hands it to the
 *    injected `onRevised` callback; it never touches Slack or the session
 *    row's `working_plan` itself.
 *  - debouncing rapid replies into one call per burst (ADR 0007 D3) — bd
 *    meal-planner-3e2.4 (B3). `mutateWorkingPlan` already accepts an array of
 *    `messages` so B3 can batch multiple pending replies into one call
 *    without changing this module; `createRevisionHandler` itself is wired
 *    to the router's one-reply-at-a-time seam and folds a single message per
 *    call until B3 lands.
 *  - single-writer serialization / `under_revision` transitions (ADR 0007
 *    D4) — bd meal-planner-3e2.5 (B4).
 *  - the shared per-thread cost budget / pause-resume (ADR 0007 D5/D6/D7) —
 *    bd meal-planner-3e2.6 (B5). The LLM call here is intentionally simple
 *    (one call, no internal retry loop) so B5 can wrap it later.
 */

/**
 * Strips the `recipe`/`secondDishRecipe`/`sideRecipe` enrichment fields
 * `enrichPlan` (`../planner/enrich.js`) attaches, recovering the bare
 * `WeekPlan` shape (`../planner/select.js`) the mutation prompt/output use.
 * Re-validates via the EXISTING `WeekPlanSchema` (never redefined here) so a
 * shape drift between the two schemas fails loudly instead of silently
 * feeding a malformed "current plan" into the prompt.
 */
function stripEnrichment(plan: EnrichedWeekPlan): WeekPlan {
  return WeekPlanSchema.parse({
    week_key: plan.week_key,
    meals: plan.meals.map((meal) => ({
      slot_type: meal.slot_type,
      recipe_id: meal.recipe_id,
      title: meal.title,
      day: meal.day,
      veg: meal.veg,
      flags: meal.flags,
      rationale: meal.rationale,
      ...(meal.side !== undefined ? { side: meal.side } : {}),
    })),
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
    ...(plan.prep !== undefined ? { prep: plan.prep } : {}),
  });
}

/**
 * Recovers a `WeekPlan` from a session row's `working_plan` (typed `unknown`
 * at the store layer, ADR 0002). In practice `generateForWeek`
 * (`./generate.ts`) always stores the fully-enriched plan, so the
 * `EnrichedWeekPlanSchema` branch is the normal case; the bare
 * `WeekPlanSchema` fallback covers a plan that predates enrichment or a
 * future revision cycle that stores the pre-enrichment shape (B2's concern,
 * not decided here). Returns `null` — never throws — when neither shape
 * parses, so the caller can drop the reply and log rather than crash the
 * inbound listener.
 */
export function extractCurrentPlan(workingPlan: unknown): WeekPlan | null {
  if (workingPlan === null || workingPlan === undefined) {
    return null;
  }
  const enriched = EnrichedWeekPlanSchema.safeParse(workingPlan);
  if (enriched.success) {
    return stripEnrichment(enriched.data);
  }
  const bare = WeekPlanSchema.safeParse(workingPlan);
  return bare.success ? bare.data : null;
}

/**
 * Renders the bounded MUTATION prompt (ADR 0007 D1): frames the task as
 * applying the family's requested change(s) to the plan given verbatim in
 * the prompt, NOT a fresh selection. `messages` is plural — SPEC §7 / ADR
 * 0007 D3 "the family is plural" — every message this call is given is
 * folded in as reasoning context so the model can weigh possibly-conflicting
 * requests together; batching multiple PENDING replies into one call is B3's
 * job (debounce), not this function's — it renders whatever `messages` its
 * caller passes, one line each.
 */
export function buildRevisionPrompt(
  currentPlan: WeekPlan,
  messages: string[],
): string {
  const sections: string[] = [];

  sections.push(
    "TASK\n" +
      "The family replied in the Slack thread for this week's meal plan below, " +
      "requesting a change. MUTATE the existing plan below to apply their " +
      "requested change(s) — do NOT re-select the week from scratch. Every meal " +
      "that was not asked to change must come back EXACTLY as given (same " +
      "recipe_id, title, day, veg, flags, rationale, side).",
  );

  sections.push(
    `CURRENT PLAN (week_key "${currentPlan.week_key}")\n${JSON.stringify(currentPlan, null, 2)}`,
  );

  const messagesBlock = messages
    .map((message, i) => `${i + 1}. ${message}`)
    .join("\n");
  sections.push(
    "FAMILY REPLIES\n" +
      "This may be more than one family member, and their requests may " +
      "conflict — use your best judgment (e.g. prefer the more specific " +
      "request) and note in the changed meal's `rationale` how you resolved " +
      "any conflict.\n" +
      messagesBlock,
  );

  sections.push(
    "RULES\n" +
      "- Change ONLY the meal(s) the reply(ies) actually ask about; leave every other meal untouched.\n" +
      "- The vegetarian daughter constraint from the original plan still applies to every meal, every night, with no exceptions.\n" +
      "- No recipe may be repeated within the week (each recipe_id, including any second_dish or side, appears at most once).\n" +
      '- Flag any make-ahead meal with the exact tag "do-ahead" (lowercase, hyphenated) in its flags array.\n' +
      "- Do NOT add or remove meals unless a reply explicitly asks for that; otherwise keep the same number of meals.",
  );

  sections.push(
    "OUTPUT\n" +
      "Emit a SINGLE JSON object — the FULL revised plan, same shape as CURRENT " +
      "PLAN above (same keys: week_key, meals[], optional summary, optional " +
      "prep) — and nothing else: no prose, no markdown fences. Every meal from " +
      "CURRENT PLAN must appear, either unchanged or updated per the family's " +
      "request.",
  );

  return sections.join("\n\n");
}

/**
 * Runs the bounded mutation call (ADR 0007 D1): builds the prompt via
 * `buildRevisionPrompt` and delegates to the EXISTING `llmSelectFromPrompt`
 * (`../planner/select.js`) — the same one-call-in/`WeekPlan`-out primitive
 * generation uses — so the response is parsed/shape-validated against the
 * SAME `WeekPlanSchema`, never a redefined one. Semantic re-validation (pool
 * membership, veg-consistency, no-dupes, ADR 0003 D5) is explicitly NOT run
 * here — that is B2's (bd meal-planner-3e2.3) job, reusing the same
 * `selectValidatedPlan` repair pattern generation already uses.
 */
export async function mutateWorkingPlan(
  currentPlan: WeekPlan,
  messages: string[],
  deps: LlmSelectDeps,
): Promise<WeekPlan> {
  const prompt = buildRevisionPrompt(currentPlan, messages);
  return llmSelectFromPrompt(prompt, deps);
}

/** One completed mutation, handed to `onRevised` — see `RevisionHandlerDeps`. */
export interface RevisionResult {
  weekKey: string;
  threadTs: string;
  /** The plan the mutation started from (post-`extractCurrentPlan`). */
  sourcePlan: WeekPlan;
  /** The mutated plan, already shape-validated against `WeekPlanSchema`. */
  revisedPlan: WeekPlan;
  /** The family message(s) folded into this mutation call. */
  messages: string[];
}

export interface RevisionHandlerDeps {
  /** Only the read this handler needs — keeps it decoupled from the full `SessionStore` surface. */
  sessionStore: Pick<SessionStore, "get">;
  /**
   * The LLM client the mutation call runs against. Per SPEC §9.3, callers
   * should bind this to a client configured at `medium`/`low` effort — NOT
   * `high`/`xhigh` — for a revision; this module has no `Config` dependency
   * of its own and trusts the caller (index.ts) to have made that choice, the
   * same way `LlmSelectDeps` already works for generation.
   */
  llm: LlmClient;
  /**
   * Seam for B2 (bd meal-planner-3e2.3): invoked once a mutation succeeds.
   * The real implementation — re-validate `result.revisedPlan` (ADR 0003 D5)
   * and re-post it as a new thread message — is `createRevisionPostHandler`
   * (`./revision-post.js`); a caller assembling the daemon injects its
   * returned function here. B4 (bd meal-planner-3e2.5) still owns updating
   * the session row's `working_plan` / `under_revision` transition, which
   * neither this handler nor `revision-post.js` does. Defaults to a
   * log-only no-op so this handler is usable standalone without that
   * wiring.
   */
  onRevised?: (result: RevisionResult) => Promise<void> | void;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

function defaultOnRevised(
  logger: Pick<Console, "log">,
): (result: RevisionResult) => void {
  return (result) => {
    logger.log(
      `[revision] produced a mutated plan for week ${result.weekKey} (thread ${result.threadTs}); ` +
        "re-validation + re-post is not wired yet -- bd meal-planner-3e2.3 (B2) owns that.",
    );
  };
}

/** Pulls the reply's text out of the raw Slack event, if any. */
function extractMessageText(
  event: InboundThreadReply["event"],
): string | undefined {
  const text = event.text;
  return typeof text === "string" && text.trim().length > 0 ? text : undefined;
}

/**
 * Builds the real `RevisionHandler` (the A4 seam, `../slack/inbound-router.js`):
 * on each active-week thread reply, looks up the session row's current
 * `working_plan`, runs the bounded mutation call, and hands the result to
 * `onRevised`. Never throws out of `onReply` — a failure (no session row, an
 * unparseable `working_plan`, a failed/malformed LLM call) is logged and the
 * reply is dropped, matching the router's own "never let one bad message wedge
 * the listener" contract.
 */
export function createRevisionHandler(
  deps: RevisionHandlerDeps,
): RevisionHandler {
  const logger = deps.logger ?? console;
  const onRevised = deps.onRevised ?? defaultOnRevised(logger);

  return {
    async onReply(reply: InboundThreadReply): Promise<void> {
      const message = extractMessageText(reply.event);
      if (message === undefined) {
        logger.log(
          `[revision] reply for week ${reply.weekKey} carried no usable text; skipping`,
        );
        return;
      }

      const session = deps.sessionStore.get(reply.weekKey);
      const currentPlan = session
        ? extractCurrentPlan(session.working_plan)
        : null;
      if (!currentPlan) {
        logger.warn(
          `[revision] no usable working_plan for week ${reply.weekKey}; dropping reply`,
        );
        return;
      }

      try {
        const revisedPlan = await mutateWorkingPlan(currentPlan, [message], {
          llm: deps.llm,
        });
        await onRevised({
          weekKey: reply.weekKey,
          threadTs: reply.threadTs,
          sourcePlan: currentPlan,
          revisedPlan,
          messages: [message],
        });
      } catch (err) {
        logger.error(
          `[revision] mutation failed for week ${reply.weekKey}: ${String(err)}`,
        );
      }
    },
  };
}
