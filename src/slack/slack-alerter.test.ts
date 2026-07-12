import { describe, expect, it, vi } from "vitest";
import { SlackAlerter } from "./slack-alerter.js";

describe("SlackAlerter", () => {
  it("posts the plain-text message to the alerts channelId", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, ts: "1234.5678" });
    const alerter = new SlackAlerter({
      token: "xoxb-fake",
      channelId: "C_ALERTS",
      client: { chat: { postMessage } },
    });

    await alerter.alert("generation failed for 2026-W29");

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_ALERTS",
      text: "generation failed for 2026-W29",
    });
  });

  it("throws (without leaking the token) when postMessage rejects", async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error("network down"));
    const alerter = new SlackAlerter({
      token: "xoxb-super-secret-token",
      channelId: "C_ALERTS",
      client: { chat: { postMessage } },
    });

    try {
      await alerter.alert("oops");
      throw new Error("expected alert() to throw");
    } catch (e) {
      expect(String(e)).not.toContain("xoxb-super-secret-token");
    }
  });

  it("includes Slack's safe error code (data.error) when postMessage rejects, without leaking the token even when it appears in the raw error message", async () => {
    const slackError = Object.assign(
      new Error("channel_not_found: xoxb-super-secret-token leaked in body"),
      {
        data: { ok: false, error: "channel_not_found" },
        original: { message: "xoxb-super-secret-token" },
      },
    );
    const postMessage = vi.fn().mockRejectedValue(slackError);
    const alerter = new SlackAlerter({
      token: "xoxb-super-secret-token",
      channelId: "C_ALERTS",
      client: { chat: { postMessage } },
    });

    try {
      await alerter.alert("oops");
      throw new Error("expected alert() to throw");
    } catch (e) {
      const message = String(e);
      expect(message).toContain("channel_not_found");
      expect(message).toContain("C_ALERTS");
      expect(message).not.toContain("xoxb-super-secret-token");
    }
  });

  it("throws when the response is ok:false", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "channel_not_found" });
    const alerter = new SlackAlerter({
      token: "xoxb-fake",
      channelId: "C_ALERTS",
      client: { chat: { postMessage } },
    });

    await expect(alerter.alert("oops")).rejects.toThrow(/channel_not_found/);
  });
});
