import type { Config } from "../config/config.js";
import type { ProfileSettings } from "../config/profile.js";
import type { CostMeter } from "../cost/cost-meter.js";
import type { Heartbeat } from "../daemon/heartbeat.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import {
  type AlertFn,
  type GenerateForWeekDeps,
  generateForWeek,
} from "./generate.js";
import type { Session, SessionStore } from "./session-store.js";
import { onStartup as onStartupFn } from "./startup.js";
import { currentPlanWeek } from "./week-key.js";

/**
 * Composition root for the daemon's two scheduler-facing hooks (bd
 * meal-planner-bd6.9). This is the PURE wiring step ADR 0002's
 * `generateForWeek`/`onStartup` were built for but never themselves called:
 * `main()` (`src/index.ts`) constructs the real I/O collaborators
 * (SessionStore, buildPlan, post, alert, resumeQuietly, clocks) and hands
 * them here; `composeDaemon` binds them into the exact shape `runDaemon`
 * (`src/daemon/daemon.js`) needs — `{ onStartup, onTrigger }` — using the
 * REAL `generateForWeek`/`onStartup` functions underneath. Nothing in this
 * module talks to SQLite, Slack, or an LLM directly; it only wires already-
 * built pieces together, which is exactly what makes it unit-testable with
 * fakes for the I/O edges and a real in-memory SessionStore (see
 * compose.test.ts) — testing this composition exercises the whole wiring
 * path, not just composeDaemon's own few lines.
 *
 * Clock policy: `nowDate`/`nowIso` are both injected (never `Date.now()` /
 * `new Date()` called directly here), matching every other orchestrator
 * module's convention — the daemon (ultimately `main()`) owns the clock.
 */

export interface ComposeDaemonDeps {
  config: Config;
  profile: ProfileSettings;
  store: SessionStore;
  /** The bound recipe-sync-and-select pipeline (E4) — ADR 0002's `buildPlan(wk)`. */
  buildPlan: (weekKey: string) => Promise<EnrichedWeekPlan>;
  /** The bound render+post (E5; dry-run in v1.0 — see `main()`'s `buildDryRunPost`). */
  post: (plan: EnrichedWeekPlan) => Promise<{ ts: string }>;
  /** The bound #agent-alerts notifier (E6; console placeholder in v1.0). */
  alert: AlertFn;
  /** bd6.5, injected — reconstitutes a live row on restart; says nothing in-thread. */
  resumeQuietly: (row: Session) => void;
  /** Injected clock (`Date`) — feeds `currentPlanWeek` (onTrigger) and `onStartup`'s own single `now()` read. */
  nowDate: () => Date;
  /** Injected clock (ISO string) — feeds `generateForWeek`'s timestamps. */
  nowIso: () => string;
  /**
   * Token/$ tracking across a run (SPEC §9.3, bd meal-planner-fkg.1),
   * threaded straight through into `generateForWeek`'s own `meter` dep — see
   * `main()` (`src/index.ts`), which constructs ONE `CostMeter` wrapping the
   * same `llm` instance `buildPlan` uses (via `meteredLlmClient`) and passes
   * it here. Optional: omitting it preserves the pre-fkg.1 behavior (cost
   * counters stay 0).
   */
  meter?: CostMeter;
  /**
   * External dead-man switch (bd meal-planner-fkg.8, SPEC §9.4). When present,
   * `onTrigger` pings `heartbeat.success()` after a genuine generation success
   * (the run resolved without throwing -- `"generated"` OR `"skipped"`, since
   * both prove the host is alive and the trigger fired) and `heartbeat.fail()`
   * on a caught generation failure. Best-effort and ADDITIVE: a Heartbeat never
   * throws (see `makeHeartbeat`), so it can neither break nor alter the existing
   * generate/alert flow. Optional: omitting it (the default) makes `onTrigger`
   * behave exactly as before -- no ping is ever made.
   */
  heartbeat?: Heartbeat;
}

export interface ComposedDaemon {
  onStartup: () => Promise<void>;
  onTrigger: () => Promise<void>;
}

/**
 * Builds the daemon's `{ onStartup, onTrigger }` from the REAL orchestrator
 * functions:
 *  - `onTrigger` computes the current plan-week from `nowDate()` (via
 *    `currentPlanWeek`) and calls `generateForWeek` with `force` set from
 *    `profile.forceRegenerate` (dev defaults to `true`, prod to `false` —
 *    see `resolveProfile`).
 *  - `onStartup` delegates entirely to ADR 0002's boot-time reconciliation
 *    (`onStartup` in `startup.ts`), passing it the SAME bound
 *    `generateForWeek` so its own "past the trigger, no row yet" catch-up
 *    path shares the identical idempotency gate `onTrigger` uses.
 *
 * Both hooks return `Promise<void>` (matching `RunDaemonOptions`'s
 * `OnStartupHook`/`OnTriggerHook` shapes) even though `generateForWeek`
 * itself resolves to `"generated" | "skipped"` — that result is intentionally
 * discarded here; a caller wanting it should call `generateForWeek` directly.
 */
export function composeDaemon(deps: ComposeDaemonDeps): ComposedDaemon {
  const {
    config,
    profile,
    store,
    buildPlan,
    post,
    alert,
    resumeQuietly,
    nowDate,
    nowIso,
    meter,
    heartbeat,
  } = deps;

  const genDeps: GenerateForWeekDeps = {
    store,
    buildPlan,
    post,
    alert,
    now: nowIso,
    meter,
  };

  const boundGenerate = (weekKey: string, opts: { force?: boolean }) =>
    generateForWeek(weekKey, opts, genDeps);

  // Tracks the week_key `onStartup` just RESOLVED this boot -- either by
  // catching up (generating, bd meal-planner-8o3) or by finding an
  // already-live row and calling `resumeQuietly` on it (bd meal-planner-4ke).
  // Dev's `fireOnStart` (MP_FIRE_ON_START=1, RUNBOOK §5/§8) reuses this SAME
  // `onTrigger` hook moments after `onStartup` runs (see `runDaemon`), for the
  // SAME `currentPlanWeek`. In dev, `profile.forceRegenerate` is true, so
  // without this guard that second call bypasses `generateForWeek`'s own
  // idempotency gate and collides with the pre-existing row (either just
  // inserted by catch-up, or already there from a prior boot and reloaded via
  // resumeQuietly) -- a real `UNIQUE constraint failed: session.week_key`
  // throw that `runDaemon` surfaces as a scary "Startup test-fire failed"
  // alert, even though the week is in a perfectly good state. Since the
  // test-fire is redundant once `onStartup` has already resolved the SAME
  // week (by either path), `onTrigger` neuters `force` for exactly that one
  // next call, letting `generateForWeek`'s UNCHANGED idempotency gate
  // (`!force && rowExists -> "skipped"`) handle it cleanly instead. One-shot:
  // cleared the moment it's read, so this affects only the very next
  // `onTrigger()` call -- a later genuine force+existing-row collision (a
  // manual re-triggerNow, the next Sunday's scheduled fire finding a stale
  // row, etc.) still throws exactly as before. This never touches
  // `generateForWeek`/rerun.ts's own force-overwrite contract, and it does
  // NOT arm on the stale-`generating` branch (`startup.ts`'s alert-once path
  // calls neither `generateForWeek` nor `resumeQuietly`), so that genuine
  // alert is unaffected.
  let resolvedThisBootWeek: string | null = null;

  async function onTrigger(): Promise<void> {
    const weekKey = currentPlanWeek(nowDate(), config);
    let force = profile.forceRegenerate;
    if (force && weekKey === resolvedThisBootWeek) {
      force = false;
    }
    resolvedThisBootWeek = null;

    try {
      await boundGenerate(weekKey, { force });
    } catch (e) {
      // Caught generation failure. Ping the external dead-man `<url>/fail`
      // sub-path for defense-in-depth visibility, then preserve the existing
      // behavior of letting the error propagate (generateForWeek already fired
      // the internal alert before rethrowing). The heartbeat never throws, so
      // this cannot mask or alter the original error.
      await heartbeat?.fail();
      throw e;
    }
    // Genuine success: the run resolved without throwing (`"generated"` OR
    // `"skipped"` -- both mean the host is alive and the trigger fired).
    await heartbeat?.success();
  }

  async function onStartup(): Promise<void> {
    await onStartupFn({
      cfg: config,
      store,
      // Records the resolved week (see resolvedThisBootWeek doc above)
      // BEFORE delegating to the real boundGenerate -- onStartupFn's own
      // catch-up branch is the only caller of this, and it may throw (which
      // onStartupFn itself already contains/logs); recording ahead of the
      // call is correct either way, since a thrown catch-up still leaves a
      // row behind that a same-week force fire would otherwise collide with.
      generateForWeek: (weekKey, opts) => {
        resolvedThisBootWeek = weekKey;
        return boundGenerate(weekKey, opts);
      },
      // Same arming as the catch-up branch above (bd meal-planner-4ke): an
      // already-live row resolved via resumeQuietly is just as much a
      // same-boot resolution of `row.week_key` as a catch-up generate is, and
      // must equally suppress the next same-week fireOnStart force-insert.
      resumeQuietly: (row) => {
        resolvedThisBootWeek = row.week_key;
        return resumeQuietly(row);
      },
      alert,
      now: nowDate,
    });
  }

  return { onStartup, onTrigger };
}
