import type { TodoistCommitConfig } from "../config/profile.js";
import type { SessionStore } from "../orchestrator/session-store.js";
import { EnrichedWeekPlanSchema } from "../planner/enrich.js";
import { type WeekPlan, WeekPlanSchema } from "../planner/select.js";
import type {
  ApprovalHandler,
  ApprovedMealPlanCommand,
} from "../slack/slash-commands.js";
import { commitWeekPlanToTodoist, type TodoistTaskCreator } from "./commit.js";
import { applyTodoistCommitResult } from "./persist.js";

/**
 * C1 (bd meal-planner-iu7.2, SPEC §7 "Slack UX" / ADR-0006): the real
 * `ApprovalHandler` (`../slack/slash-commands.js`'s seam) that the A6
 * transport router hands a resolved `/mealplan-approved` command to,
 * AFTER it has already ack'd Slack (<3s). Everything here runs async:
 *
 *  1. Load the active week's `working_plan` off the session row.
 *  2. Translate + write it to Todoist (C2 `commitWeekPlanToTodoist`).
 *  3. Merge the created task ids back onto the plan (C3
 *     `applyTodoistCommitResult`) and persist via the EXISTING
 *     `SessionStore.update` (no new store method).
 *  4. Post a confirmation as a NEW reply in the session thread.
 *
 * No approver gating (bd meal-planner-1tk, RATIFIED): anyone in the
 * workspace may approve — this module never inspects `command.command.user_id`.
 *
 * OUT OF SCOPE (bd meal-planner-iu7.5, C4): the `committed` state
 * transition and soft-commit re-commit UPDATE-IN-PLACE orchestration
 * (`../todoist-commit/persist.js`'s `partitionMealsForRecommit`). A
 * re-approval of an already-committed plan simply re-creates fresh tasks
 * here (C2's `commitWeekPlanToTodoist` always creates) — an accepted,
 * explicitly-scoped-out soft-commit gap left for C4 to close.
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
  /** C0's client, narrowed to `createTask` only (C2's own `TodoistTaskCreator`) — this module never calls `updateTask`/`listCompleted` (C4/recency's concern). */
  todoistClient: TodoistTaskCreator;
  /** C5's resolved Todoist commit config (project/title/link template). */
  todoistConfig: TodoistCommitConfig;
  /** Slack client used ONLY to post the confirmation thread reply. */
  slack: TodoistApprovalSlackClient;
  /** Target Slack channel — the SAME channel the session's thread lives in (`ProfileSettings.channelId`). */
  channelId: string;
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
  result: Awaited<ReturnType<typeof commitWeekPlanToTodoist>>,
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
      const session = options.sessionStore.get(command.weekKey);
      if (!session) {
        logger.warn(
          `[todoist-commit] /mealplan-approved: no session row for week ${command.weekKey}; ignoring`,
        );
        return;
      }

      const plan = resolveWorkingPlanForCommit(session.working_plan);
      if (!plan) {
        logger.warn(
          `[todoist-commit] /mealplan-approved: no usable working_plan for week ${command.weekKey}; ignoring`,
        );
        return;
      }

      const result = await commitWeekPlanToTodoist(
        plan,
        options.todoistConfig,
        options.todoistClient,
      );

      const updatedPlan = applyTodoistCommitResult(plan, result);
      options.sessionStore.update(command.weekKey, {
        working_plan: updatedPlan,
        updated_at: now().toISOString(),
      });

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
