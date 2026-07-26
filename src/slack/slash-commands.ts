import type { SocketModeClient } from "@slack/socket-mode";
import type { SessionStore } from "../orchestrator/session-store.js";
import {
  currentPlanWeek,
  type WeekKeyConfig,
} from "../orchestrator/week-key.js";

/**
 * Slash-command transport for `/mealplan-approved` and `/mealplan-resume`
 * (bd meal-planner-4u4.6/m49, SPEC §7 "Approval commands" / §9.2, ADR-0007
 * D6/D7): attaches a `slash_commands` handler to the A3 Socket Mode seam
 * (`SocketModeConnectionHandle.client`, `../slack/socket-connection.ts`) --
 * kept in its own module, separate from `../slack/inbound-router.ts`
 * (thread-reply routing, bd meal-planner-4u4.4), since the two are
 * independent event types on the same socket.
 *
 * TRANSPORT ONLY, per SPEC §7:
 *  - **Ack within 3s, unconditionally and up front** -- same Slack
 *    requirement as every Socket Mode delivery, before any work.
 *  - Slash commands are workspace-wide (not channel/thread scoped the way a
 *    reply is), so this resolves the command to the **active** (clock-
 *    computed) week's session row directly via `SessionStore.get`, exactly
 *    like `currentPlanWeek` is used everywhere else (ADR 0002 D1/D3) -- never
 *    a stored flag.
 *  - No active-week session, or an active-week row with no `thread_ts` yet
 *    (still `generating`, not yet posted) -> by definition not an active
 *    thread to approve/resume. Ack + no-op; nothing is dispatched.
 *  - Active week resolves to a real thread -> hand off AS-IS to the injected
 *    `ApprovalHandler` seam (for `/mealplan-approved`) or the injected
 *    `ResetPauseHandler` seam (for `/mealplan-resume`, bd meal-planner-m49,
 *    ADR-0007 D6's operator-only cost-pause reset). The async work -- the
 *    Todoist commit, the cost-guard reset, and any in-thread confirmation
 *    post -- is entirely those seams' concern, not built here. Neither
 *    command has approver gating (private family workspace = operators).
 */

/**
 * The subset of Slack's slash command payload
 * (https://docs.slack.dev/interactivity/implementing-slash-commands) this
 * router reads. `@slack/socket-mode` doesn't export typed payloads for
 * non-Events-API envelope types (see `SocketModeClient.onWebSocketMessage`),
 * so this is a minimal local shape.
 */
export interface SlackSlashCommandPayload {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  team_id?: string;
  response_url?: string;
  trigger_id?: string;
  [key: string]: unknown;
}

/**
 * The `client.on("slash_commands", ...)` callback's argument shape. Unlike
 * Events API messages (which arrive as `{ event, ack }`), Socket Mode emits
 * non-Events-API envelope types -- slash commands among them -- as
 * `{ body, ack }`, where `body` is `envelope.payload` (the slash command form
 * fields) directly. See `SocketModeClient.onWebSocketMessage`'s `else`
 * branch.
 */
interface SlashCommandEnvelope {
  body: SlackSlashCommandPayload;
  /** Acks receipt back to Slack over the socket -- required within 3s. */
  ack: (response?: unknown) => Promise<void>;
}

/** What gets handed to the approval seam once the command is resolved to the active week's thread. */
export interface ApprovedMealPlanCommand {
  /** The active week's key (== the matched session row's `week_key`). */
  weekKey: string;
  /** The active week's thread parent ts (== the matched session row's `thread_ts`). */
  threadTs: string;
  /** The raw slash command payload, forwarded as-is. */
  command: SlackSlashCommandPayload;
}

/**
 * The commit-handler seam (C1, bd meal-planner-iu7.2) this router hands
 * resolved `/mealplan-approved` commands off to. Defining this interface
 * here -- and NOT implementing it -- is this module's scope boundary:
 * resolving WHICH thread a workspace-wide command applies to is this
 * module's job; the async commit + confirmation post (SPEC §7 "ack
 * immediately, do the commit async, post confirmation as a follow-up") is
 * entirely C1's concern.
 */
export interface ApprovalHandler {
  onApprove(command: ApprovedMealPlanCommand): Promise<void> | void;
}

/** Default seam implementation: does nothing. Lets this module (and its tests) work standalone, with no dependency on C1 landing first. */
const noopApprovalHandler: ApprovalHandler = {
  onApprove: () => {},
};

/**
 * The `/mealplan-resume` slash command (bd meal-planner-m49, ADR-0007 D6):
 * an operator-only reset of a `paused_cost` week's revision cost guard. A
 * shared constant so the handler and any docs/tests reference the same
 * string.
 */
export const MEALPLAN_RESUME_COMMAND = "/mealplan-resume";

/** What gets handed to the reset-pause seam once the command is resolved to the active week's thread. */
export interface ResumeMealPlanCommand {
  /** The active week's key (== the matched session row's `week_key`). */
  weekKey: string;
  /** The active week's thread parent ts (== the matched session row's `thread_ts`). */
  threadTs: string;
  /** The raw slash command payload, forwarded as-is. */
  command: SlackSlashCommandPayload;
}

/**
 * The operator-reset seam (bd meal-planner-m49, ADR-0007 D6) this router
 * hands resolved `/mealplan-resume` commands off to. Defining this interface
 * here -- and NOT implementing it -- matches `ApprovalHandler`'s scope
 * boundary: resolving WHICH thread a workspace-wide command applies to is
 * this module's job; calling the live revision cost guard's `resetPause`
 * and posting any in-thread confirmation is entirely this seam's concern.
 */
export interface ResetPauseHandler {
  onResetPause(command: ResumeMealPlanCommand): Promise<void> | void;
}

/** Default seam implementation: does nothing. Lets this module (and its tests) work standalone, with no dependency on the real reset-pause wiring landing first. */
const noopResetPauseHandler: ResetPauseHandler = {
  onResetPause: () => {},
};

export interface SlashCommandRouterOptions {
  /** Only the read path this router needs -- keeps this module decoupled from the full `SessionStore` surface. */
  sessionStore: Pick<SessionStore, "get">;
  /** Same shape `currentPlanWeek` needs (timezone + triggerTime) -- pass the app `Config` directly. */
  weekKeyConfig: WeekKeyConfig;
  /** Injected; defaults to `noopApprovalHandler` (C1 supplies the real one later). */
  approvalHandler?: ApprovalHandler;
  /** Injected; defaults to `noopResetPauseHandler` (bd meal-planner-m49 supplies the real one later). */
  resetPauseHandler?: ResetPauseHandler;
  /** Injected clock, called fresh per inbound command. Defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Attaches the `slash_commands` handler to `client` (the A3 seam). Void
 * return -- this mutates `client` in place, mirroring
 * `attachEventRouter`'s (`../slack/inbound-router.ts`) convention.
 */
export function attachSlashCommandRouter(
  client: SocketModeClient,
  options: SlashCommandRouterOptions,
): void {
  const logger = options.logger ?? console;
  const now = options.now ?? (() => new Date());
  const approvalHandler = options.approvalHandler ?? noopApprovalHandler;
  const resetPauseHandler = options.resetPauseHandler ?? noopResetPauseHandler;

  client.on("slash_commands", async ({ body, ack }: SlashCommandEnvelope) => {
    try {
      // Ack unconditionally and up front -- Slack requires every Socket
      // Mode delivery to be acknowledged within 3s, regardless of whether
      // this router ends up dispatching or no-op'ing it.
      await ack();

      if (
        body.command !== "/mealplan-approved" &&
        body.command !== MEALPLAN_RESUME_COMMAND
      ) {
        // Only these two commands are this router's concern; a differently-
        // named slash command (e.g. v4.0's /grocerylist-approved) is out of
        // scope here.
        return;
      }

      const activeWeek = currentPlanWeek(now(), options.weekKeyConfig);
      const session = options.sessionStore.get(activeWeek);
      if (!session?.thread_ts) {
        // No active-week session, or one that hasn't posted yet (still
        // `generating`) -> by definition not an active thread (SPEC §7: a
        // stale/absent week cannot be approved/resumed). Benign no-op.
        logger.log(
          `[slash-commands] ${body.command}: no active thread for week ${activeWeek}; ignoring`,
        );
        return;
      }

      if (body.command === "/mealplan-approved") {
        await approvalHandler.onApprove({
          weekKey: session.week_key,
          threadTs: session.thread_ts,
          command: body,
        });
      } else {
        await resetPauseHandler.onResetPause({
          weekKey: session.week_key,
          threadTs: session.thread_ts,
          command: body,
        });
      }
    } catch (err) {
      logger.error(
        `[slash-commands] failed handling a ${body.command} command: ${String(err)}`,
      );
    }
  });
}
