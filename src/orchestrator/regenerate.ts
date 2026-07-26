import type { CostMeter } from "../cost/cost-meter.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import type {
  RegenerateHandler,
  RegenerateMealPlanCommand,
} from "../slack/slash-commands.js";
import type { AlertFn, BuildPlanFn } from "./generate.js";
import type { RevisionCoordinator } from "./revision-coordinator.js";
import {
  postRevisionReply,
  type RevisionSlackClient,
} from "./revision-post.js";
import type { Session, SessionStore } from "./session-store.js";
import { transition } from "./state-machine.js";

/**
 * bd meal-planner-8u6 (RATIFIED design 2026-07-26, ADR-0007 D2/D4):
 * `/mp-regenerate` -- a full-replace regenerate of the ACTIVE week's plan.
 * Where B1's revision (`./revision.ts`) MUTATES the existing `working_plan`
 * in place (ADR-0007 D1), `regenerateWeek` discards it and runs the SAME
 * generation selection path a week's first-ever generation uses (the
 * injected `buildPlan`, exactly `./generate.ts`'s own `BuildPlanFn` shape --
 * ADR-0003 D5's deterministic validation + one bounded repair retry is
 * already built into that pipeline, `../planner/build-plan.js`'s
 * `selectValidatedPlan` call, so this module does not re-implement any of
 * it).
 *
 * Differs from `./rerun.ts`'s `reRunWeek` (the OTHER full-regenerate path --
 * operator-CLI-only, `failed` rows only) in exactly the ways the ratified
 * design calls for:
 *  - Posts the fresh plan as a NEW reply in the SAME week thread
 *    (`thread_ts` preserved) via `./revision-post.js`'s `postRevisionReply`,
 *    reused as-is -- that function only cares about "an `EnrichedWeekPlan` +
 *    a `thread_ts`", not whether the plan came from a revision or a full
 *    regenerate. `reRunWeek`'s `generateForWeek` reuse posts a fresh
 *    TOP-LEVEL message instead, which would lose the thread.
 *  - Allowed from ANY non-`paused_cost` active-week status, INCLUDING
 *    `committed` -- transitions back to `suggested` (re-approval required;
 *    existing Todoist tasks untouched until a later `/mp-approve`
 *    soft-recommits, see `../orchestrator/state-machine.ts`'s
 *    `committed -> suggested` edge added for this). `reRunWeek` refuses
 *    every non-`failed` row instead.
 *  - Goes through the SAME `RevisionCoordinator` single-writer serialization
 *    B4 built (`./revision-coordinator.js`) and calls `.supersede(weekKey)`
 *    as its very first action -- mirroring
 *    `../todoist-commit/approval-handler.ts`'s `onApprove` -- so it always
 *    wins over (and is never later overwritten by) any in-flight targeted
 *    revision.
 *  - Refuses on an already-`paused_cost` thread (ADR-0007 D6: only an
 *    explicit operator reset -- never a regenerate -- may clear a cost
 *    pause) and, when a `meter` is supplied, folds this cycle's own spend
 *    ADDITIVELY onto the row's existing `turn_count`/`token_spend`/
 *    `cost_usd` (ADR-0007 D5's one shared per-thread pool -- the SAME
 *    accumulation `../cost/revision-cost-guard.ts`'s `wrapRevisionHandler`
 *    already does for a revision cycle), so a subsequent revision's own cap
 *    check sees this regenerate's spend too.
 *
 * NOT built here (left as explicit follow-ups, matching every other v3.0
 * module's own "composition is a later task" convention): wiring this into
 * `src/index.ts`'s `main()`/`RunDaemonOptions` (a `buildPlan` binding + a
 * per-cycle metered `llm`, mirroring `buildRevisionSystem`'s own factory
 * pattern) and `src/daemon/daemon.ts`'s `regenerateHandler` passthrough.
 */

export interface RegenerateWeekDeps {
  /** Only the two methods this handler needs -- keeps it decoupled from the full `SessionStore` surface (matches `revision-coordinator.ts`/`approval-handler.ts`'s own narrowing convention). */
  sessionStore: Pick<SessionStore, "get" | "update">;
  /** B4's single-writer serialization + supersede signal (`./revision-coordinator.js`) -- shared with the revision chain so approval/regenerate/revision never race the same row. */
  coordinator: Pick<RevisionCoordinator, "supersede" | "runExclusive">;
  /** The SAME `BuildPlanFn` shape a week's first generation uses (`./generate.js`) -- a full re-selection, ADR-0003 D5 validation/repair already built in. */
  buildPlan: BuildPlanFn;
  /** Slack client + target channel for the new thread reply (`./revision-post.js`'s `postRevisionReply`, reused as-is). */
  slack: RevisionSlackClient;
  channelId: string;
  /** The `#agent-alerts` notifier -- fired only when `buildPlan` itself fails (mirrors `generateForWeek`'s own failure alert). */
  alert: AlertFn;
  /**
   * Optional per-cycle spend tracker (SPEC §9.3, ADR-0007 D5). When
   * present, `reset()` at the start of this call and its `totals()` after
   * `buildPlan` resolves are folded ADDITIVELY onto the row's existing
   * `turn_count`/`token_spend`/`cost_usd`. Omitting it entirely preserves
   * the pre-cost-tracking behavior of only advancing `turn_count`.
   */
  meter?: CostMeter;
  /** Injected clock for `transition()`'s `updated_at`; defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * The additive `turn_count`/`token_spend`/`cost_usd` patch (ADR-0007 D5's
 * shared per-thread pool) -- mirrors `../cost/revision-cost-guard.ts`'s own
 * `session.token_spend + cycleTokens` accumulation, just for a regenerate
 * cycle instead of a revision cycle. `turn_count` always advances by
 * exactly one, even with no `meter` supplied.
 */
function accumulatedSpendPatch(
  before: Session,
  meter: CostMeter | undefined,
): { turn_count: number; token_spend?: number; cost_usd?: number } {
  if (!meter) {
    return { turn_count: before.turn_count + 1 };
  }
  const totals = meter.totals();
  return {
    turn_count: before.turn_count + 1,
    token_spend: before.token_spend + totals.inputTokens + totals.outputTokens,
    cost_usd: before.cost_usd + totals.costUsd,
  };
}

/**
 * Runs one full-replace regenerate cycle for `weekKey`, serialized through
 * `deps.coordinator.runExclusive` (the SAME per-`week_key` mutex the
 * revision chain uses). Benign no-ops (logged, no throw): no session row for
 * `weekKey`, an already-`paused_cost` row, or a row with no `thread_ts` yet.
 * Only a real `buildPlan`/post/transition failure propagates (after
 * alerting) -- mirrors `../todoist-commit/approval-handler.ts`'s own
 * un-guarded core-write style; the slash-command router's own top-level
 * try/catch is the final backstop (`../slack/slash-commands.js`).
 */
export async function regenerateWeek(
  weekKey: string,
  deps: RegenerateWeekDeps,
): Promise<void> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());

  await deps.coordinator.runExclusive(weekKey, async () => {
    // ADR-0007 D4-style: regenerate ALWAYS wins over an in-flight targeted
    // revision -- called first, before any other work, exactly like
    // ../todoist-commit/approval-handler.ts's own onApprove.
    deps.coordinator.supersede(weekKey);

    const before = deps.sessionStore.get(weekKey);
    if (!before) {
      logger.warn(`[regenerate] no session row for week ${weekKey}; ignoring`);
      return;
    }

    if (before.status === "paused_cost") {
      logger.log(
        `[regenerate] week ${weekKey} is paused for cost; not regenerating (operator reset required)`,
      );
      return;
    }

    const threadTs = before.thread_ts;
    if (!threadTs) {
      logger.warn(
        `[regenerate] week ${weekKey} has no thread_ts yet; ignoring`,
      );
      return;
    }

    deps.meter?.reset();

    let plan: EnrichedWeekPlan;
    try {
      plan = await deps.buildPlan(weekKey);
    } catch (e) {
      await deps.alert(
        `/mp-regenerate for week ${weekKey} failed during plan generation: ${String(e)}`,
      );
      throw e;
    }

    const { ts } = await postRevisionReply(plan, threadTs, {
      slack: deps.slack,
      channelId: deps.channelId,
    });

    transition(
      deps.sessionStore,
      weekKey,
      "suggested",
      { working_plan: plan, ...accumulatedSpendPatch(before, deps.meter) },
      now().toISOString(),
    );

    logger.log(
      `[regenerate] posted a freshly regenerated plan for week ${weekKey} as a NEW thread reply (ts=${ts}, thread_ts=${threadTs}); status -> suggested`,
    );
  });
}

/**
 * Builds the real `RegenerateHandler` (`../slack/slash-commands.js`'s
 * `/mp-regenerate` seam): forwards the resolved command's `weekKey` straight
 * into `regenerateWeek`. A thin adapter, mirroring
 * `../todoist-commit/approval-handler.ts`'s own
 * `ApprovedMealPlanCommand -> onApprove` shape.
 */
export function createRegenerateHandler(
  deps: RegenerateWeekDeps,
): RegenerateHandler {
  return {
    onRegenerate(command: RegenerateMealPlanCommand): Promise<void> {
      return regenerateWeek(command.weekKey, deps);
    },
  };
}
