import type { TodoistCommitConfig } from "../config/profile.js";
import type { RevisionCoordinator } from "../orchestrator/revision-coordinator.js";
import type { SessionStore } from "../orchestrator/session-store.js";
import { transition } from "../orchestrator/state-machine.js";
import { EnrichedWeekPlanSchema } from "../planner/enrich.js";
import { type WeekPlan, WeekPlanSchema } from "../planner/select.js";
import type {
  ApprovalHandler,
  ApprovedMealPlanCommand,
} from "../slack/slash-commands.js";
import { applyTodoistCommitResult } from "./persist.js";
import {
  recommitWeekPlanToTodoist,
  type TodoistTaskCreatorUpdater,
} from "./recommit.js";

/**
 * C1 (bd meal-planner-iu7.2, SPEC §7 "Slack UX" / ADR-0006): the real
 * `ApprovalHandler` (`../slack/slash-commands.js`'s seam) that the A6
 * transport router hands a resolved `/mp-approved` command to,
 * AFTER it has already ack'd Slack (<3s). Everything here runs async:
 *
 *  1. Load the active week's `working_plan` off the session row.
 *  2. Translate + write it to Todoist — create-or-update per meal/second-dish/
 *     prep-unit slot (C4 `recommitWeekPlanToTodoist`, ADR-0006 D4
 *     soft-commit): a meal with no stored `todoist_task_id` is created
 *     fresh, a meal that already has one is updated in place, so a
 *     re-issued approval on an already-committed plan overwrites rather
 *     than duplicating tasks (SPEC §7 "soft-commit" — the week is NOT
 *     hard-locked after commit).
 *  3. Merge the (possibly new, possibly unchanged) task ids back onto the
 *     plan (C3 `applyTodoistCommitResult`) and persist + transition the
 *     session to `committed` in ONE `SessionStore.update` call, via the
 *     guarded `transition()` helper (ADR-0002 transition discipline,
 *     `../orchestrator/state-machine.js`) so an illegal edge throws instead
 *     of silently corrupting the row. `suggested -> committed`,
 *     `under_revision -> committed`, `committed -> committed` (the
 *     soft-commit self-loop), and `paused_cost -> committed` (ADR-0007 D7 —
 *     approval always wins, even on a paused thread) are all allowed edges.
 *  4. Post a confirmation as a NEW reply in the session thread.
 *
 * No approver gating (bd meal-planner-1tk, RATIFIED): anyone in the
 * workspace may approve — this module never inspects `command.command.user_id`.
 *
 * B4 (bd meal-planner-3e2.5, ADR 0007 D4) ADDITION: `onApprove` fires the
 * `revisionCoordinator.supersede` signal (optional dep, see
 * `TodoistApprovalHandlerOptions`) as its very first action, so approval
 * deterministically wins over any in-flight revision — see
 * `../orchestrator/revision-coordinator.js` for the serialization +
 * supersede machinery this pairs with.
 */

/**
 * The slice of a Slack Web API client this module needs to post a THREAD
 * REPLY. Mirrors `../orchestrator/revision-post.js`'s `RevisionSlackClient`
 * (same shape, same narrowing rationale) — each caller of `chat.postMessage`
 * in this codebase defines its own minimal local interface rather than
 * sharing one, so a real `@slack/web-api` `WebClient` always satisfies it
 * structurally with no adapter.
 */
export interface TodoistApprovalSlackClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      mrkdwn: boolean;
      thread_ts: string;
    }): Promise<{ ok?: boolean; ts?: string; error?: string }>;
  };
}

export interface TodoistApprovalHandlerOptions {
  /** Only the two methods this handler needs — keeps it decoupled from the full `SessionStore` surface (matches `slash-commands.ts`'s own narrowing convention). */
  sessionStore: Pick<SessionStore, "get" | "update">;
  /** C0's client, narrowed to `createTask`/`updateTask` (`./recommit.js`'s `TodoistTaskCreatorUpdater`) — the soft-commit create-or-update path needs both; this module still never calls `listCompleted` (recency's concern). */
  todoistClient: TodoistTaskCreatorUpdater;
  /** C5's resolved Todoist commit config (project/title/link template). */
  todoistConfig: TodoistCommitConfig;
  /** Slack client used ONLY to post the confirmation thread reply. */
  slack: TodoistApprovalSlackClient;
  /** Target Slack channel — the SAME channel the session's thread lives in (`ProfileSettings.channelId`). */
  channelId: string;
  /**
   * B4's (bd meal-planner-3e2.5, ADR 0007 D4) supersede signal: when
   * present, `onApprove` calls `.supersede(command.weekKey)` before doing
   * any work, so an in-flight revision (`../orchestrator/revision-coordinator.js`'s
   * `serializeRevisionHandler`/`guardOnRevised`) drops its result instead of
   * overwriting the plan this handler is about to commit. Optional — and
   * called unconditionally, even on the no-op early-return paths below — so
   * approval always wins regardless of whether a revision happens to be in
   * flight; omitted only for callers/tests that don't wire the v3.0
   * revision loop at all.
   */
  revisionCoordinator?: Pick<RevisionCoordinator, "supersede">;
  /** Injected clock for `SessionStore.update`'s `updated_at`; defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Recovers a `WeekPlan`-shaped value from a session row's `working_plan`
 * (typed `unknown` at the store layer), WITHOUT stripping the `recipe`
 * enrichment fields the way `../orchestrator/revision.js`'s
 * `extractCurrentPlan` deliberately does for its own mutation-prompt use
 * case. That stripping is wrong here: this handler writes the merged
 * `todoist_task_id`s straight back onto `working_plan` (step 3 above), and
 * `resumeQuietly` (`../orchestrator/resume.js`) requires every meal's
 * `recipe` to still be present on that same row for crash-recovery to keep
 * working for the rest of the week. `EnrichedWeekPlan`'s `meals` are a
 * strict structural superset of `SelectedMeal[]` (extra `recipe`/
 * `secondDishRecipe`/`sideRecipe` fields), so assigning it where a
 * `WeekPlan` is expected is safe — the C2/C3 commit helpers only read the
 * `WeekPlan` fields they declare and spread the rest through untouched.
 *
 * Falls back to the bare `WeekPlanSchema` (a plan stored before enrichment)
 * for robustness, then to `null` (unparseable/absent) — never throws, so an
 * approval on a malformed or missing plan degrades to a graceful no-op
 * rather than crashing the daemon.
 */
export function resolveWorkingPlanForCommit(
  workingPlan: unknown,
): WeekPlan | null {
  if (workingPlan === null || workingPlan === undefined) {
    return null;
  }
  const enriched = EnrichedWeekPlanSchema.safeParse(workingPlan);
  if (enriched.success) {
    return enriched.data;
  }
  const bare = WeekPlanSchema.safeParse(workingPlan);
  return bare.success ? bare.data : null;
}

function committedMealCount(
  result: Awaited<ReturnType<typeof recommitWeekPlanToTodoist>>,
): number {
  return result.meals.filter((outcome) => outcome.mealTask !== null).length;
}

/**
 * Builds the real `ApprovalHandler` implementation, wired in as
 * `RunDaemonOptions.approvalHandler` (`../daemon/daemon.js`).
 */
export function createTodoistApprovalHandler(
  options: TodoistApprovalHandlerOptions,
): ApprovalHandler {
  const logger = options.logger ?? console;
  const now = options.now ?? (() => new Date());

  return {
    async onApprove(command: ApprovedMealPlanCommand): Promise<void> {
      // ADR 0007 D4 — approval supersedes any in-flight revision FIRST,
      // before any other work (including the no-session/no-plan early
      // returns below): a revision result that lands after this point must
      // not overwrite whatever this handler commits.
      options.revisionCoordinator?.supersede(command.weekKey);

      const session = options.sessionStore.get(command.weekKey);
      if (!session) {
        logger.warn(
          `[todoist-commit] /mp-approved: no session row for week ${command.weekKey}; ignoring`,
        );
        return;
      }

      const plan = resolveWorkingPlanForCommit(session.working_plan);
      if (!plan) {
        logger.warn(
          `[todoist-commit] /mp-approved: no usable working_plan for week ${command.weekKey}; ignoring`,
        );
        return;
      }

      const result = await recommitWeekPlanToTodoist(
        plan,
        options.todoistConfig,
        options.todoistClient,
      );

      const updatedPlan = applyTodoistCommitResult(plan, result);
      // ADR-0002 transition discipline: status + working_plan land in ONE
      // write. `transition()` throws `IllegalTransitionError` on an illegal
      // edge (e.g. from a terminal `failed`/`expired` row) rather than
      // silently committing an unreachable state; `suggested`/
      // `under_revision`/`paused_cost`/`committed` (self-loop, soft-commit)
      // are all legal sources per `../orchestrator/state-machine.js`.
      transition(
        options.sessionStore,
        command.weekKey,
        "committed",
        { working_plan: updatedPlan },
        now().toISOString(),
      );

      const count = committedMealCount(result);
      const text = `Committed ${count} meal${count === 1 ? "" : "s"} to Todoist.`;

      try {
        await options.slack.chat.postMessage({
          channel: options.channelId,
          text,
          mrkdwn: true,
          thread_ts: command.threadTs,
        });
        logger.log(
          `[todoist-commit] posted commit confirmation for week ${command.weekKey} (${count} meal(s), thread_ts=${command.threadTs})`,
        );
      } catch (err) {
        // The commit + persist above already succeeded; a failed
        // confirmation post must not be reported as a commit failure. Log
        // and swallow, mirroring the codebase's never-let-a-notification-
        // failure-mask-a-successful-write discipline (e.g. `ops/alerter.ts`).
        logger.error(
          `[todoist-commit] commit succeeded for week ${command.weekKey} but the confirmation post failed: ${String(err)}`,
        );
      }
    },
  };
}
