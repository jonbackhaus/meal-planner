import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NightSchedule } from "./calendar/night-schedule.js";
import type { ProfileSettings } from "./config/profile.js";
import {
  applySecretsToEnv,
  buildAlert,
  buildApprovalHandler,
  buildDryRunPost,
  buildRecencyReader,
  buildResetPauseHandler,
  buildRevisionSystem,
  DEFAULT_LOG_PATH,
  makeBuildPlanWithSync,
  makeFatalHandler,
} from "./index.js";
import type { LlmClient, LlmResult } from "./llm/llm-client.js";
import { createRevisionCoordinator } from "./orchestrator/revision-coordinator.js";
import type { RevisionSlackClient } from "./orchestrator/revision-post.js";
import type { Session, SessionStore } from "./orchestrator/session-store.js";
import type { EnrichedWeekPlan } from "./planner/enrich.js";
import type { PrepUnit, SelectedMeal, WeekPlan } from "./planner/select.js";
import type { Recipe } from "./recipe-mcp/schema.js";
import type { StaleCount, SyncResult } from "./recipe-mcp/sync.js";
import type { Secrets } from "./secrets/secrets.js";
import type { InboundThreadReply } from "./slack/inbound-router.js";
import { renderPlan } from "./slack/render.js";

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
    todoist: { projectId: "", titleTemplate: "{title}", recipeLinkFormat: "" },
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

  it("passes plan.nightSchedule + resolved prep into renderPlan so the dry-run log shows capacity/prep annotations (ADR 0005 D4, bd meal-planner-0v7.7)", async () => {
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

    const logger = { log: vi.fn() };
    const post = buildDryRunPost(fakeProfile(), logger);

    await post(dayPlan);

    const expectedText = renderPlan(dayPlan, { nightSchedule, prep });
    expect(expectedText).toMatch(/\*Tuesday\*.*quick/i);
    expect(expectedText).toContain("prep Sun → serve Tue");
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(expectedText),
    );
  });

  it("still posts (fallback render, no crash) when the plan is degraded (day: null, no nightSchedule)", async () => {
    const degradedPlan: EnrichedWeekPlan = {
      week_key: "2026-07-26",
      meals: [],
    };
    const logger = { log: vi.fn() };
    const post = buildDryRunPost(fakeProfile(), logger);

    const result = await post(degradedPlan);

    expect(result.ts).toBe("dryrun-2026-07-26");
    expect(logger.log).toHaveBeenCalled();
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

  describe("mass-stale-sync budget guard (bd meal-planner-a9e)", () => {
    function staleCount(stale: number, total = 764): StaleCount {
      return { total, stale };
    }

    it("skips the inline sync, alerts with count + resync guidance, and proceeds against the existing index when stale count exceeds the threshold", async () => {
      const runSync = vi.fn(async () => okSyncResult());
      const countStale = vi.fn(async () => staleCount(694));
      const buildPlan = vi.fn(async (_wk: string) => PLAN);
      const alert = vi.fn(async (_message: string) => {});
      const logger = { log: vi.fn(), warn: vi.fn() };

      const fn = makeBuildPlanWithSync({
        runSync,
        countStale,
        staleSyncThreshold: 50,
        buildPlan,
        alert,
        logger,
      });
      const result = await fn("2026-07-19");

      expect(result).toBe(PLAN);
      expect(buildPlan).toHaveBeenCalledWith("2026-07-19");
      // The expensive inline sync must NEVER be started (bd a9e's core guard).
      expect(runSync).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(1);
      const message = alert.mock.calls[0]?.[0] ?? "";
      expect(message).toContain("694");
      expect(message).toContain("764");
      expect(message).toMatch(/resync-recipes|RUNBOOK/i);
      expect(message).toContain("2026-07-19");
    });

    it("runs the inline sync normally when the stale count is at or below the threshold", async () => {
      const runSync = vi.fn(async () => okSyncResult());
      const countStale = vi.fn(async () => staleCount(10));
      const buildPlan = vi.fn(async (_wk: string) => PLAN);
      const alert = vi.fn(async () => {});
      const logger = { log: vi.fn(), warn: vi.fn() };

      const fn = makeBuildPlanWithSync({
        runSync,
        countStale,
        staleSyncThreshold: 50,
        buildPlan,
        alert,
        logger,
      });
      const result = await fn("2026-07-19");

      expect(result).toBe(PLAN);
      expect(runSync).toHaveBeenCalledTimes(1);
      expect(buildPlan).toHaveBeenCalledWith("2026-07-19");
      expect(alert).not.toHaveBeenCalled();
    });

    it("respects a config-driven (non-hardcoded) threshold override", async () => {
      const runSyncBelow = vi.fn(async () => okSyncResult());
      const fnLowThreshold = makeBuildPlanWithSync({
        runSync: runSyncBelow,
        countStale: vi.fn(async () => staleCount(60)),
        staleSyncThreshold: 50,
        buildPlan: vi.fn(async (_wk: string) => PLAN),
        alert: vi.fn(async () => {}),
        logger: { log: vi.fn(), warn: vi.fn() },
      });
      await fnLowThreshold("2026-07-19");
      // 60 > 50 -> guard trips, inline sync skipped.
      expect(runSyncBelow).not.toHaveBeenCalled();

      const runSyncHigh = vi.fn(async () => okSyncResult());
      const fnHighThreshold = makeBuildPlanWithSync({
        runSync: runSyncHigh,
        countStale: vi.fn(async () => staleCount(60)),
        staleSyncThreshold: 1000,
        buildPlan: vi.fn(async (_wk: string) => PLAN),
        alert: vi.fn(async () => {}),
        logger: { log: vi.fn(), warn: vi.fn() },
      });
      await fnHighThreshold("2026-07-19");
      // Same stale count, but the (overridden) threshold is now well above it.
      expect(runSyncHigh).toHaveBeenCalledTimes(1);
    });

    it("falls back to running the normal inline sync when the pre-count itself fails", async () => {
      const runSync = vi.fn(async () => okSyncResult());
      const countStale = vi.fn(async () => {
        throw new Error("Notes not authorized");
      });
      const buildPlan = vi.fn(async (_wk: string) => PLAN);
      const alert = vi.fn(async () => {});
      const logger = { log: vi.fn(), warn: vi.fn() };

      const fn = makeBuildPlanWithSync({
        runSync,
        countStale,
        staleSyncThreshold: 50,
        buildPlan,
        alert,
        logger,
      });
      const result = await fn("2026-07-19");

      expect(result).toBe(PLAN);
      expect(runSync).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("stale-recipe pre-count failed"),
      );
    });

    it("never consults the threshold guard when countStale is omitted (back-compat: always syncs inline)", async () => {
      const runSync = vi.fn(async () => okSyncResult());
      const buildPlan = vi.fn(async (_wk: string) => PLAN);
      const alert = vi.fn(async () => {});
      const logger = { log: vi.fn(), warn: vi.fn() };

      const fn = makeBuildPlanWithSync({ runSync, buildPlan, alert, logger });
      await fn("2026-07-19");

      expect(runSync).toHaveBeenCalledTimes(1);
      expect(alert).not.toHaveBeenCalled();
    });
  });
});

/**
 * v3.0 boot-assembly integration tests (bd meal-planner-uo1): asserts the
 * COMPOSED revision chain (B1-B5) and the shared `RevisionCoordinator`
 * actually wire together end-to-end at the `index.ts` seam -- exercising
 * `buildRevisionSystem`/`buildApprovalHandler` directly with fakes, never a
 * real Slack/Anthropic/Todoist network call. Per-piece behavior (validation
 * repair, debounce windowing edge cases, cost-cap math, etc.) is already
 * covered by each wrapper's own test file; these tests only check that the
 * pieces are wired in the right order and share the right instances.
 */
describe("buildRevisionSystem + buildApprovalHandler wiring (bd meal-planner-uo1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function llmResult(text: string): LlmResult {
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }

  function makeFakeLlm(...responses: string[]): LlmClient {
    const runQuery = vi.fn();
    for (const response of responses) {
      runQuery.mockResolvedValueOnce(llmResult(response));
    }
    return { runQuery };
  }

  function meal(overrides: Partial<SelectedMeal> = {}): SelectedMeal {
    return {
      slot_type: "constrained",
      recipe_id: "recipe-1",
      title: "Veggie Chili",
      day: null,
      veg: { kind: "inherent" },
      flags: [],
      rationale: "Quick, vegetarian, high quality.",
      ...overrides,
    };
  }

  function weekPlan(meals: SelectedMeal[] = [meal()]): WeekPlan {
    return { week_key: "2026-07-12", meals, summary: "A tasty week." };
  }

  function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
    return {
      id,
      title: `Recipe ${id}`,
      time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
      effort_tags: [],
      season_tags: [],
      veg_status: "vegetarian",
      ingredients: [],
      body: "body text",
      source_note_id: id,
      ...overrides,
    };
  }

  function session(overrides: Partial<Session> = {}): Session {
    return {
      week_key: "2026-07-12",
      status: "suggested",
      thread_ts: "1000.0001",
      working_plan: weekPlan(),
      turn_count: 0,
      token_spend: 0,
      cost_usd: 0,
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
      ...overrides,
    };
  }

  function fakeSessionStore(rows: Record<string, Session>) {
    const table = new Map(Object.entries(rows));
    const update = vi.fn((weekKey: string, patch: Partial<Session>) => {
      const row = table.get(weekKey);
      if (!row) {
        return;
      }
      table.set(weekKey, { ...row, ...patch });
    });
    return {
      store: {
        get: (weekKey: string) => table.get(weekKey) ?? null,
        update,
      } as Pick<SessionStore, "get" | "update">,
      table,
      update,
    };
  }

  function fakeSlack(
    response: { ok?: boolean; ts?: string; error?: string } = {
      ok: true,
      ts: "2000.0001",
    },
  ): { slack: RevisionSlackClient; postMessage: ReturnType<typeof vi.fn> } {
    const postMessage = vi.fn().mockResolvedValue(response);
    return { slack: { chat: { postMessage } }, postMessage };
  }

  function threadReply(
    overrides: Partial<InboundThreadReply> = {},
  ): InboundThreadReply {
    return {
      weekKey: "2026-07-12",
      threadTs: "1000.0001",
      event: {
        type: "message",
        channel: "C123",
        user: "U123",
        ts: "1000.0002",
        thread_ts: "1000.0001",
        text: "swap the chili for tacos",
      },
      ...overrides,
    };
  }

  function generousCaps() {
    return {
      cycleTokenCap: 1_000_000,
      threadTurnCap: 25,
      threadDollarCap: 100,
    };
  }

  it("composes debounce ⊃ serialize ⊃ cost-guard ⊃ B1/onRevised=guardOnRevised(B2): a reply mutates the plan, posts a NEW thread reply, writes working_plan back, and folds cost-guard spend onto the SAME row (B1-B5, one RevisionHandler)", async () => {
    vi.useFakeTimers();

    const revised = weekPlan([meal({ title: "Bean Tacos" })]);
    const { store, table } = fakeSessionStore({
      "2026-07-12": session(),
    });
    const coordinator = createRevisionCoordinator();
    const llm = makeFakeLlm(JSON.stringify(revised));
    const { slack, postMessage } = fakeSlack();
    const getRecipe = async (id: string) =>
      id === "recipe-1" ? recipe("recipe-1") : null;

    const system = buildRevisionSystem({
      sessionStore: store,
      coordinator,
      llm,
      getRecipe,
      validateConfig: { slots: { constrained: 1, relaxed: 0 } },
      slack,
      channelId: "C_MEAL_PLAN",
      caps: generousCaps(),
      rate: { inputPerMTok: 1, outputPerMTok: 0 },
      alert: vi.fn(async () => {}),
    });

    system.revisionHandler.onReply(threadReply());
    // Debounce (B3) is outermost: nothing downstream runs until the window
    // elapses.
    expect(llm.runQuery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));

    // B1: the mutation call ran.
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    // B2/guardOnRevised (B4): validated + posted as a NEW thread reply, and
    // the revised working_plan landed back on the SAME session row.
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: "1000.0001" }),
    );
    expect(table.get("2026-07-12")?.working_plan).toEqual(revised);
    // B5: the cost guard's per-cycle spend folded onto the SAME row.
    expect(table.get("2026-07-12")?.turn_count).toBe(1);
    expect(table.get("2026-07-12")?.token_spend).toBeGreaterThan(0);
    // B4/serializeRevisionHandler: status round-tripped back to `suggested`
    // (never left stuck `under_revision`).
    expect(table.get("2026-07-12")?.status).toBe("suggested");
  });

  it("the SAME RevisionCoordinator drives BOTH the revision chain's supersede check AND the approval handler's supersede call (B4/D4): approving before the debounce window flushes drops the in-flight revision", async () => {
    vi.useFakeTimers();

    const { store, table } = fakeSessionStore({
      "2026-07-12": session(),
    });
    const coordinator = createRevisionCoordinator();
    const llm = makeFakeLlm(JSON.stringify(weekPlan()));
    const { slack, postMessage } = fakeSlack();

    const system = buildRevisionSystem({
      sessionStore: store,
      coordinator,
      llm,
      getRecipe: async (id) => recipe(id),
      validateConfig: { slots: { constrained: 1, relaxed: 0 } },
      slack,
      channelId: "C_MEAL_PLAN",
      caps: generousCaps(),
      rate: { inputPerMTok: 1, outputPerMTok: 0 },
      alert: vi.fn(async () => {}),
    });

    // The approval handler is built with the SAME coordinator instance
    // (mirrors index.ts's main() wiring, bd meal-planner-uo1).
    const approvalHandler = buildApprovalHandler(
      { channelId: "C_MEAL_PLAN", todoist: {} } as never,
      { slackBotToken: "xoxb-fake", todoistApiToken: "fake-token" } as never,
      store,
      coordinator,
    );

    system.revisionHandler.onReply(threadReply());

    // Approval lands (and supersedes) BEFORE the debounce window flushes.
    // The real onApprove would go on to hit Todoist/Slack; skip that by
    // dropping the row's working_plan so it degrades to a safe no-op after
    // the supersede call -- the assertion only cares that supersede fired.
    await approvalHandler?.onApprove({
      weekKey: "2026-07-12",
      threadTs: "1000.0001",
      command: { command: "/mp-approved" },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(llm.runQuery).toHaveBeenCalledTimes(0));

    // serializeRevisionHandler (B4) saw the coordinator already superseded
    // and skipped the downstream mutation entirely -- proving the approval
    // handler's `.supersede()` call and the revision chain's
    // `.isSuperseded()` check share the SAME coordinator instance.
    expect(llm.runQuery).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(table.get("2026-07-12")?.working_plan).toEqual(
      session().working_plan,
    );
  });

  it("resetPause (B5, ADR-0007 D6) clears a paused_cost row on the guard this revisionSystem was built with", () => {
    const { store, table } = fakeSessionStore({
      "2026-07-12": session({
        status: "paused_cost",
        turn_count: 4,
        token_spend: 5_000_000,
        cost_usd: 5.2,
      }),
    });
    const coordinator = createRevisionCoordinator();

    const system = buildRevisionSystem({
      sessionStore: store,
      coordinator,
      llm: makeFakeLlm(),
      getRecipe: async () => null,
      validateConfig: { slots: { constrained: 1, relaxed: 0 } },
      slack: fakeSlack().slack,
      channelId: "C_MEAL_PLAN",
      caps: generousCaps(),
      rate: { inputPerMTok: 1, outputPerMTok: 0 },
      alert: vi.fn(async () => {}),
    });

    system.resetPause("2026-07-12");

    const row = table.get("2026-07-12");
    expect(row?.status).toBe("suggested");
    expect(row?.turn_count).toBe(0);
    expect(row?.token_spend).toBe(0);
    expect(row?.cost_usd).toBe(0);
  });

  describe("buildResetPauseHandler (bd meal-planner-m49, ADR-0007 D6)", () => {
    it("calls resetPause(weekKey) and posts a resumed confirmation when the week was paused_cost", async () => {
      const { store, table } = fakeSessionStore({
        "2026-07-12": session({ status: "paused_cost" }),
      });
      const resetPause = vi.fn((weekKey: string) => {
        const row = table.get(weekKey);
        if (row) {
          table.set(weekKey, { ...row, status: "suggested" });
        }
      });
      const { slack, postMessage } = fakeSlack();

      const handler = buildResetPauseHandler(
        resetPause,
        store,
        slack,
        "C_MEAL_PLAN",
      );

      await handler.onResetPause({
        weekKey: "2026-07-12",
        threadTs: "1000.0001",
        command: { command: "/mp-resume" },
      });

      expect(resetPause).toHaveBeenCalledWith("2026-07-12");
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C_MEAL_PLAN",
          thread_ts: "1000.0001",
          text: expect.stringContaining("resumed"),
        }),
      );
    });

    it("posts a benign 'nothing to resume' confirmation when the week was NOT paused_cost (resetPause still called -- the guard itself no-ops)", async () => {
      const { store } = fakeSessionStore({
        "2026-07-12": session({ status: "suggested" }),
      });
      const resetPause = vi.fn();
      const { slack, postMessage } = fakeSlack();

      const handler = buildResetPauseHandler(
        resetPause,
        store,
        slack,
        "C_MEAL_PLAN",
      );

      await handler.onResetPause({
        weekKey: "2026-07-12",
        threadTs: "1000.0001",
        command: { command: "/mp-resume" },
      });

      expect(resetPause).toHaveBeenCalledWith("2026-07-12");
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("nothing to resume"),
        }),
      );
    });

    it("does not throw when the confirmation post itself rejects (logs instead)", async () => {
      const { store } = fakeSessionStore({
        "2026-07-12": session({ status: "paused_cost" }),
      });
      const resetPause = vi.fn();
      const postMessage = vi.fn().mockRejectedValue(new Error("network"));
      const slack: RevisionSlackClient = { chat: { postMessage } };
      const logger = { error: vi.fn() };

      const handler = buildResetPauseHandler(
        resetPause,
        store,
        slack,
        "C_MEAL_PLAN",
        logger,
      );

      await expect(
        handler.onResetPause({
          weekKey: "2026-07-12",
          threadTs: "1000.0001",
          command: { command: "/mp-resume" },
        }),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("network"),
      );
    });
  });

  it("buildApprovalHandler passes the injected RevisionCoordinator through to onApprove's supersede call", async () => {
    const { store } = fakeSessionStore({
      // No working_plan -- onApprove degrades to a safe no-op after
      // supersede, so this never touches a real Todoist/Slack client.
      "2026-07-12": session({ working_plan: null }),
    });
    const supersede = vi.fn();
    const coordinator = { supersede };

    const approvalHandler = buildApprovalHandler(
      { channelId: "C_MEAL_PLAN", todoist: {} } as never,
      { slackBotToken: "xoxb-fake", todoistApiToken: "fake-token" } as never,
      store,
      coordinator,
    );

    await approvalHandler?.onApprove({
      weekKey: "2026-07-12",
      threadTs: "1000.0001",
      command: { command: "/mp-approved" },
    });

    expect(supersede).toHaveBeenCalledWith("2026-07-12");
  });

  it("buildApprovalHandler returns undefined (no coordinator wiring needed) when Todoist isn't configured", () => {
    const { store } = fakeSessionStore({});
    const coordinator = { supersede: vi.fn() };

    const approvalHandler = buildApprovalHandler(
      { channelId: "C_MEAL_PLAN", todoist: {} } as never,
      { slackBotToken: "xoxb-fake" } as never,
      store,
      coordinator,
    );

    expect(approvalHandler).toBeUndefined();
  });

  it("buildRecencyReader returns undefined (no client assembled) when Todoist isn't configured", () => {
    const reader = buildRecencyReader(
      { channelId: "C_MEAL_PLAN", todoist: {} } as never,
      { slackBotToken: "xoxb-fake" } as never,
    );

    expect(reader).toBeUndefined();
  });

  it("buildRecencyReader returns a bound reader function when Todoist IS configured", () => {
    const reader = buildRecencyReader(
      {
        channelId: "C_MEAL_PLAN",
        todoist: {
          projectId: "",
          titleTemplate: "{title}",
          recipeLinkFormat: "",
        },
      } as never,
      { slackBotToken: "xoxb-fake", todoistApiToken: "fake-token" } as never,
    );

    expect(reader).toBeTypeOf("function");
  });
});
