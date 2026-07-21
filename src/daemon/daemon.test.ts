import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import type { ProfileSettings } from "../config/profile.js";
import { composeDaemon } from "../orchestrator/compose.js";
import { SessionStore } from "../orchestrator/session-store.js";
import type { Secrets } from "../secrets/secrets.js";

vi.mock("./system-check.js", () => ({
  checkSystemSleepDisabled: vi.fn(async () => ({
    disabled: true,
    raw: "sleep 0",
  })),
}));

import { runDaemon } from "./daemon.js";
import { checkSystemSleepDisabled } from "./system-check.js";

const mockedCheckSystemSleepDisabled = vi.mocked(checkSystemSleepDisabled);

function fakeConfig(): Config {
  return {
    profile: "dev",
    timezone: "America/Chicago",
    triggerTime: "06:00",
    model: "claude-sonnet-5",
    effort: "medium",
    modelRates: {
      "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
    },
    cookNights: { constrained: 4, relaxed: 2 },
    activeMaxMinutes: 60,
    fanoutMultiplier: 4,
    vegFloorK: 2,
    untestedRate: 0.15,
    maxPairedSides: 2,
    generationDollarCap: 2,
    staleSyncThreshold: 50,
    triggerTimeoutMs: 2_700_000,
    llmCallTimeoutMs: 240_000,
  };
}

function fakeSecrets(): Secrets {
  return { slackBotToken: "xoxb-fake", anthropicApiKey: "sk-ant-fake" };
}

/** A minimal fake process implementing only what runDaemon needs (once/emit for SIGINT/SIGTERM). */
class FakeProcess extends EventEmitter {}

afterEach(() => {
  mockedCheckSystemSleepDisabled.mockReset();
  mockedCheckSystemSleepDisabled.mockImplementation(async () => ({
    disabled: true,
    raw: "sleep 0",
  }));
  vi.useRealTimers();
});

describe("runDaemon", () => {
  it("runs onStartup exactly once before the scheduler would fire", async () => {
    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      process: proc as unknown as NodeJS.Process,
    });

    expect(onStartup).toHaveBeenCalledTimes(1);
    expect(onTrigger).not.toHaveBeenCalled();

    await handle.shutdown();
  });

  it("stops cleanly on SIGTERM: resolves `stopped` and stops the scheduler", async () => {
    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      process: proc as unknown as NodeJS.Process,
    });

    proc.emit("SIGTERM");

    await expect(handle.stopped).resolves.toBeUndefined();
  });

  it("stops cleanly on SIGINT as well", async () => {
    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      process: proc as unknown as NodeJS.Process,
    });

    proc.emit("SIGINT");

    await expect(handle.stopped).resolves.toBeUndefined();
  });

  it("supports an explicit shutdown() call independent of process signals", async () => {
    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      process: proc as unknown as NodeJS.Process,
    });

    await handle.shutdown();
    await expect(handle.stopped).resolves.toBeUndefined();
  });

  it("triggerNow() invokes onTrigger exactly once (test-fire affordance)", async () => {
    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      process: proc as unknown as NodeJS.Process,
    });

    await handle.triggerNow();

    expect(onTrigger).toHaveBeenCalledTimes(1);

    await handle.shutdown();
  });

  it("fireOnStart: true fires onTrigger once automatically after startup + scheduling", async () => {
    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      fireOnStart: true,
      process: proc as unknown as NodeJS.Process,
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);

    await handle.shutdown();
  });

  it("fireOnStart: a failing test-fire is contained -- runDaemon resolves, the daemon keeps running, and it alerts", async () => {
    const onStartup = vi.fn(async () => {});
    const boom = new Error("PRIMARY KEY constraint failed: sessions.week_key");
    const onTrigger = vi.fn(async () => {
      throw boom;
    });
    const alert = vi.fn(async () => {});
    const proc = new FakeProcess();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // fireOnStart calls scheduler.triggerNow(), which (by design) propagates
    // onTrigger's error to its caller -- unlike the scheduled fire, whose
    // croner `catch` contains it. Left unguarded, that rejection rejects
    // runDaemon -> main() -> process.exit(1); with MP_FIRE_ON_START persisted
    // in launchd env (+ dev forceRegenerate re-firing into a PK-insert throw)
    // that's a tight restart loop. runDaemon must contain it and keep running.
    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert,
      fireOnStart: true,
      process: proc as unknown as NodeJS.Process,
      logger,
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    // The failure is surfaced (alert-only discipline) and logged, not swallowed.
    expect(alert).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    // The daemon is alive: the handle works and shuts down cleanly.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("calls checkSystemSleepDisabled at boot and logs a warning (not a throw) when sleep is enabled", async () => {
    mockedCheckSystemSleepDisabled.mockImplementation(async () => ({
      disabled: false,
      raw: "sleep 10",
    }));

    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      process: proc as unknown as NodeJS.Process,
      logger,
    });

    expect(mockedCheckSystemSleepDisabled).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

    await handle.shutdown();
  });

  it("does not warn when sleep is confirmed disabled", async () => {
    mockedCheckSystemSleepDisabled.mockImplementation(async () => ({
      disabled: true,
      raw: "sleep 0",
    }));

    const onStartup = vi.fn(async () => {});
    const onTrigger = vi.fn(async () => {});
    const proc = new FakeProcess();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const handle = await runDaemon({
      config: fakeConfig(),
      secrets: fakeSecrets(),
      onStartup,
      onTrigger,
      alert: vi.fn(async () => {}),
      process: proc as unknown as NodeJS.Process,
      logger,
    });

    expect(logger.warn).not.toHaveBeenCalled();

    await handle.shutdown();
  });

  describe("dev fireOnStart + startup catch-up overlap (bd meal-planner-8o3)", () => {
    // The real, unmocked composeDaemon `{ onStartup, onTrigger }` wired
    // together (not fakes) -- reproduces the actual reported defect: a dev
    // boot past the weekly trigger with no session row yet, so onStartup's
    // catch-up generates+posts, and then MP_FIRE_ON_START's test-fire
    // (`fireOnStart: true`) re-fires the SAME onTrigger for the SAME week
    // moments later. Before the fix, dev's `forceRegenerate: true` made that
    // second call bypass generateForWeek's idempotency gate and collide with
    // the row catch-up had just inserted (`UNIQUE constraint failed:
    // session.week_key`), which runDaemon's fireOnStart handler then surfaced
    // as a scary "Startup test-fire (fireOnStart) failed" #agent-alert even
    // though the week generated and posted successfully.
    const WEEK = "2026-07-12";
    const TRIGGER_INSTANT = "2026-07-12T11:00:00.000Z"; // 06:00 America/Chicago (CDT)

    function fakeProfile(
      overrides: Partial<ProfileSettings> = {},
    ): ProfileSettings {
      return {
        profile: "dev",
        channelId: "C123",
        sqlitePath: ":memory:",
        forceRegenerate: true,
        postMode: "dry-run",
        ...overrides,
      };
    }

    it("a successful catch-up-then-fireOnStart boot posts once and never fires the misleading failure alert", async () => {
      const store = new SessionStore({ path: ":memory:" });
      const config = fakeConfig();
      const profile = fakeProfile();
      const post = vi.fn(async () => ({ ts: "dryrun-1" }));
      const buildPlan = vi.fn(async (weekKey: string) => ({
        week_key: weekKey,
        meals: [],
      }));
      const resumeQuietly = vi.fn(() => {});
      const alert = vi.fn(async () => {});
      const nowDate = () => new Date(TRIGGER_INSTANT);
      const nowIso = () => "2026-07-12T06:00:00.000Z";
      const proc = new FakeProcess();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const { onStartup, onTrigger } = composeDaemon({
        config,
        profile,
        store,
        buildPlan,
        post,
        alert,
        resumeQuietly,
        nowDate,
        nowIso,
      });

      const handle = await runDaemon({
        config,
        secrets: fakeSecrets(),
        onStartup,
        onTrigger,
        alert,
        fireOnStart: true,
        process: proc as unknown as NodeJS.Process,
        logger,
      });

      expect(post).toHaveBeenCalledTimes(1);
      expect(store.get(WEEK)?.status).toBe("suggested");
      // The genuine fix under test: no misleading failure alert/log.
      expect(alert).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();

      await handle.shutdown();
      store.close();
    });
  });
});
