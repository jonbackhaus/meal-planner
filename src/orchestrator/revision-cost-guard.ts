import type { ModelRate } from "../config/config.js";
import { CostMeter } from "../cost/cost-meter.js";
import {
  LlmCallError,
  type LlmClient,
  type LlmResult,
  type RunQueryInput,
} from "../llm/llm-client.js";
import type {
  InboundThreadReply,
  RevisionHandler,
} from "../slack/inbound-router.js";
import type { AlertFn } from "./generate.js";
import type { RevisionSlackClient } from "./revision-post.js";
import type { SessionStore } from "./session-store.js";
import { canTransition, transition } from "./state-machine.js";

/**
 * B5 (bd meal-planner-3e2.6, ADR-0007 D5/D6/D7, SPEC §9.3): the revision
 * loop's three nested cost-cap guards, and the `paused_cost` pause/reset
 * machinery those guards drive.
 *
 * - **Per-response-cycle token cap** (≈150K) — bounds ONE revision cycle's
 *   own LLM spend (the mutation call plus its possible one-shot repair,
 *   ADR-0007 D2/ADR-0003 D5), enforced via `revisionCycleLlmClient` below.
 * - **Per-thread turn cap** (≈25) — bounds how many revision cycles a
 *   thread may run, total.
 * - **Per-thread cumulative $ budget** (≈5) — SHARED with generation (D5):
 *   this guard reads/extends the SAME session-row `turn_count`/`token_spend`/
 *   `cost_usd` fields `generateForWeek` (`./generate.ts`) already writes via
 *   its own `CostMeter` -- there is no separate revision-only pool.
 *
 * On any cap breach: the session row transitions to the durable `paused_cost`
 * status (D6, `./state-machine.ts`), `#agent-alerts` fires, and an in-thread
 * "paused for cost" note posts. A paused thread NEVER auto-resumes -- only
 * `resetPause` (an explicit operator action) clears it. `/mp-approved`
 * is unaffected (D7): `../todoist-commit/approval-handler.ts` never inspects
 * `status`, so a paused thread stays approvable with no change needed there
 * (confirmed by reading that module -- see its own doc comment).
 *
 * NOT wired into `index.ts` here -- composing this around B1-B4's output is
 * bd meal-planner-uo1's job. This module only builds and exports the
 * primitives:
 *
 *  - `createRevisionCostGuard(deps).wrapRevisionHandler(buildHandler, baseLlm)`
 *    -- wraps a `RevisionHandler` FACTORY (rather than a pre-built handler)
 *    so a fresh, per-cycle token-capped `LlmClient` can be constructed for
 *    EVERY cycle and threaded into `buildHandler` (uo1's closure over B1's
 *    `createRevisionHandler` + B2's `createRevisionPostHandler`/
 *    `guardOnRevised`, both of which take an injected `llm`). Recommended
 *    composition order (outermost first): `serializeRevisionHandler` (B4) ⊃
 *    this guard ⊃ `buildHandler` ⊃ B1/B2. Wrapping it that way means B4's
 *    per-`week_key` mutex (`runExclusive`) already serializes concurrent
 *    replies before this guard's read-check-write sequence ever runs (no
 *    separate locking needed here), and B4's own `finally` -- which only
 *    reverts `under_revision -> suggested` -- naturally leaves a `paused_cost`
 *    transition this guard made alone, with zero edits to `revision-
 *    coordinator.ts`.
 *  - `createRevisionCostGuard(deps).resetPause(weekKey)` -- the operator-only
 *    reset (D6). The command *surface* (CLI flag, Slack admin command) is
 *    ops detail left to uo1/later work; this is the reset logic + state
 *    transition itself.
 */

/** The three nested guards (SPEC §9.3), config values -- mirrors how `Config.generationDollarCap` is configured (`../config/config.ts`). */
export interface RevisionCostCaps {
  /** Per-response-cycle token cap (≈150K) -- one revision cycle's own spend. */
  cycleTokenCap: number;
  /** Per-thread turn cap (≈25) -- total revision cycles run on this thread. */
  threadTurnCap: number;
  /** Per-thread cumulative $ budget (≈5) -- SHARED with generation spend (D5). */
  threadDollarCap: number;
}

/**
 * Thrown by `revisionCycleLlmClient` once a single cycle's own token usage
 * exceeds `cycleTokenCap` -- mirrors `CostCapExceededError`'s shape
 * (`../cost/cost-cap-exceeded-error.ts`) but on a TOKEN count, not a dollar
 * figure (the per-cycle guard is token-denominated per SPEC §9.3). Swallowed
 * by `createRevisionHandler`'s own try/catch (`./revision.ts` never
 * propagates a mutation failure out of `onReply`) -- that's fine and even
 * desirable: it stops the cycle from spending further, and
 * `createRevisionCostGuard`'s `wrapRevisionHandler` independently detects the
 * breach afterward by reading the per-cycle meter's final totals, not by
 * catching this error.
 */
export class RevisionCycleTokenCapExceededError extends Error {
  readonly tokens: number;
  readonly capTokens: number;

  constructor(tokens: number, capTokens: number) {
    super(
      `revision per-cycle token cap exceeded: ${tokens} tokens spent > ${capTokens} cap`,
    );
    this.name = "RevisionCycleTokenCapExceededError";
    this.tokens = tokens;
    this.capTokens = capTokens;
  }
}

/**
 * Decorates an `LlmClient` so every call made through it counts against
 * `cycleMeter` (a FRESH meter the caller resets per cycle -- see
 * `wrapRevisionHandler` below) and throws `RevisionCycleTokenCapExceededError`
 * once the cycle's cumulative tokens exceed `capTokens`. Same PRE-call /
 * POST-call gate shape as `../cost/metered-llm-client.ts`'s
 * `meteredLlmClient` (pre-call: already over cap -> refuse before spending
 * more; post-call: the call that tripped it is still recorded), just
 * token-denominated instead of dollar-denominated -- reuses `CostMeter` for
 * the actual accumulation (SPEC §9.3's existing tracking primitive) rather
 * than inventing a parallel one.
 */
export function revisionCycleLlmClient(
  inner: LlmClient,
  cycleMeter: CostMeter,
  capTokens: number,
): LlmClient {
  return {
    async runQuery(input: RunQueryInput): Promise<LlmResult> {
      const preTotals = cycleMeter.totals();
      const preTokens = preTotals.inputTokens + preTotals.outputTokens;
      if (preTokens > capTokens) {
        throw new RevisionCycleTokenCapExceededError(preTokens, capTokens);
      }

      let result: LlmResult;
      try {
        result = await inner.runQuery(input);
      } catch (error) {
        if (error instanceof LlmCallError) {
          cycleMeter.record(error.usage);
        }
        throw error;
      }
      cycleMeter.record(result.usage);

      const postTotals = cycleMeter.totals();
      const postTokens = postTotals.inputTokens + postTotals.outputTokens;
      if (postTokens > capTokens) {
        throw new RevisionCycleTokenCapExceededError(postTokens, capTokens);
      }
      return result;
    },
  };
}

export interface RevisionCostGuardDeps {
  /** Only the two methods this guard needs -- keeps it decoupled from the full `SessionStore` surface (matches `revision-coordinator.ts`'s own narrowing convention). */
  sessionStore: Pick<SessionStore, "get" | "update">;
  caps: RevisionCostCaps;
  /** The resolved per-model rate to price a cycle's tokens into `cost_usd` -- e.g. `config.modelRates[config.model]`, the SAME value `generateForWeek`'s `CostMeter` is constructed with. */
  rate: ModelRate;
  /** The `#agent-alerts` notifier (SPEC §9.4/E6) -- same `AlertFn` shape `generateForWeek` uses (`./generate.ts`), never-throwing by convention. */
  alert: AlertFn;
  /** Slack client + target channel for the in-thread "paused for cost" note -- reuses B2's `RevisionSlackClient` shape (`./revision-post.ts`) rather than defining a new one. */
  slack: RevisionSlackClient;
  channelId: string;
  /** Injected clock for `SessionStore.update`'s `updated_at`; defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

const PAUSED_NOTE_TEXT =
  "This week's plan revisions are paused for cost -- an operator must " +
  "reset the thread's budget before further edits are processed. " +
  "Approving the current plan (`/mp-approved`) still works.";

export interface RevisionCostGuard {
  /**
   * Wraps a `RevisionHandler` FACTORY (see the module doc comment for why a
   * factory, not a pre-built handler) so each `onReply`:
   *
   *  1. Never proceeds on an already-`paused_cost` week (D6) -- no LLM call,
   *     no spend, just a log line.
   *  2. PRE-checks the thread-level caps (turn count, cumulative $) against
   *     what's already on the row -- a cap already at/over its limit pauses
   *     immediately, without running (spending on) this cycle at all.
   *  3. Builds a FRESH per-cycle `CostMeter` + `revisionCycleLlmClient`
   *     (the per-cycle token cap) and hands it to `buildHandler`, then runs
   *     the resulting handler's `onReply`.
   *  4. Regardless of outcome (success, a swallowed internal error, or a
   *     thrown `RevisionCycleTokenCapExceededError`), folds the cycle's
   *     actual spend into the row's SHARED `turn_count`/`token_spend`/
   *     `cost_usd` (extending -- never replacing -- whatever generation
   *     already recorded there, per D5), then checks all three caps against
   *     the NEW totals and pauses if any is breached.
   *
   * Never throws out of `onReply` -- matches every other `RevisionHandler`
   * decorator in this codebase's "never let one bad message wedge the
   * listener" contract (`./revision.ts`, `./revision-debounce.ts`,
   * `./revision-coordinator.ts`).
   */
  wrapRevisionHandler(
    buildHandler: (llm: LlmClient) => RevisionHandler,
    baseLlm: LlmClient,
  ): RevisionHandler;

  /**
   * Operator-only reset (D6): clears a `paused_cost` week back to
   * `suggested` AND zeroes `turn_count`/`token_spend`/`cost_usd` -- a fresh
   * per-thread budget window, since leaving the cumulative totals in place
   * would immediately re-trip the $ (and likely turn) cap on the very next
   * revision attempt, defeating the point of a reset. A no-op (logged) if
   * `weekKey` has no row, or the row isn't currently `paused_cost` -- this is
   * a targeted un-pause, not a general-purpose row editor.
   *
   * The command *surface* (CLI flag, Slack admin command) binding this to an
   * actual operator action is ops detail, left to uo1/a later task; this is
   * the reset logic + state transition itself.
   */
  resetPause(weekKey: string): void;
}

export function createRevisionCostGuard(
  deps: RevisionCostGuardDeps,
): RevisionCostGuard {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;

  async function postPausedNote(
    weekKey: string,
    threadTs: string,
  ): Promise<void> {
    try {
      await deps.slack.chat.postMessage({
        channel: deps.channelId,
        text: PAUSED_NOTE_TEXT,
        mrkdwn: true,
        thread_ts: threadTs,
      });
    } catch (err) {
      logger.error(
        `[revision-cost-guard] failed to post the paused-for-cost note for week ${weekKey}: ${String(err)}`,
      );
    }
  }

  /**
   * Transitions `weekKey` to `paused_cost` (if legal from its current
   * status), alerts `#agent-alerts`, and posts the in-thread note. A no-op
   * (besides a warn log) if the row is missing or already `paused_cost` --
   * this can legitimately race with a concurrent pause attempt (e.g. the
   * turn cap AND the $ cap both breach on the same cycle) and must not
   * double-alert or throw `IllegalTransitionError`.
   */
  async function pauseForCost(
    weekKey: string,
    threadTs: string | undefined,
    reason: string,
  ): Promise<void> {
    const session = deps.sessionStore.get(weekKey);
    if (!session) {
      logger.warn(
        `[revision-cost-guard] cannot pause week ${weekKey}: no session row`,
      );
      return;
    }
    if (session.status === "paused_cost") {
      return;
    }
    if (!canTransition(session.status, "paused_cost")) {
      logger.warn(
        `[revision-cost-guard] cannot pause week ${weekKey}: illegal transition from ${session.status}`,
      );
      return;
    }

    transition(
      deps.sessionStore,
      weekKey,
      "paused_cost",
      {},
      now().toISOString(),
    );
    logger.warn(
      `[revision-cost-guard] week ${weekKey} revision paused for cost: ${reason}`,
    );
    await deps.alert(`revision paused for cost on week ${weekKey}: ${reason}`);
    if (threadTs) {
      await postPausedNote(weekKey, threadTs);
    }
  }

  return {
    wrapRevisionHandler(
      buildHandler: (llm: LlmClient) => RevisionHandler,
      baseLlm: LlmClient,
    ): RevisionHandler {
      return {
        async onReply(reply: InboundThreadReply): Promise<void> {
          const session = deps.sessionStore.get(reply.weekKey);
          if (!session) {
            // No row -- let downstream's own no-row handling apply
            // (createRevisionHandler logs+drops); nothing for THIS guard to
            // check or spend against.
            await buildHandler(baseLlm).onReply(reply);
            return;
          }

          if (session.status === "paused_cost") {
            logger.log(
              `[revision-cost-guard] week ${reply.weekKey} is paused for cost; not proceeding (operator reset required)`,
            );
            return;
          }

          if (session.turn_count >= deps.caps.threadTurnCap) {
            await pauseForCost(
              reply.weekKey,
              reply.threadTs,
              `thread turn cap (${deps.caps.threadTurnCap}) already reached (${session.turn_count} turns)`,
            );
            return;
          }
          if (session.cost_usd >= deps.caps.threadDollarCap) {
            await pauseForCost(
              reply.weekKey,
              reply.threadTs,
              `thread dollar budget ($${deps.caps.threadDollarCap}) already reached ($${session.cost_usd.toFixed(2)})`,
            );
            return;
          }

          const cycleMeter = new CostMeter(deps.rate);
          const guardedLlm = revisionCycleLlmClient(
            baseLlm,
            cycleMeter,
            deps.caps.cycleTokenCap,
          );

          try {
            await buildHandler(guardedLlm).onReply(reply);
          } finally {
            const cycleTotals = cycleMeter.totals();
            const cycleTokens =
              cycleTotals.inputTokens + cycleTotals.outputTokens;
            const newTurnCount = session.turn_count + 1;
            const newTokenSpend = session.token_spend + cycleTokens;
            const newCostUsd = session.cost_usd + cycleTotals.costUsd;

            deps.sessionStore.update(reply.weekKey, {
              turn_count: newTurnCount,
              token_spend: newTokenSpend,
              cost_usd: newCostUsd,
              updated_at: now().toISOString(),
            });

            const overCycleTokens = cycleTokens > deps.caps.cycleTokenCap;
            const overTurnCap = newTurnCount >= deps.caps.threadTurnCap;
            const overDollarCap = newCostUsd >= deps.caps.threadDollarCap;

            if (overCycleTokens || overTurnCap || overDollarCap) {
              const reason = overCycleTokens
                ? `per-cycle token cap (${deps.caps.cycleTokenCap}) exceeded (${cycleTokens} tokens this cycle)`
                : overTurnCap
                  ? `thread turn cap (${deps.caps.threadTurnCap}) reached (${newTurnCount} turns)`
                  : `thread dollar budget ($${deps.caps.threadDollarCap}) reached ($${newCostUsd.toFixed(2)})`;
              await pauseForCost(reply.weekKey, reply.threadTs, reason);
            }
          }
        },
      };
    },

    resetPause(weekKey: string): void {
      const session = deps.sessionStore.get(weekKey);
      if (!session) {
        logger.warn(
          `[revision-cost-guard] resetPause: no session row for week ${weekKey}`,
        );
        return;
      }
      if (session.status !== "paused_cost") {
        logger.warn(
          `[revision-cost-guard] resetPause: week ${weekKey} is not paused_cost (status=${session.status}); ignoring`,
        );
        return;
      }

      transition(
        deps.sessionStore,
        weekKey,
        "suggested",
        { turn_count: 0, token_spend: 0, cost_usd: 0 },
        now().toISOString(),
      );
      logger.log(
        `[revision-cost-guard] operator reset: week ${weekKey} pause cleared, budget reset`,
      );
    },
  };
}
