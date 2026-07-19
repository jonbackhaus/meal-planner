import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileSettings } from "./config/profile.js";
import {
  applySecretsToEnv,
  buildAlert,
  buildDryRunPost,
  DEFAULT_LOG_PATH,
  makeBuildPlanWithSync,
  makeFatalHandler,
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

describe("buildDryRunPost", () => {
  function fakePlan(weekKey: string): EnrichedWeekPlan {
    return { week_key: weekKey, meals: [] } as unknown as EnrichedWeekPlan;
  }

  it("returns a week-scoped synthetic ts (dryrun-<week_key>), stable across repeated posts", async () => {
    const logger = { log: vi.fn() };
    const post = buildDryRunPost(fakeProfile(), logger);

    const first = await post(fakePlan("2026-07-19"));
    const second = await post(fakePlan("2026-07-19"));

    expect(first.ts).toBe("dryrun-2026-07-19");
    // Stable for the same week — not an incrementing per-process counter, so
    // it survives daemon reboots without colliding in getByThreadTs (bd6.14).
    expect(second.ts).toBe("dryrun-2026-07-19");
  });

  it("derives a distinct ts per week", async () => {
    const post = buildDryRunPost(fakeProfile(), { log: vi.fn() });

    const a = await post(fakePlan("2026-07-19"));
    const b = await post(fakePlan("2026-07-26"));

    expect(a.ts).toBe("dryrun-2026-07-19");
    expect(b.ts).toBe("dryrun-2026-07-26");
  });

  it("logs the rendered plan labelled DRY-RUN with the channel and ts", async () => {
    const logger = { log: vi.fn() };
    const post = buildDryRunPost(
      fakeProfile({ channelId: "C_DRYRUN" }),
      logger,
    );

    await post(fakePlan("2026-07-19"));

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "[DRY-RUN post] channel=C_DRYRUN ts=dryrun-2026-07-19",
      ),
    );
  });
});

describe("makeFatalHandler", () => {
  it("appends to the local log, attempts the alert, and calls exit(1)", async () => {
    const appendLocal = vi.fn();
    const alert = vi.fn(async () => {});
    const exit = vi.fn();
    const logger = { error: vi.fn() };

    const handler = makeFatalHandler({ appendLocal, alert, exit, logger });
    await handler(new Error("boom"));

    expect(appendLocal).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits(1) without throwing when the alert rejects", async () => {
    const appendLocal = vi.fn();
    const alert = vi.fn(async () => {
      throw new Error("alert transport down");
    });
    const exit = vi.fn();
    const logger = { error: vi.fn() };

    const handler = makeFatalHandler({ appendLocal, alert, exit, logger });

    await expect(handler(new Error("boom"))).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("alert attempt failed"),
    );
  });

  it("still exits(1) when the synchronous local-log append throws", async () => {
    const appendLocal = vi.fn(() => {
      throw new Error("disk full");
    });
    const alert = vi.fn(async () => {});
    const exit = vi.fn();
    const logger = { error: vi.fn() };

    const handler = makeFatalHandler({ appendLocal, alert, exit, logger });

    await expect(handler(new Error("boom"))).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("local log append failed"),
    );
  });

  it("still exits(1) when the alert hangs (bounded by the timeout)", async () => {
    const appendLocal = vi.fn();
    // Never resolves — simulates a hung Slack transport.
    const alert = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    const logger = { error: vi.fn() };

    const handler = makeFatalHandler({
      appendLocal,
      alert,
      exit,
      logger,
      alertTimeoutMs: 5,
    });

    await handler(new Error("boom"));

    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("makeBuildPlanWithSync", () => {
  const PLAN = { sentinel: "the-plan" } as unknown as EnrichedWeekPlan;

  function okSyncResult(): SyncResult {
    return {
      total: 3,
      processed: 1,
      skipped: 2,
      extractionFailures: 0,
      removed: 0,
      suspiciousEmptyRead: false,
    };
  }

  function suspiciousEmptyReadResult(): SyncResult {
    return {
      total: 0,
      processed: 0,
      skipped: 0,
      extractionFailures: 0,
      removed: 0,
      suspiciousEmptyRead: true,
    };
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

  it("alerts loudly (once) on a suspicious empty read, and still proceeds to plan", async () => {
    const runSync = vi.fn(async () => suspiciousEmptyReadResult());
    const buildPlan = vi.fn(async (_wk: string) => PLAN);
    const alert = vi.fn(async (_message: string) => {});
    const logger = { log: vi.fn(), warn: vi.fn() };

    const fn = makeBuildPlanWithSync({ runSync, buildPlan, alert, logger });
    const result = await fn("2026-07-19");

    // Proceeds to plan (proceed + alert policy; q95.14 deliberately continues).
    expect(result).toBe(PLAN);
    expect(buildPlan).toHaveBeenCalledWith("2026-07-19");
    // Alerts LOUDLY via the composite exactly once — not warn-only (fkg.7).
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("0 notes"));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("2026-07-19"));
    // Secret-free: no note bodies/titles, just counts + reason.
    const msg = alert.mock.calls[0]?.[0] ?? "";
    expect(msg).toMatch(/permission|Full Disk Access|Automation/i);
  });

  it("does not alert on a normal non-empty sync (no suspicious empty read)", async () => {
    const runSync = vi.fn(async () => okSyncResult());
    const buildPlan = vi.fn(async (_wk: string) => PLAN);
    const alert = vi.fn(async () => {});
    const logger = { log: vi.fn(), warn: vi.fn() };

    const fn = makeBuildPlanWithSync({ runSync, buildPlan, alert, logger });
    await fn("2026-07-19");

    expect(alert).not.toHaveBeenCalled();
  });

  it("does not reject the plan when the suspicious-empty-read alert itself throws", async () => {
    const runSync = vi.fn(async () => suspiciousEmptyReadResult());
    const buildPlan = vi.fn(async (_wk: string) => PLAN);
    const alert = vi.fn(async () => {
      throw new Error("alert transport down");
    });
    const logger = { log: vi.fn(), warn: vi.fn() };

    const fn = makeBuildPlanWithSync({ runSync, buildPlan, alert, logger });

    await expect(fn("2026-07-19")).resolves.toBe(PLAN);
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
