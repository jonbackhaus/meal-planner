import type {
  ResetHandler,
  ResetMealPlanCommand,
} from "../slack/slash-commands.js";
import type { RevisionCoordinator } from "./revision-coordinator.js";
import type { RevisionSlackClient } from "./revision-post.js";
import type { Session, SessionStatus, SessionStore } from "./session-store.js";
import { transition } from "./state-machine.js";

/**
 * bd meal-planner-2b2 (RATIFIED design 2026-07-26, builds on ADR-0007 D4 and
 * bd meal-planner-8u6's `/mp-regenerate`): `/mp-reset` -- an operator action
 * that discards any in-flight/pending revision work on the active week's
 * thread and reverts `working_plan` back to the MOST RECENT
 * successfully-posted plan (`last_posted_plan`, `./session-store.ts`),
 * keeping any already-accepted (committed) revision untouched.
 *
 * Three steps, exactly per the ratified design:
 *  1. Supersede/cancel any in-flight revision + clear the debounce/
 *     coordinator state -- reuses B4's `RevisionCoordinator.supersede`
 *     (`./revision-coordinator.js`), the SAME mechanism `regenerateWeek`
 *     (`./regenerate.js`) calls first for exactly the same reason: a late
 *     revision result that lands after this must not overwrite what reset
 *     just reverted to (`guardOnRevised`'s own supersede check already
 *     covers that), and any still-pending debounced burst
 *     (`./revision-debounce.js`) that later flushes finds the week
 *     superseded and is dropped by `serializeRevisionHandler`/
 *     `guardOnRevised` without this module needing to touch the debounce
 *     module's internal pending-burst map directly.
 *  2. `working_plan = last_posted_plan`.
 *  3. Post a brief in-thread confirmation (a NEW reply, never an edit).
 *     Unlike `./regenerate.js` (which reuses `./revision-post.js`'s
 *     `postRevisionReply` to render a fresh `EnrichedWeekPlan`), this posts a
 *     short plain-text note directly via the SAME `RevisionSlackClient`
 *     shape -- there is no new plan to render, only a revert of which draft
 *     is "current".
 *
 * State interactions (ratified): from `paused_cost`, reset ALSO clears the
 * pause (back to `suggested`) as an operator action; from `under_revision`,
 * it cancels the in-flight cycle (also landing on `suggested`). From any
 * OTHER status (e.g. already `suggested`, or `committed` with nothing
 * in-flight), the plan is still reverted but the status is left alone --
 * unlike `/mp-regenerate`, a plain reset never forces a `committed` week
 * back to `suggested` (no re-approval implied) since nothing ratified calls
 * for that.
 *
 * No new Todoist writes, no LLM call, no cost-meter interaction: unlike
 * `/mp-regenerate`, this never calls `buildPlan` -- `ResetWeekDeps` has no
 * such dependency at all, so this cycle costs nothing and never advances
 * `turn_count`/`token_spend`/`cost_usd`.
 *
 * NOT wired into `src/index.ts`'s `main()`/`src/daemon/daemon.ts` here --
 * matching every other v3.0 module's own "composition is a later task"
 * convention (see `./regenerate.ts`'s own doc comment) -- left as an
 * explicit follow-up (bd meal-planner-cny, which now also covers
 * `/mp-reset`).
 */

export interface ResetWeekDeps {
  /** Only the two methods this handler needs -- keeps it decoupled from the full `SessionStore` surface (matches `regenerate.ts`'s own narrowing convention). */
  sessionStore: Pick<SessionStore, "get" | "update">;
  /** B4's single-writer serialization + supersede signal (`./revision-coordinator.js`) -- shared with the revision/regenerate chain so approval/regenerate/revision/reset never race the same row. */
  coordinator: Pick<RevisionCoordinator, "supersede" | "runExclusive">;
  /** Slack client + target channel for the in-thread confirmation reply (`./revision-post.js`'s `RevisionSlackClient`, reused as-is). */
  slack: RevisionSlackClient;
  channelId: string;
  /** Injected clock for `transition()`'s `updated_at`; defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/** The brief in-thread confirmation `/mp-reset` posts once the revert lands. */
export const RESET_CONFIRMATION_TEXT =
  "This week's plan has been reset -- any in-flight/pending revision has " +
  "been discarded and the plan reverted to the last posted version.";

/**
 * Posts `RESET_CONFIRMATION_TEXT` as a NEW reply in `threadTs` -- never an
 * edit. Deliberately plain text (no `renderPlan`/`EnrichedWeekPlan`
 * rendering, unlike `./revision-post.ts`'s `postRevisionReply`): a reset
 * doesn't produce a NEW plan to show, only reverts which draft is current,
 * so a short confirmation note is all there is to say.
 */
async function postResetConfirmation(
  threadTs: string,
  deps: { slack: RevisionSlackClient; channelId: string },
): Promise<void> {
  await deps.slack.chat.postMessage({
    channel: deps.channelId,
    text: RESET_CONFIRMATION_TEXT,
    mrkdwn: true,
    thread_ts: threadTs,
  });
}

/**
 * The status `/mp-reset` lands the row on, per the ratified state
 * interactions: `paused_cost`/`under_revision` -> `suggested` (operator
 * clears the pause / cancels the in-flight cycle); every other status is
 * left exactly as-is (the plan is still reverted, but reset never forces a
 * status change beyond those two cases).
 */
function targetStatus(current: SessionStatus): SessionStatus {
  return current === "paused_cost" || current === "under_revision"
    ? "suggested"
    : current;
}

/**
 * Runs one reset cycle for `weekKey`, serialized through
 * `deps.coordinator.runExclusive` (the SAME per-`week_key` mutex the
 * revision/regenerate chain uses). Benign no-ops (logged, no throw): no
 * session row for `weekKey`, a row with no `thread_ts` yet (nothing to
 * confirm in), or a row with no `last_posted_plan` checkpoint yet (nothing
 * to revert to -- e.g. a row created before this checkpoint existed). Only a
 * real transition/post failure propagates -- the slash-command router's own
 * top-level try/catch is the final backstop (`../slack/slash-commands.js`),
 * mirroring `./regenerate.ts`'s own un-guarded core-write style.
 */
export async function resetWeek(
  weekKey: string,
  deps: ResetWeekDeps,
): Promise<void> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());

  await deps.coordinator.runExclusive(weekKey, async () => {
    // Cancel any in-flight targeted revision FIRST, exactly like
    // ../orchestrator/regenerate.ts's regenerateWeek: a late revision result
    // that lands after this must not overwrite the reverted plan
    // (guardOnRevised's own supersede check covers that), and any pending
    // debounced burst that later flushes is dropped the same way.
    deps.coordinator.supersede(weekKey);

    const before: Session | null = deps.sessionStore.get(weekKey);
    if (!before) {
      logger.warn(`[reset] no session row for week ${weekKey}; ignoring`);
      return;
    }

    const threadTs = before.thread_ts;
    if (!threadTs) {
      logger.warn(`[reset] week ${weekKey} has no thread_ts yet; ignoring`);
      return;
    }

    if (
      before.last_posted_plan === null ||
      before.last_posted_plan === undefined
    ) {
      logger.warn(
        `[reset] week ${weekKey} has no last_posted_plan checkpoint yet; ignoring`,
      );
      return;
    }

    const to = targetStatus(before.status);
    transition(
      deps.sessionStore,
      weekKey,
      to,
      { working_plan: before.last_posted_plan },
      now().toISOString(),
    );

    await postResetConfirmation(threadTs, {
      slack: deps.slack,
      channelId: deps.channelId,
    });

    logger.log(
      `[reset] week ${weekKey} reverted working_plan to the last posted checkpoint; status -> ${to}`,
    );
  });
}

/**
 * Builds the real `ResetHandler` (`../slack/slash-commands.js`'s
 * `/mp-reset` seam): forwards the resolved command's `weekKey` straight into
 * `resetWeek`. A thin adapter, mirroring `./regenerate.ts`'s own
 * `createRegenerateHandler`.
 */
export function createResetHandler(deps: ResetWeekDeps): ResetHandler {
  return {
    onReset(command: ResetMealPlanCommand): Promise<void> {
      return resetWeek(command.weekKey, deps);
    },
  };
}
