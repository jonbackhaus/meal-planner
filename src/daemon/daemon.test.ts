import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
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
    generationDollarCap: 2,
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
      fireOnStart: true,
      process: proc as unknown as NodeJS.Process,
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);

    await handle.shutdown();
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
      process: proc as unknown as NodeJS.Process,
      logger,
    });

    expect(logger.warn).not.toHaveBeenCalled();

    await handle.shutdown();
  });
});
