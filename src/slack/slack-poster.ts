import { WebClient } from "@slack/web-api";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import { renderPlan } from "./render.js";

/**
 * The slice of `WebClient` this module actually calls -- narrow enough that
 * tests can inject a plain `{ chat: { postMessage } }` fake (a bare mock
 * function) instead of constructing a real `WebClient` or touching the
 * network. `postMessage`'s return shape mirrors `ChatPostMessageResponse`'s
 * load-bearing fields only (`ok`/`ts`/`error`) rather than importing that
 * type directly, so a test fixture doesn't have to satisfy Slack's full
 * response shape.
 */
export interface SlackPostMessageClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      mrkdwn: boolean;
    }): Promise<{ ok?: boolean; ts?: string; error?: string }>;
  };
}

export interface SlackPosterOptions {
  /** Slack bot token (xoxb-...). Used ONLY to construct the internal `WebClient` -- never logged or interpolated into an error. */
  token: string;
  /** Explicit Slack channel ID (never a `#name`-style lookup) -- see `ProfileSettings.channelId`. */
  channelId: string;
  /** Injectable client for tests; when omitted, a real `WebClient(token)` is constructed. */
  client?: SlackPostMessageClient;
}

/**
 * Posts the weekly draft plan to Slack via the Web API's `chat.postMessage`
 * (SPEC §7/§9.2: v1.0-v2.0 is outbound-only -- no Socket Mode, no Bolt, no
 * thread replies). This is `generate.ts`'s `PostFn`, wired in for
 * `profile.postMode === "post"`: `generateForWeek` calls `post(plan)` as an
 * IRREVERSIBLE side effect and treats the returned `ts` as the thread handle
 * to persist (`working_plan`/`thread_ts`) for later revision (v3.0).
 *
 * The channel posted to is always the caller-supplied `channelId` verbatim
 * (the explicit, validated `ProfileSettings.channelId` -- resolveProfile
 * already rejects `#name`-style values), never re-derived here.
 */
export class SlackPoster {
  private readonly channelId: string;
  private readonly client: SlackPostMessageClient;

  constructor(opts: SlackPosterOptions) {
    this.channelId = opts.channelId;
    this.client = opts.client ?? new WebClient(opts.token);
  }

  /**
   * Renders `plan` via the pure `renderPlan` and posts it as a new top-level
   * mrkdwn message in `channelId`, returning `{ ts }` on success.
   *
   * Throws a plain `Error` (no bot token, no client, nothing secret) when the
   * call rejects, or the response is `ok:false`, or `ok:true` but missing a
   * `ts` -- `generateForWeek`'s failure path (transition to `failed` +
   * `#agent-alerts`) is what handles this throw; this class doesn't retry or
   * swallow it.
   */
  async post(plan: EnrichedWeekPlan): Promise<{ ts: string }> {
    const text = renderPlan(plan);

    let response: { ok?: boolean; ts?: string; error?: string };
    try {
      response = await this.client.chat.postMessage({
        channel: this.channelId,
        text,
        mrkdwn: true,
      });
    } catch (err) {
      // Deliberately do NOT include the caught error's `.message`/`.stack`/
      // `.original`: they originate from the Slack SDK/HTTP layer and must
      // never be trusted to be free of sensitive request detail (e.g. they
      // could echo request options). The one exception is `.data.error` --
      // @slack/web-api's typed, safe, closed enum of Slack error codes
      // (e.g. `channel_not_found`/`invalid_auth`/`not_in_channel`/
      // `rate_limited`) which by construction never contains the bot token.
      const code =
        typeof (err as { data?: { error?: unknown } })?.data?.error === "string"
          ? (err as { data: { error: string } }).data.error
          : undefined;
      throw new Error(
        `Slack chat.postMessage failed for channel ${this.channelId}` +
          (code ? ` (error: ${code})` : ""),
      );
    }

    if (response.ok === false) {
      throw new Error(
        `Slack chat.postMessage returned ok:false for channel ${this.channelId}${
          response.error ? ` (error: ${response.error})` : ""
        }`,
      );
    }

    if (!response.ts) {
      throw new Error(
        `Slack chat.postMessage returned no ts for channel ${this.channelId}`,
      );
    }

    return { ts: response.ts };
  }
}
