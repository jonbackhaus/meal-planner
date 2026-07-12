import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import type { ProfileSettings } from "../config/profile.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import { composeDaemon } from "./compose.js";
import type { Session } from "./session-store.js";
import { SessionStore } from "./session-store.js";

/**
 * `composeDaemon` (bd meal-planner-bd6.9) is a PURE factory wiring the REAL
 * `generateForWeek`/`onStartup` into `{ onStartup, onTrigger }` — so testing
 * it here (with fakes only for the injected I/O edges: buildPlan/post/
 * alert/resumeQuietly/clocks, plus a REAL in-memory SessionStore) exercises
 * the whole composition, not just composeDaemon's own few lines.
 *
 * `cfg`/dates mirror week-key.test.ts / startup.test.ts:
 * America/Chicago + triggerTime "06:00", 2026-07-12 (a real Sunday) as the
 * anchor week's trigger instant.
 */

const WEEK = "2026-07-12";
const TRIGGER_INSTANT = "2026-07-12T11:00:00.000Z"; // 06:00 America/Chicago (CDT)

function makeConfig(): Config {
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

function makeProfile(
  overrides: Partial<ProfileSettings> = {},
): ProfileSettings {
  return {
    profile: "dev",
    channelId: "C123",
    sqlitePath: ":memory:",
    forceRegenerate: false,
    postMode: "dry-run",
    ...overrides,
  };
}

function makePlan(weekKey: string): EnrichedWeekPlan {
  return { week_key: weekKey, meals: [] };
}

let store: SessionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeStore() {
  return new SessionStore({ path: ":memory:" });
}

describe("composeDaemon", () => {
  describe("onTrigger", () => {
    it("generates the current week, calling post once and leaving the row `suggested` with the synthetic ts", async () => {
      store = makeStore();
      const config = makeConfig();
      const profile = makeProfile({ forceRegenerate: false });
      const builtPlan = makePlan(WEEK);
      const buildPlan = vi.fn(async () => builtPlan);
      const post = vi.fn(async (_plan: EnrichedWeekPlan) => ({
        ts: "dryrun-1",
      }));
      const alert = vi.fn(async (_message: string) => {});
      const resumeQuietly = vi.fn((_row: Session) => {});
      const nowDate = () => new Date(TRIGGER_INSTANT);
      const nowIso = () => "2026-07-12T06:00:00.000Z";

      const { onTrigger } = composeDaemon({
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

      await onTrigger();

      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(builtPlan);
      const row = store.get(WEEK);
      expect(row?.status).toBe("suggested");
      expect(row?.thread_ts).toBe("dryrun-1");
      expect(alert).not.toHaveBeenCalled();
    });

    it("passes profile.forceRegenerate through to generateForWeek's force option", async () => {
      store = makeStore();
      // Pre-existing row for the current week -- without force, generateForWeek
      // would skip (and post would never be called).
      store.insert({
        week_key: WEEK,
        status: "failed",
        created_at: "2026-07-05T06:00:00.000Z",
        updated_at: "2026-07-05T06:00:00.000Z",
      });
      const config = makeConfig();
      const profile = makeProfile({ forceRegenerate: true });
      const buildPlan = vi.fn(async () => makePlan(WEEK));
      const post = vi.fn(async () => ({ ts: "dryrun-1" }));
      const alert = vi.fn(async () => {});
      const resumeQuietly = vi.fn((_row: Session) => {});
      const nowDate = () => new Date(TRIGGER_INSTANT);
      const nowIso = () => "2026-07-12T06:00:00.000Z";

      const { onTrigger } = composeDaemon({
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

      // force:true bypasses the idempotency GATE, but the store still has a
      // pre-existing row for WEEK, so the subsequent insert hits the PK
      // constraint (generateForWeek's own documented behavior, see
      // generate.test.ts) -- this still proves `force` was passed through
      // (a `false` force would have produced a silent "skipped" with
      // buildPlan/post never called at all, not a thrown PK error).
      await expect(onTrigger()).rejects.toThrow();
      expect(buildPlan).not.toHaveBeenCalled();
    });

    it("without force, an existing row for the current week is skipped (post never called)", async () => {
      store = makeStore();
      store.insert({
        week_key: WEEK,
        status: "suggested",
        thread_ts: "old.ts",
        created_at: "2026-07-05T06:00:00.000Z",
        updated_at: "2026-07-05T06:00:00.000Z",
      });
      const config = makeConfig();
      const profile = makeProfile({ forceRegenerate: false });
      const buildPlan = vi.fn(async () => makePlan(WEEK));
      const post = vi.fn(async () => ({ ts: "dryrun-1" }));
      const alert = vi.fn(async () => {});
      const resumeQuietly = vi.fn((_row: Session) => {});
      const nowDate = () => new Date(TRIGGER_INSTANT);
      const nowIso = () => "2026-07-12T06:00:00.000Z";

      const { onTrigger } = composeDaemon({
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

      await onTrigger();

      expect(buildPlan).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("onStartup", () => {
    it("empty store, past the trigger: catches up (generates), calling post once", async () => {
      store = makeStore();
      const config = makeConfig();
      const profile = makeProfile();
      const builtPlan = makePlan(WEEK);
      const buildPlan = vi.fn(async () => builtPlan);
      const post = vi.fn(async () => ({ ts: "dryrun-1" }));
      const alert = vi.fn(async () => {});
      const resumeQuietly = vi.fn((_row: Session) => {});
      const nowDate = () => new Date(TRIGGER_INSTANT);
      const nowIso = () => "2026-07-12T06:00:00.000Z";

      const { onStartup } = composeDaemon({
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

      await onStartup();

      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(builtPlan);
      expect(store.get(WEEK)?.status).toBe("suggested");
      expect(resumeQuietly).not.toHaveBeenCalled();
    });

    it("a live `suggested` row: calls resumeQuietly, does not post or regenerate", async () => {
      store = makeStore();
      store.insert({
        week_key: WEEK,
        status: "suggested",
        thread_ts: "1.1",
        created_at: "2026-07-12T05:00:00.000Z",
        updated_at: "2026-07-12T05:00:00.000Z",
      });
      const config = makeConfig();
      const profile = makeProfile();
      const buildPlan = vi.fn(async () => makePlan(WEEK));
      const post = vi.fn(async () => ({ ts: "dryrun-1" }));
      const alert = vi.fn(async () => {});
      const resumeQuietly = vi.fn((_row: Session) => {});
      const nowDate = () => new Date("2026-07-13T17:00:00.000Z");
      const nowIso = () => "2026-07-13T17:00:00.000Z";

      const { onStartup } = composeDaemon({
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

      await onStartup();

      expect(resumeQuietly).toHaveBeenCalledTimes(1);
      const [resumedRow] = resumeQuietly.mock.calls[0];
      expect(resumedRow.week_key).toBe(WEEK);
      expect(buildPlan).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
    });

    it("a stale `generating` row: alerts once, transitions to failed, never posts", async () => {
      store = makeStore();
      store.insert({
        week_key: WEEK,
        status: "generating",
        created_at: "2026-07-12T05:00:00.000Z",
        updated_at: "2026-07-12T05:00:00.000Z",
      });
      const config = makeConfig();
      const profile = makeProfile();
      const buildPlan = vi.fn(async () => makePlan(WEEK));
      const post = vi.fn(async () => ({ ts: "dryrun-1" }));
      const alert = vi.fn(async () => {});
      const resumeQuietly = vi.fn((_row: Session) => {});
      const nowDate = () => new Date("2026-07-13T17:00:00.000Z");
      const nowIso = () => "2026-07-13T17:00:00.000Z";

      const { onStartup } = composeDaemon({
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

      await onStartup();

      expect(alert).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
      expect(store.get(WEEK)?.status).toBe("failed");
    });
  });
});
