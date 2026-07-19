import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeError } from "./resume.js";
import type { Session, SessionStatus } from "./session-store.js";
import { SessionStore } from "./session-store.js";
import { onStartup } from "./startup.js";
import { triggerMoment, type WeekKeyConfig } from "./week-key.js";

/**
 * `triggerMoment` is partially mocked (default: real implementation, via
 * `importOriginal`) so a single test below can override its return value to
 * exercise onStartup's own "before the trigger" defensive branch. This is
 * necessary because that branch is UNREACHABLE via genuinely-consistent
 * `currentPlanWeek`/`triggerMoment` outputs: `currentPlanWeek` already
 * internally falls back to the previous week whenever `now` is before the
 * current week's trigger, and that previous week's own trigger (7 calendar
 * days earlier) has always already passed by the time `now` rolls around --
 * so `now() >= triggerMoment(currentPlanWeek(now, cfg), cfg)` is an
 * invariant of week-key.ts, always true (verified empirically over 200k
 * random instants). The pseudocode's "else: not yet time" branch is
 * defense-in-depth per the ADR spec; it's tested here by decoupling the two
 * calls for that one case only.
 */
vi.mock("./week-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./week-key.js")>();
  return { ...actual, triggerMoment: vi.fn(actual.triggerMoment) };
});

/**
 * ADR 0002 D4 startup catch-up (bd6.4) tests. `cfg`/dates mirror
 * week-key.test.ts: `America/Chicago` + `triggerTime: "06:00"`, 2026-07-12
 * (a real Sunday) as the anchor week. `now` is always injected as an
 * explicit `Date` (never `Date.now()`), and is computed ONCE per call inside
 * `onStartup` -- these tests pin the exact trigger-instant boundary to catch
 * a regression that reads `now()` twice (a race across the two comparisons).
 */

const cfg: WeekKeyConfig = {
  timezone: "America/Chicago",
  triggerTime: "06:00",
};

const WEEK = "2026-07-12";
// 2026-07-12T11:00:00.000Z = 06:00:00.000 America/Chicago (CDT) exactly --
// the trigger instant for WEEK, per week-key.test.ts.
const TRIGGER_INSTANT = "2026-07-12T11:00:00.000Z";

let store: SessionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeStore() {
  return new SessionStore({ path: ":memory:" });
}

function makeDeps(theStore: SessionStore, now: Date) {
  return {
    cfg,
    store: theStore,
    generateForWeek: vi.fn(
      async (_weekKey: string, _opts: { force?: boolean }) =>
        "generated" as const,
    ),
    resumeQuietly: vi.fn(async (_row: Session) => {}),
    alert: vi.fn(async (_message: string) => {}),
    now: vi.fn(() => now),
  };
}

function insertRow(
  theStore: SessionStore,
  status: SessionStatus,
  overrides: Partial<Session> = {},
) {
  theStore.insert({
    week_key: WEEK,
    status,
    created_at: "2026-07-12T05:00:00.000Z",
    updated_at: "2026-07-12T05:00:00.000Z",
    ...overrides,
  });
}

describe("onStartup", () => {
  describe("no row", () => {
    it("past the trigger: calls generateForWeek(wk, { force: false })", async () => {
      store = makeStore();
      const now = new Date(TRIGGER_INSTANT); // exactly at trigger -- inclusive
      const deps = makeDeps(store, now);

      await onStartup(deps);

      expect(deps.generateForWeek).toHaveBeenCalledTimes(1);
      expect(deps.generateForWeek).toHaveBeenCalledWith(WEEK, {
        force: false,
      });
      expect(deps.resumeQuietly).not.toHaveBeenCalled();
      expect(deps.alert).not.toHaveBeenCalled();
    });

    it("well past the trigger (mid-week): still calls generateForWeek for the active week", async () => {
      store = makeStore();
      const now = new Date("2026-07-14T17:00:00.000Z"); // Tuesday afternoon
      const deps = makeDeps(store, now);

      await onStartup(deps);

      expect(deps.generateForWeek).toHaveBeenCalledTimes(1);
      expect(deps.generateForWeek).toHaveBeenCalledWith(WEEK, {
        force: false,
      });
    });

    it("before the trigger: does NOTHING (no generate, no alert) -- the scheduler will handle it", async () => {
      store = makeStore();
      const now = new Date("2026-07-12T10:59:59.999Z"); // 1ms before trigger
      const deps = makeDeps(store, now);
      // Force the trigger comparison to read as "still in the future" for
      // this one call, purely to exercise onStartup's own defensive branch
      // in isolation (see the module-level vi.mock doc above -- real
      // week-key semantics can never produce this combination).
      const mockedTriggerMoment = vi.mocked(triggerMoment);
      mockedTriggerMoment.mockReturnValueOnce(new Date(now.getTime() + 1_000));

      await onStartup(deps);

      expect(deps.generateForWeek).not.toHaveBeenCalled();
      expect(deps.resumeQuietly).not.toHaveBeenCalled();
      expect(deps.alert).not.toHaveBeenCalled();
      // No row was created either -- catch-up left it entirely to the scheduler.
      expect(store.get("2026-07-05")).toBeNull();
    });

    it("uses the SAME now for both currentPlanWeek and the trigger comparison (single now() call)", async () => {
      store = makeStore();
      const now = new Date(TRIGGER_INSTANT);
      const deps = makeDeps(store, now);

      await onStartup(deps);

      // now() must be called exactly once -- calling it twice (once for
      // currentPlanWeek, once for the trigger check) risks the clock ticking
      // between the two reads and the week_key/trigger-comparison disagreeing.
      expect(deps.now).toHaveBeenCalledTimes(1);
    });
  });

  describe("live row", () => {
    it.each([
      "suggested",
      "under_revision",
      "committed",
    ] as const)("status %s: calls resumeQuietly(row), does not generate, does not alert", async (status) => {
      store = makeStore();
      insertRow(store, status, { thread_ts: "1.1" });
      const now = new Date("2026-07-13T17:00:00.000Z");
      const deps = makeDeps(store, now);

      await onStartup(deps);

      expect(deps.resumeQuietly).toHaveBeenCalledTimes(1);
      const [resumedRow] = deps.resumeQuietly.mock.calls[0];
      expect(resumedRow.week_key).toBe(WEEK);
      expect(resumedRow.status).toBe(status);
      expect(deps.generateForWeek).not.toHaveBeenCalled();
      expect(deps.alert).not.toHaveBeenCalled();
      // Status is untouched.
      expect(store.get(WEEK)?.status).toBe(status);
    });

    it("resumeQuietly throws (corrupt working_plan): boot CONTINUES, alerts, does not rethrow, does not mutate the row", async () => {
      store = makeStore();
      insertRow(store, "suggested", { thread_ts: "1.1" });
      const now = new Date("2026-07-13T17:00:00.000Z");
      const deps = makeDeps(store, now);
      // A row whose durable working_plan no longer parses (e.g. schema
      // evolution) -> resumeQuietly throws a (sanitized) ResumeError. Boot
      // must NOT crash-loop on it: alert + continue without an in-memory plan.
      const resumeError = new ResumeError(WEEK, "meals: Required");
      deps.resumeQuietly.mockImplementationOnce(() => {
        throw resumeError;
      });

      // Must resolve, never reject -- otherwise the throw propagates to
      // main() -> process.exit(1) -> launchd KeepAlive crash-boot loop.
      await expect(onStartup(deps)).resolves.toBeUndefined();

      // The (already-sanitized) ResumeError message is surfaced to a human.
      expect(deps.alert).toHaveBeenCalledTimes(1);
      const [message] = deps.alert.mock.calls[0];
      expect(message).toContain(resumeError.message);
      // Alert-only discipline: the row is left exactly as found (a human /
      // late-reply mapping still needs it); no regenerate.
      expect(deps.generateForWeek).not.toHaveBeenCalled();
      expect(store.get(WEEK)?.status).toBe("suggested");
    });
  });

  describe("stale generating row", () => {
    it("alerts ONCE naming only the week_key, transitions to failed, never auto-repost/auto-generate", async () => {
      store = makeStore();
      insertRow(store, "generating");
      const now = new Date("2026-07-13T17:00:00.000Z");
      const deps = makeDeps(store, now);

      await onStartup(deps);

      expect(deps.alert).toHaveBeenCalledTimes(1);
      const [message] = deps.alert.mock.calls[0];
      expect(message).toContain(WEEK);
      // No secret: never mentions a working plan / thread_ts / household prose.
      expect(message).not.toMatch(/working_plan|thread_ts/);

      expect(deps.generateForWeek).not.toHaveBeenCalled();
      expect(deps.resumeQuietly).not.toHaveBeenCalled();

      const row = store.get(WEEK);
      expect(row?.status).toBe("failed");
    });

    it("repeated restarts do not re-alert once the row is already failed", async () => {
      store = makeStore();
      insertRow(store, "generating");
      const now = new Date("2026-07-13T17:00:00.000Z");

      // First boot: interrupted generation -> alert + transition to failed.
      await onStartup(makeDeps(store, now));

      // Second boot (simulating a restart): row is now `failed` -- terminal,
      // no further action.
      const deps2 = makeDeps(store, now);
      await onStartup(deps2);

      expect(deps2.alert).not.toHaveBeenCalled();
      expect(deps2.generateForWeek).not.toHaveBeenCalled();
      expect(deps2.resumeQuietly).not.toHaveBeenCalled();
      expect(store.get(WEEK)?.status).toBe("failed");
    });
  });

  describe("terminal row", () => {
    it.each([
      "failed",
      "expired",
    ] as const)("status %s: no action at all (no generate/alert/resume/transition)", async (status) => {
      store = makeStore();
      insertRow(store, status);
      const now = new Date("2026-07-13T17:00:00.000Z");
      const deps = makeDeps(store, now);

      await onStartup(deps);

      expect(deps.generateForWeek).not.toHaveBeenCalled();
      expect(deps.resumeQuietly).not.toHaveBeenCalled();
      expect(deps.alert).not.toHaveBeenCalled();
      expect(store.get(WEEK)?.status).toBe(status);
    });
  });
});
