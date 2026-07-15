import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileSettings } from "./config/profile.js";
import {
  applySecretsToEnv,
  buildAlert,
  DEFAULT_LOG_PATH,
  makeBuildPlanWithSync,
} from "./index.js";
import type { EnrichedWeekPlan } from "./planner/enrich.js";
import type { SyncResult } from "./recipe-mcp/sync.js";
import type { Secrets } from "./secrets/secrets.js";

const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  // Never let a test-injected key leak into other tests.
  if (ORIGINAL_ANTHROPIC_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  }
});

function fakeSecrets(): Secrets {
  return {
    slackBotToken: "xoxb-fake",
    anthropicApiKey: "sk-ant-fake-test-value",
  };
}

function fakeProfile(
  overrides: Partial<ProfileSettings> = {},
): ProfileSettings {
  return {
    profile: "dev",
    channelId: "C_MEAL_PLAN",
    sqlitePath: "./data/meal-planner.dev.sqlite",
    forceRegenerate: true,
    postMode: "dry-run",
    ...overrides,
  };
}

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("applySecretsToEnv", () => {
  it("wires the loaded Anthropic API key into process.env.ANTHROPIC_API_KEY by default", () => {
    delete process.env.ANTHROPIC_API_KEY;

    applySecretsToEnv(fakeSecrets());

    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-fake-test-value");
  });

  it("writes into an injected env object instead of the real process.env when one is given", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const env: NodeJS.ProcessEnv = {};

    applySecretsToEnv(fakeSecrets(), env);

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fake-test-value");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("buildAlert", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("dry-run: writes to the local log at MP_LOG_PATH and never attempts a Slack post (no MP_ALERTS_CHANNEL_ID warning)", async () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-alert-"));
    const logPath = join(dir, "alerts.log");
    const logger = fakeLogger();

    const alert = buildAlert(
      fakeProfile({ postMode: "dry-run" }),
      fakeSecrets(),
      { MP_LOG_PATH: logPath },
      logger,
    );

    await alert("test alert message");

    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("test alert message");
    expect(logger.warn).toHaveBeenCalledWith(
      "[agent-alert] test alert message",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("MP_ALERTS_CHANNEL_ID"),
    );
  });

  it("post mode with MP_ALERTS_CHANNEL_ID unset: warns and falls back to local-log-only without throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-alert-"));
    const logPath = join(dir, "alerts.log");
    const logger = fakeLogger();

    const alert = buildAlert(
      fakeProfile({ postMode: "post" }),
      fakeSecrets(),
      { MP_LOG_PATH: logPath },
      logger,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("MP_ALERTS_CHANNEL_ID"),
    );

    await expect(alert("cost cap hit")).resolves.toBeUndefined();
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("cost cap hit");
  });

  it("post mode with MP_ALERTS_CHANNEL_ID set: does not warn about a missing alerts channel", () => {
    const logger = fakeLogger();

    buildAlert(
      fakeProfile({ postMode: "post" }),
      fakeSecrets(),
      {
        MP_LOG_PATH: "unused-for-this-assertion.log",
        MP_ALERTS_CHANNEL_ID: "C_ALERTS",
      },
      logger,
    );

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("MP_ALERTS_CHANNEL_ID"),
    );
  });

  it("defaults the local log path to DEFAULT_LOG_PATH when MP_LOG_PATH is unset", () => {
    expect(DEFAULT_LOG_PATH).toBe("./data/meal-planner.log");
  });
});

describe("makeBuildPlanWithSync", () => {
  const PLAN = { sentinel: "the-plan" } as unknown as EnrichedWeekPlan;

  function okSyncResult(): SyncResult {
    return { total: 3, processed: 1, skipped: 2, extractionFailures: 0 };
  }

  it("syncs before planning, logs the summary, and returns the plan", async () => {
    const calls: string[] = [];
    const runSync = vi.fn(async () => {
      calls.push("sync");
      return okSyncResult();
    });
    const buildPlan = vi.fn(async (_wk: string) => {
      calls.push("plan");
      return PLAN;
    });
    const alert = vi.fn(async () => {});
    const logger = { log: vi.fn(), warn: vi.fn() };

    const fn = makeBuildPlanWithSync({ runSync, buildPlan, alert, logger });
    const result = await fn("2026-07-12");

    expect(calls).toEqual(["sync", "plan"]);
    expect(buildPlan).toHaveBeenCalledWith("2026-07-12");
    expect(result).toBe(PLAN);
    expect(alert).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("processed=1"),
    );
  });

  it("proceeds to plan and alerts (does not throw) when sync fails", async () => {
    const runSync = vi.fn(async () => {
      throw new Error("Notes not authorized");
    });
    const buildPlan = vi.fn(async (_wk: string) => PLAN);
    const alert = vi.fn(async () => {});
    const logger = { log: vi.fn(), warn: vi.fn() };

    const fn = makeBuildPlanWithSync({ runSync, buildPlan, alert, logger });
    const result = await fn("2026-07-12");

    expect(result).toBe(PLAN);
    expect(buildPlan).toHaveBeenCalledWith("2026-07-12");
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining("recipe sync failed"),
    );
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("2026-07-12"));
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not leak the sync error into a rejected plan when alert itself throws", async () => {
    const runSync = vi.fn(async () => {
      throw new Error("boom");
    });
    const buildPlan = vi.fn(async (_wk: string) => PLAN);
    // A never-throwing alerter is the contract (see ops/alerter), but guard
    // the wiring anyway: a broken alert must not sink the whole generation.
    const alert = vi.fn(async () => {
      throw new Error("alert transport down");
    });
    const logger = { log: vi.fn(), warn: vi.fn() };

    const fn = makeBuildPlanWithSync({ runSync, buildPlan, alert, logger });

    await expect(fn("2026-07-12")).resolves.toBe(PLAN);
  });
});
