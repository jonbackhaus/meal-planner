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
 *    (clock-computed) week -> an expired-thread reply. "Active week" is
 *    computed here via `currentPlanWeek`, exactly as everywhere else (ADR
 *    0002 D1/D3) -- never a stored flag. Per SPEC §8's redirect lean, this
 *    posts a ONE-TIME "that plan expired; this week's is here" reply into the
 *    expired thread (bd meal-planner-4u4.5, `handleExpiredThreadReply`
 *    below) -- skipped (falls back to a log-only drop) when no `redirect`
 *    Slack client is injected, and never repeated for a `thread_ts` already
 *    redirected once.
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

/**
 * The slice of a Slack Web API client this module needs to post the
 * one-time expired-thread redirect (a reply INTO the expired thread, `thread_ts`
 * set) -- mirrors `RevisionSlackClient`
 * (`../orchestrator/revision-post.ts`)/`SlackPostMessageClient`
 * (`./slack-poster.ts`)'s own narrowing, defined locally (rather than
 * imported) to keep this module's dependency direction slack -> orchestrator
 * free, matching how each of those Slack-adjacent modules defines its own
 * narrow client shape instead of sharing one.
 */
export interface RedirectSlackClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      mrkdwn: boolean;
      thread_ts: string;
    }): Promise<{ ok?: boolean; ts?: string; error?: string }>;
  };
}

export interface EventRouterOptions {
  /** The read paths this router needs -- `get` (by the active week's key, to find its thread for the redirect link) alongside `getByThreadTs` -- keeps this module decoupled from the full `SessionStore` surface. */
  sessionStore: Pick<SessionStore, "getByThreadTs" | "get">;
  /** Same shape `currentPlanWeek` needs (timezone + triggerTime) -- pass the app `Config` directly. */
  weekKeyConfig: WeekKeyConfig;
  /** Injected; defaults to `noopRevisionHandler` (B1 supplies the real one later). */
  revisionHandler?: RevisionHandler;
  /**
   * Slack client + target channel used ONLY to post the one-time
   * "that plan expired" redirect reply into a matched-but-expired thread (bd
   * meal-planner-4u4.5, SPEC §8's redirect lean). Optional: when omitted, an
   * expired-thread reply falls back to a log-only drop (this router's prior
   * behavior) instead of posting.
   */
  redirect?: {
    slack: RedirectSlackClient;
    channelId: string;
  };
  /** Injected clock, called fresh per inbound reply. Defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Builds the redirect reply's text. Links to the active week's thread via
 * Slack's channel-agnostic permalink shape (`slack.com/archives/<channel>/p<ts
 * without the dot>`) when the active week already has a posted thread;
 * otherwise (not yet generated/posted) falls back to a channel pointer with
 * no link, since there's nothing to link to yet.
 */
function buildRedirectText(
  expiredWeekKey: string,
  activeWeekThreadTs: string | null,
  channelId: string,
): string {
  const prefix = `This plan (week of ${expiredWeekKey}) has expired.`;
  if (!activeWeekThreadTs) {
    return `${prefix} This week's plan hasn't posted yet -- check back soon in this channel.`;
  }
  const link = `https://slack.com/archives/${channelId}/p${activeWeekThreadTs.replace(".", "")}`;
  return `${prefix} This week's plan is here: ${link}`;
}

/**
 * Handles a reply matched to a KNOWN but non-active (expired/prior-week)
 * thread (bd meal-planner-4u4.5, SPEC §8's redirect lean): posts a one-time
 * "that plan expired; this week's is here" reply into the expired thread,
 * skipping (and just logging) if either a redirect for this `threadTs` was
 * already sent this run, or no `redirect` Slack client was injected.
 */
async function handleExpiredThreadReply(args: {
  threadTs: string;
  expiredWeekKey: string;
  activeWeek: string;
  options: EventRouterOptions;
  redirectedThreadTs: Set<string>;
  logger: Pick<Console, "log" | "warn" | "error">;
}): Promise<void> {
  const {
    threadTs,
    expiredWeekKey,
    activeWeek,
    options,
    redirectedThreadTs,
    logger,
  } = args;

  if (redirectedThreadTs.has(threadTs)) {
    logger.log(
      `[inbound-router] dropping reply: thread's week_key=${expiredWeekKey} is not the active week (${activeWeek}) -- redirect already sent for thread_ts=${threadTs}`,
    );
    return;
  }

  if (!options.redirect) {
    logger.log(
      `[inbound-router] dropping reply: thread's week_key=${expiredWeekKey} is not the active week (${activeWeek}) -- no redirect Slack client injected`,
    );
    return;
  }

  const { slack, channelId } = options.redirect;
  const activeSession = options.sessionStore.get(activeWeek);
  const text = buildRedirectText(
    expiredWeekKey,
    activeSession?.thread_ts ?? null,
    channelId,
  );

  // Mark BEFORE posting, not after: guarantees "one-time" even if a second
  // reply to the same expired thread arrives while this post is still
  // in-flight, and avoids retry-spamming a channel/thread that's failing to
  // accept posts.
  redirectedThreadTs.add(threadTs);

  try {
    const response = await slack.chat.postMessage({
      channel: channelId,
      text,
      mrkdwn: true,
      thread_ts: threadTs,
    });
    if (response.ok === false) {
      logger.error(
        `[inbound-router] expired-thread redirect post returned ok:false for thread_ts=${threadTs}${
          response.error ? ` (error: ${response.error})` : ""
        }`,
      );
      return;
    }
    logger.log(
      `[inbound-router] posted one-time expired-thread redirect: thread_ts=${threadTs} (expired week_key=${expiredWeekKey}, active week_key=${activeWeek})`,
    );
  } catch (err) {
    logger.error(
      `[inbound-router] expired-thread redirect post failed for thread_ts=${threadTs}: ${String(err)}`,
    );
  }
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
  // Tracks expired thread_ts values a redirect has already been posted for,
  // so a second (or Nth) late reply to the same expired thread doesn't spam
  // another redirect (SPEC §8 "one-time"). Deliberately in-memory rather than
  // a persisted flag on the session row: it's a spam-prevention nicety, not a
  // correctness concern, and this router already has no write access to
  // `SessionStore` (`sessionStore` is read-only, `getByThreadTs`/`get`).
  // Tradeoff: a daemon restart forgets it, so the very next reply to an
  // already-redirected expired thread after a restart can trigger one more
  // (harmless) redirect -- acceptable for v3.0.
  const redirectedThreadTs = new Set<string>();

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
        await handleExpiredThreadReply({
          threadTs,
          expiredWeekKey: session.week_key,
          activeWeek,
          options,
          redirectedThreadTs,
          logger,
        });
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
