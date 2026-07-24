import { describe, expect, it, vi } from "vitest";
import type { NightSchedule } from "../calendar/night-schedule.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import type { PrepUnit } from "../planner/select.js";
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

  it("includes Slack's safe error code (data.error) when postMessage rejects, without leaking the token even when it appears in the raw error message", async () => {
    // Mirrors the real @slack/web-api WebClient: on failure it always
    // REJECTS (never resolves ok:false) with an error whose typed
    // `.data.error` is a safe, closed enum string. The `.message` here
    // plants a fake bot token to prove the thrown message is built ONLY
    // from `.data.error` -- never from `.message`/`.stack`/`.original`.
    const slackError = Object.assign(
      new Error("channel_not_found: xoxb-super-secret-token leaked in body"),
      {
        data: { ok: false, error: "channel_not_found" },
        original: { message: "xoxb-super-secret-token" },
      },
    );
    const postMessage = vi.fn().mockRejectedValue(slackError);
    const poster = new SlackPoster({
      token: "xoxb-super-secret-token",
      channelId: "C123ABC",
      client: { chat: { postMessage } },
    });

    try {
      await poster.post(plan());
      throw new Error("expected post() to throw");
    } catch (e) {
      const message = String(e);
      expect(message).toContain("channel_not_found");
      expect(message).toContain("C123ABC");
      expect(message).not.toContain("xoxb-super-secret-token");
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

  it("passes plan.nightSchedule + resolved prep into renderPlan so capacity/prep annotations reach the real post (ADR 0005 D4, bd meal-planner-0v7.7)", async () => {
    const nightSchedule: NightSchedule = [
      {
        date: "2026-07-28",
        weekday: "Tuesday",
        capacity: "QUICK",
        blocking_events: [],
      },
    ];
    const prep: PrepUnit[] = [
      {
        description: "marinate the chicken",
        serve_date: "2026-07-28",
        prep_date: "2026-07-26",
      },
    ];
    const dayPlan: EnrichedWeekPlan = {
      week_key: "2026-07-26",
      meals: [
        {
          slot_type: "constrained",
          recipe_id: "tue-1",
          title: "Tuesday Meal",
          day: "2026-07-28",
          veg: { kind: "inherent" },
          flags: [],
          rationale: "quick + vegetarian",
          recipe: {
            id: "tue-1",
            title: "Tuesday Meal",
            time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
            effort_tags: [],
            season_tags: [],
            veg_status: "vegetarian",
            ingredients: [],
            body: "body",
            source_note_id: "tue-1",
          },
        },
      ],
      prep,
      nightSchedule,
    };

    const postMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, ts: "1234.5678" });
    const poster = new SlackPoster({
      token: "xoxb-fake",
      channelId: "C123ABC",
      client: { chat: { postMessage } },
    });

    await poster.post(dayPlan);

    const expectedText = renderPlan(dayPlan, { nightSchedule, prep });
    expect(expectedText).toMatch(/\*Tuesday\*.*quick/i);
    expect(expectedText).toContain("prep Sun → serve Tue");
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123ABC",
      text: expectedText,
      mrkdwn: true,
    });
  });
});
