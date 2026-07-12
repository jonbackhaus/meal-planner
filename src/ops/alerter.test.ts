import { describe, expect, it, vi } from "vitest";
import { makeAlert } from "./alerter.js";

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("makeAlert", () => {
  it("appends to the local log and warns via the logger", async () => {
    const appendLocal = vi.fn();
    const logger = fakeLogger();
    const alert = makeAlert({ appendLocal, logger });

    await alert("generation failed for 2026-W29");

    expect(appendLocal).toHaveBeenCalledWith("generation failed for 2026-W29");
    expect(logger.warn).toHaveBeenCalledWith(
      "[agent-alert] generation failed for 2026-W29",
    );
  });

  it("also posts to Slack when a slackAlert is provided", async () => {
    const appendLocal = vi.fn();
    const slackAlert = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const alert = makeAlert({ appendLocal, slackAlert, logger });

    await alert("cost cap exceeded");

    expect(appendLocal).toHaveBeenCalledWith("cost cap exceeded");
    expect(slackAlert).toHaveBeenCalledWith("cost cap exceeded");
  });

  it("swallows a Slack-post failure -- does not throw, and still wrote the local log", async () => {
    const appendLocal = vi.fn();
    const slackAlert = vi.fn().mockRejectedValue(new Error("slack down"));
    const logger = fakeLogger();
    const alert = makeAlert({ appendLocal, slackAlert, logger });

    await expect(alert("oops")).resolves.toBeUndefined();

    expect(appendLocal).toHaveBeenCalledWith("oops");
    expect(slackAlert).toHaveBeenCalledWith("oops");
    expect(logger.error).toHaveBeenCalled();
  });

  it("swallows a local-log failure -- does not throw, and still attempted Slack", async () => {
    const appendLocal = vi.fn(() => {
      throw new Error("disk full");
    });
    const slackAlert = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const alert = makeAlert({ appendLocal, slackAlert, logger });

    await expect(alert("oops")).resolves.toBeUndefined();

    expect(slackAlert).toHaveBeenCalledWith("oops");
    expect(logger.error).toHaveBeenCalled();
  });

  it("attempts both independently: a local-log failure does not stop the Slack attempt, and a Slack failure does not stop (or undo) the local log", async () => {
    const appendLocal = vi.fn(() => {
      throw new Error("disk full");
    });
    const slackAlert = vi.fn().mockRejectedValue(new Error("slack down"));
    const logger = fakeLogger();
    const alert = makeAlert({ appendLocal, slackAlert, logger });

    await expect(alert("oops")).resolves.toBeUndefined();

    expect(appendLocal).toHaveBeenCalledWith("oops");
    expect(slackAlert).toHaveBeenCalledWith("oops");
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("in dry-run (no slackAlert given), only logs locally + via the logger -- no Slack call is attempted", async () => {
    const appendLocal = vi.fn();
    const logger = fakeLogger();
    const alert = makeAlert({ appendLocal, logger });

    await alert("skipping this week");

    expect(appendLocal).toHaveBeenCalledWith("skipping this week");
    expect(logger.warn).toHaveBeenCalledWith(
      "[agent-alert] skipping this week",
    );
  });
});
