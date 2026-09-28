import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BootFailureState,
  DEFAULT_ALERT_COOLDOWN_MS,
  DEFAULT_RESET_WINDOW_MS,
  handleBootFailure,
  planBootFailureResponse,
  readBootFailureState,
  writeBootFailureState,
} from "./boot-failure-guard.js";

describe("planBootFailureResponse", () => {
  it("treats a first-ever failure (no previous state) as a fresh streak that alerts", () => {
    const now = new Date("2026-09-28T10:00:00.000Z");

    const plan = planBootFailureResponse(undefined, now);

    expect(plan.nextState.consecutiveFailures).toBe(1);
    expect(plan.shouldAlert).toBe(true);
    expect(plan.nextState.lastAlertAt).toBe(now.toISOString());
  });

  it("increments the streak and skips re-alerting for a second failure shortly after the first (within cooldown)", () => {
    const first = new Date("2026-09-28T10:00:00.000Z");
    const firstPlan = planBootFailureResponse(undefined, first);

    const second = new Date(first.getTime() + 5_000); // 5s later -- rapid crash loop
    const secondPlan = planBootFailureResponse(firstPlan.nextState, second);

    expect(secondPlan.nextState.consecutiveFailures).toBe(2);
    expect(secondPlan.shouldAlert).toBe(false);
    // lastAlertAt carries forward from the first (deduped) alert, not bumped.
    expect(secondPlan.nextState.lastAlertAt).toBe(first.toISOString());
  });

  it("re-alerts once the alert cooldown has elapsed, even mid-streak", () => {
    const first = new Date("2026-09-28T10:00:00.000Z");
    const firstPlan = planBootFailureResponse(undefined, first);

    const later = new Date(first.getTime() + DEFAULT_ALERT_COOLDOWN_MS + 1);
    const laterPlan = planBootFailureResponse(firstPlan.nextState, later);

    expect(laterPlan.shouldAlert).toBe(true);
    expect(laterPlan.nextState.lastAlertAt).toBe(later.toISOString());
  });

  it("resets the streak (and alerts again) once the reset window has elapsed since the last failure", () => {
    const first = new Date("2026-09-28T10:00:00.000Z");
    const firstPlan = planBootFailureResponse(undefined, first);

    const muchLater = new Date(first.getTime() + DEFAULT_RESET_WINDOW_MS + 1);
    const laterPlan = planBootFailureResponse(firstPlan.nextState, muchLater);

    expect(laterPlan.nextState.consecutiveFailures).toBe(1);
    expect(laterPlan.shouldAlert).toBe(true);
  });

  it("grows the in-process backoff exponentially with the streak length, capped at maxBackoffMs", () => {
    let state: BootFailureState | undefined;
    let now = new Date("2026-09-28T10:00:00.000Z");
    const options = { baseBackoffMs: 1_000, maxBackoffMs: 10_000 };

    const backoffs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const plan = planBootFailureResponse(state, now, options);
      backoffs.push(plan.backoffMs);
      state = plan.nextState;
      now = new Date(now.getTime() + 100); // stay well within the reset window
    }

    expect(backoffs).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });
});

describe("readBootFailureState / writeBootFailureState", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("round-trips a written state", () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-boot-failure-"));
    const statePath = join(dir, "nested", "boot-failure-state.json");
    const state: BootFailureState = {
      consecutiveFailures: 3,
      lastFailureAt: "2026-09-28T10:00:00.000Z",
      lastAlertAt: "2026-09-28T10:00:00.000Z",
    };

    writeBootFailureState(statePath, state);

    expect(readBootFailureState(statePath)).toEqual(state);
  });

  it("returns undefined for a missing file", () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-boot-failure-"));
    expect(
      readBootFailureState(join(dir, "does-not-exist.json")),
    ).toBeUndefined();
  });

  it("returns undefined for a corrupt file rather than throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-boot-failure-"));
    const statePath = join(dir, "corrupt.json");
    writeFileSync(statePath, "not json", "utf8");

    expect(readBootFailureState(statePath)).toBeUndefined();
  });
});

describe("handleBootFailure", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("logs the failure, persists state, and exits(1) even with no alert transport (the loadSecrets-timeout scenario)", async () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-boot-failure-"));
    const logPath = join(dir, "meal-planner.log");
    const statePath = join(dir, "boot-failure-state.json");
    const exit = vi.fn();
    const sleep = vi.fn(async () => {});
    const now = () => new Date("2026-09-28T10:00:00.000Z");

    await handleBootFailure(
      new Error("Timed out loading secrets after 15000ms"),
      { logPath, statePath, now, sleep, exit },
    );

    const logContents = readFileSync(logPath, "utf8");
    expect(logContents).toContain("Timed out loading secrets");
    expect(logContents).toContain("[boot-failure-alert]");
    expect(readBootFailureState(statePath)?.consecutiveFailures).toBe(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not re-escalate (no second [boot-failure-alert] line) on a rapid second failure, but still logs and exits", async () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-boot-failure-"));
    const logPath = join(dir, "meal-planner.log");
    const statePath = join(dir, "boot-failure-state.json");
    const exit = vi.fn();
    const sleep = vi.fn(async () => {});

    await handleBootFailure(new Error("boom 1"), {
      logPath,
      statePath,
      now: () => new Date("2026-09-28T10:00:00.000Z"),
      sleep,
      exit,
    });
    await handleBootFailure(new Error("boom 2"), {
      logPath,
      statePath,
      now: () => new Date("2026-09-28T10:00:05.000Z"), // 5s later
      sleep,
      exit,
    });

    const logLines = readFileSync(logPath, "utf8").trim().split("\n");
    const alertLines = logLines.filter((l) =>
      l.includes("[boot-failure-alert]"),
    );
    expect(alertLines).toHaveLength(1);
    expect(logLines.some((l) => l.includes("boom 2"))).toBe(true);
    expect(readBootFailureState(statePath)?.consecutiveFailures).toBe(2);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
  });

  it("attempts the injected alert transport when provided, and never throws when it rejects", async () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-boot-failure-"));
    const logPath = join(dir, "meal-planner.log");
    const statePath = join(dir, "boot-failure-state.json");
    const exit = vi.fn();
    const alert = vi.fn(async () => {
      throw new Error("Slack transport down");
    });

    await expect(
      handleBootFailure(new Error("boom"), {
        logPath,
        statePath,
        now: () => new Date("2026-09-28T10:00:00.000Z"),
        sleep: async () => {},
        exit,
        alert,
      }),
    ).resolves.toBeUndefined();

    expect(alert).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("never throws and still exits(1) when the state file is unwritable", async () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-boot-failure-"));
    const logPath = join(dir, "meal-planner.log");
    // Point statePath at a path whose parent is a FILE, not a directory, so
    // mkdirSync(dirname(...)) fails.
    const blockerFile = join(dir, "blocker");
    writeFileSync(blockerFile, "x", "utf8");
    const statePath = join(blockerFile, "nested", "state.json");
    const exit = vi.fn();
    const logger = { error: vi.fn() };

    await expect(
      handleBootFailure(new Error("boom"), {
        logPath,
        statePath,
        now: () => new Date("2026-09-28T10:00:00.000Z"),
        sleep: async () => {},
        exit,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("state write failed"),
    );
  });
});
