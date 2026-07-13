import { WebClient } from "@slack/web-api";

/**
 * The slice of `WebClient` this module actually calls -- narrow enough that
 * tests can inject a plain `{ chat: { postMessage } }` fake (a bare mock
 * function) instead of constructing a real `WebClient` or touching the
 * network. Mirrors `SlackPostMessageClient` in `slack-poster.ts`, except
 * `postMessage` here is called WITHOUT `mrkdwn` -- alerts are plain text.
 */
export interface SlackAlertPostMessageClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
    }): Promise<{ ok?: boolean; ts?: string; error?: string }>;
  };
}

export interface SlackAlerterOptions {
  /** Slack bot token (xoxb-...). Used ONLY to construct the internal `WebClient` -- never logged or interpolated into an error. */
  token: string;
  /** Explicit #agent-alerts channel ID -- a SEPARATE channel from the meal-plan `profile.channelId`. */
  channelId: string;
  /** Injectable client for tests; when omitted, a real `WebClient(token)` is constructed. */
  client?: SlackAlertPostMessageClient;
}

/**
 * Posts a plain-text alert to `#agent-alerts` via the Web API's
 * `chat.postMessage` (SPEC §9.4: alerts-only channel -- no heartbeat, no
 * "skipping this week" messages, only real anomalies). Mirrors
 * `SlackPoster`'s WebClient/injectable-client/error-handling pattern.
 *
 * `alert()` THROWS on failure (a plain `Error`, never containing the bot
 * token -- only the safe `err.data.error` Slack error code, same rule as
 * `SlackPoster.post`); it is the composite alerter (`makeAlert`,
 * `src/ops/alerter.ts`) that decides whether to swallow that throw. This
 * class itself does not retry or swallow.
 */
export class SlackAlerter {
  private readonly channelId: string;
  private readonly client: SlackAlertPostMessageClient;

  constructor(opts: SlackAlerterOptions) {
    this.channelId = opts.channelId;
    this.client = opts.client ?? new WebClient(opts.token);
  }

  async alert(message: string): Promise<void> {
    let response: { ok?: boolean; ts?: string; error?: string };
    try {
      response = await this.client.chat.postMessage({
        channel: this.channelId,
        text: message,
      });
    } catch (err) {
      // Deliberately do NOT include the caught error's `.message`/`.stack`/
      // `.original`: they originate from the Slack SDK/HTTP layer and must
      // never be trusted to be free of sensitive request detail. The one
      // exception is `.data.error` -- @slack/web-api's typed, safe, closed
      // enum of Slack error codes, which by construction never contains the
      // bot token.
      const code =
        typeof (err as { data?: { error?: unknown } })?.data?.error === "string"
          ? (err as { data: { error: string } }).data.error
          : undefined;
      throw new Error(
        `Slack chat.postMessage failed for alerts channel ${this.channelId}` +
          (code ? ` (error: ${code})` : ""),
      );
    }

    if (response.ok === false) {
      throw new Error(
        `Slack chat.postMessage returned ok:false for alerts channel ${this.channelId}${
          response.error ? ` (error: ${response.error})` : ""
        }`,
      );
    }
  }
}
