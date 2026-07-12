import { describe, expect, it, vi } from "vitest";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import { renderPlan } from "./render.js";
import { SlackPoster } from "./slack-poster.js";

/**
 * A minimal plan fixture -- the exact rendered content isn't this test's
 * concern (that's render.test.ts's job); this just needs SOME plan whose
 * `renderPlan(plan)` output can be asserted to have passed through
 * unmodified into `chat.postMessage`'s `text` argument.
 */
function plan(): EnrichedWeekPlan {
  return {
    week_key: "2026-W29",
    meals: [],
    summary: "A quiet week.",
  };
}

describe("SlackPoster", () => {
  it("posts renderPlan's output to the explicit channelId with mrkdwn:true, and returns the ts", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, ts: "1234.5678" });
    const poster = new SlackPoster({
      token: "xoxb-fake",
      channelId: "C123ABC",
      client: { chat: { postMessage } },
    });

    const result = await poster.post(plan());

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123ABC",
      text: renderPlan(plan()),
      mrkdwn: true,
    });
    expect(result).toEqual({ ts: "1234.5678" });
  });

  it("throws (without leaking the token) when postMessage rejects", async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error("network down"));
    const poster = new SlackPoster({
      token: "xoxb-super-secret-token",
      channelId: "C123ABC",
      client: { chat: { postMessage } },
    });

    await expect(poster.post(plan())).rejects.toThrow();
    try {
      await poster.post(plan());
      throw new Error("expected post() to throw");
    } catch (e) {
      expect(String(e)).not.toContain("xoxb-super-secret-token");
    }
  });

  it("throws when the response is ok:false", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "channel_not_found" });
    const poster = new SlackPoster({
      token: "xoxb-fake",
      channelId: "C123ABC",
      client: { chat: { postMessage } },
    });

    await expect(poster.post(plan())).rejects.toThrow(/channel_not_found/);
  });

  it("throws when the response is ok:true but has no ts", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const poster = new SlackPoster({
      token: "xoxb-fake",
      channelId: "C123ABC",
      client: { chat: { postMessage } },
    });

    await expect(poster.post(plan())).rejects.toThrow();
  });
});
