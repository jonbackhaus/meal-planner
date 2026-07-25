import type { SocketModeClient } from "@slack/socket-mode";
import type { SessionStore } from "../orchestrator/session-store.js";
import {
  currentPlanWeek,
  type WeekKeyConfig,
} from "../orchestrator/week-key.js";

/**
 * Inbound event router (bd meal-planner-4u4.4, SPEC §7 "listener scope" /
 * §8): attaches a `message` handler to the A3 Socket Mode seam
 * (`SocketModeConnectionHandle.client`, `../slack/socket-connection.ts`) and
 * maps each thread reply -> its week's session row via the reply's
 * `thread_ts` (`SessionStore.getByThreadTs`). ROUTING + FILTERING ONLY:
 *
 *  - No known thread (`thread_ts` absent, or present but unmatched) -> a
 *    stray channel message; drop it.
 *  - Matched thread, but its `week_key` is NOT the currently-active
 *    (clock-computed) week -> drop it. "Active week" is computed here via
 *    `currentPlanWeek`, exactly as everywhere else (ADR 0002 D1/D3) -- never
 *    a stored flag. The one-time "this plan has expired" redirect for this
 *    case is a SEPARATE follow-up, bd meal-planner-4u4.5 -- not built here.
 *  - Matched thread AND it's the active week -> forward AS-IS to the
 *    injected `RevisionHandler` seam. Any further filtering (e.g. "family is
 *    plural" reasoning) belongs to B1 (bd meal-planner-3e2.2), not here.
 *
 * Clock policy: `now()` is a callback, not a one-shot `Date` -- it's called
 * fresh on every inbound reply (which can arrive anytime during the
 * connection's lifetime), matching this codebase's "caller owns the clock"
 * convention (see week-key.ts). Defaults to `() => new Date()`.
 */

/**
 * The subset of Slack's Events API `message` event this router reads.
 * `@slack/socket-mode` re-emits whatever Slack sends without exporting typed
 * event payloads, so this is a minimal local shape -- only the fields this
 * router actually inspects. See
 * https://docs.slack.dev/reference/events/message.
 */
export interface SlackMessageEvent {
  type?: string;
  channel?: string;
  user?: string;
  ts?: string;
  /** Present only on messages that are themselves replies within a thread; equals the root message's `ts`. */
  thread_ts?: string;
  subtype?: string;
  [key: string]: unknown;
}

/** The `client.on("message", ...)` callback's argument shape (see SocketModeClient's `onWebSocketMessage`). */
interface MessageEventEnvelope {
  event: SlackMessageEvent;
  /** Acks receipt back to Slack over the socket -- required within 3s for every Events API message delivered over Socket Mode, regardless of how this router routes it. */
  ack: (response?: unknown) => Promise<void>;
}

/** What gets handed to the revision seam once a reply is confirmed to belong to the active week's thread. */
export interface InboundThreadReply {
  /** The active week's key (== the matched session row's `week_key`). */
  weekKey: string;
  /** The thread's parent ts (== the matched session row's `thread_ts`). */
  threadTs: string;
  /** The raw Slack message event, forwarded as-is. */
  event: SlackMessageEvent;
}

/**
 * The revision-loop seam (B1, bd meal-planner-3e2.2) this router hands
 * active-week thread replies off to. Defining this interface here -- and NOT
 * implementing it -- is this module's scope boundary: routing decides
 * WHETHER a reply belongs to the active week's thread; what happens to it
 * next (bounded LLM mutation of `working_plan`, "family is plural"
 * reasoning, etc.) is entirely B1's concern.
 */
export interface RevisionHandler {
  onReply(reply: InboundThreadReply): Promise<void> | void;
}

/** Default seam implementation: does nothing. Lets this module (and its tests) work standalone, with no dependency on B1 landing first. */
const noopRevisionHandler: RevisionHandler = {
  onReply: () => {},
};

export interface EventRouterOptions {
  /** Only the read path this router needs -- keeps this module decoupled from the full `SessionStore` surface. */
  sessionStore: Pick<SessionStore, "getByThreadTs">;
  /** Same shape `currentPlanWeek` needs (timezone + triggerTime) -- pass the app `Config` directly. */
  weekKeyConfig: WeekKeyConfig;
  /** Injected; defaults to `noopRevisionHandler` (B1 supplies the real one later). */
  revisionHandler?: RevisionHandler;
  /** Injected clock, called fresh per inbound reply. Defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Attaches the inbound `message` handler to `client` (the A3 seam). Void
 * return -- this mutates `client` in place, mirroring how
 * `openSocketModeConnection` itself attaches no handlers and leaves that to
 * this follow-up.
 */
export function attachEventRouter(
  client: SocketModeClient,
  options: EventRouterOptions,
): void {
  const logger = options.logger ?? console;
  const now = options.now ?? (() => new Date());
  const revisionHandler = options.revisionHandler ?? noopRevisionHandler;

  client.on("message", async ({ event, ack }: MessageEventEnvelope) => {
    try {
      // Ack unconditionally and up front -- Slack requires every Events API
      // message delivered over Socket Mode to be acknowledged within 3s,
      // regardless of whether this router ends up forwarding or dropping it.
      await ack();

      const threadTs = event.thread_ts;
      if (!threadTs) {
        // Not a threaded reply (a bare channel message, our own outbound
        // post landing back as an event, a message_changed/deleted subtype
        // without a top-level thread_ts, etc.) -- nothing to route.
        return;
      }

      const session = options.sessionStore.getByThreadTs(threadTs);
      if (!session) {
        logger.log(
          `[inbound-router] dropping reply: thread_ts=${threadTs} does not match any known session`,
        );
        return;
      }

      const activeWeek = currentPlanWeek(now(), options.weekKeyConfig);
      if (session.week_key !== activeWeek) {
        logger.log(
          `[inbound-router] dropping reply: thread's week_key=${session.week_key} is not the active week (${activeWeek}) -- expired-thread redirect is bd meal-planner-4u4.5, not built here`,
        );
        return;
      }

      await revisionHandler.onReply({
        weekKey: session.week_key,
        threadTs,
        event,
      });
    } catch (err) {
      logger.error(
        `[inbound-router] failed handling an inbound message event: ${String(err)}`,
      );
    }
  });
}
