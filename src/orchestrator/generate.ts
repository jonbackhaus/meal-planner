import type { CostMeter } from "../cost/cost-meter.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import type { SessionStore } from "./session-store.js";
import { type TransitionPatch, transition } from "./state-machine.js";
import { previousPlanWeek } from "./week-key.js";

/**
 * `generateForWeek` — the orchestrator's crash-safety heart (ADR 0002 D2 +
 * "Core logic" pseudocode, bd meal-planner-bd6.3). This is E3's single entry
 * point: the scheduler's `onTrigger` (already built, wiring deferred) and
 * startup catch-up (bd6.4, not built yet) both call this, gated by the SAME
 * idempotency check.
 *
 * Deliberately OUT of scope here: startup catch-up (bd6.4), resume-quietly
 * (bd6.5), operator re-run / force-overwrite of an existing row (bd6.6), the
 * real Slack render+post (E5) and real #agent-alerts alert (E6) -- `post`
 * and `alert` are injected callbacks the caller binds to those, once built.
 */

/** The bound recipe-sync-and-select pipeline (E4) — ADR 0002's `buildPlan(wk)`. */
export type BuildPlanFn = (weekKey: string) => Promise<EnrichedWeekPlan>;

/** The bound Slack render+postMessage (E5, injected — not built yet). */
export type PostFn = (plan: EnrichedWeekPlan) => Promise<{ ts: string }>;

/** The bound #agent-alerts notifier (E6, injected — not built yet). */
export type AlertFn = (message: string) => Promise<void>;

/** ISO-string clock, injected so this module never calls `Date.now()` itself. */
export type NowFn = () => string;

export interface GenerateForWeekDeps {
  store: SessionStore;
  buildPlan: BuildPlanFn;
  post: PostFn;
  alert: AlertFn;
  now: NowFn;
  /**
   * Token/$ tracking across the run (SPEC §9.3, bd meal-planner-fkg.1).
   * Optional -- when omitted, `token_spend`/`cost_usd` stay at their default
   * 0 (pre-fkg.1 behavior, unchanged). When present, the SAME instance is
   * shared across runs (runs are sequential) and is `reset()` at the start
   * of this run, then its running totals are persisted onto whichever
   * status this run ends in (`suggested` or `failed`) -- a failed run still
   * spent tokens, and §9.3's caps (fkg.2, next) need that recorded too.
   */
  meter?: CostMeter;
}

/**
 * The `token_spend`/`cost_usd` fields to splice into a status-transition
 * patch, derived from `meter`'s running totals -- `{}` when there's no meter
 * (preserving the pre-fkg.1 behavior of leaving the counters at their
 * default 0). Pulled out once so every transition call site in this run
 * (the happy-path `suggested`, the retried `suggested`, and `failed`) stays
 * in sync with the SAME totals read at that moment.
 */
function spendPatch(meter: CostMeter | undefined): TransitionPatch {
  if (!meter) {
    return {};
  }
  const totals = meter.totals();
  return {
    token_spend: totals.inputTokens + totals.outputTokens,
    cost_usd: totals.costUsd,
  };
}

export interface GenerateForWeekOpts {
  /**
   * Bypasses ONLY the idempotency gate (step 1) — it does not touch an
   * existing row. If a row for `week_key` already exists, the subsequent
   * `store.insert` still hits the PRIMARY KEY constraint and throws (see
   * module doc below): under `force`, the clean delete/overwrite of an
   * existing row is bd6.6's (operator re-run) concern, not this function's.
   * `force` here means exactly one thing: "generate even though a row
   * already exists" is decided by the CALLER (bd6.6), not by silently
   * clobbering state here.
   */
  force?: boolean;
}

/**
 * Bounded retry budget for the post-succeeded-but-local-write-faltered path
 * (ADR 0002 "Core logic": `retry(() => updateSession(...))`). If every
 * attempt (the first, inside the `try`, plus these) still fails, the row is
 * deliberately left `generating` — never half-written to `suggested` — and
 * startup catch-up (bd6.4) is what resolves it later.
 */
const MAX_SUGGESTED_WRITE_RETRIES = 3;

/**
 * ADR 0002 "Expired (piggybacked on the next generation — no timer)": if the
 * prior plan-week is still `suggested`/`under_revision` when the NEXT week
 * generates, it was never committed — mark it `expired`. Purely a clean
 * record (D3's computed "active week" already makes the prior week
 * non-active regardless); a no-op if there's no prior row, or the prior row
 * is already terminal (`committed`/`failed`/`expired`).
 */
export function expirePriorIfUncommitted(
  weekKey: string,
  deps: Pick<GenerateForWeekDeps, "store" | "now">,
): void {
  const prior = deps.store.get(previousPlanWeek(weekKey));
  if (
    prior &&
    (prior.status === "suggested" || prior.status === "under_revision")
  ) {
    transition(deps.store, prior.week_key, "expired", {}, deps.now());
  }
}

/**
 * Generates the draft plan for `week_key`, exactly per ADR 0002's
 * "Generation (idempotency gate + write-before-post)" pseudocode:
 *
 * 1. Idempotency gate (`!opts.force && store.get(week_key)` exists -> skip).
 * 2. Expire the prior week if it was left uncommitted (piggyback, no timer).
 * 3. Insert the `generating` row BEFORE calling `post` — this ordering is
 *    the whole trick: a mid-flight crash leaves behind a stale `generating`
 *    row, which is the evidence startup catch-up (bd6.4) needs.
 * 4. `buildPlan` -> `post` (the irreversible side effect) -> transition to
 *    `suggested` (+ `thread_ts` + `working_plan`) AFTER `post` returns.
 * 5. On failure: if `post` never returned a `ts`, transition to `failed` +
 *    alert + rethrow. If `post` succeeded but the local write faltered,
 *    retry the `suggested` transition a bounded number of times. If the row
 *    ultimately reaches `suggested` (first attempt or a retry), this run is
 *    treated as a full success -- `"generated"` is returned, no alert, no
 *    rethrow -- because the row is now indistinguishable from the plain
 *    happy path, and a caller that saw a thrown error here could later
 *    force-regenerate an already-`suggested` (already-posted) row, causing a
 *    duplicate Slack post. Only when every retry is exhausted and the row is
 *    left `generating` does the original error propagate.
 */
export async function generateForWeek(
  week_key: string,
  opts: GenerateForWeekOpts,
  deps: GenerateForWeekDeps,
): Promise<"generated" | "skipped"> {
  if (!opts.force && deps.store.get(week_key) !== null) {
    return "skipped";
  }

  try {
    // Cosmetic (ADR 0002: "correctness doesn't depend on this -- activeness
    // is computed"). A store fault while expiring the PRIOR week must not
    // abort the CURRENT week's generation.
    expirePriorIfUncommitted(week_key, deps);
  } catch (e) {
    console.warn(
      `expirePriorIfUncommitted failed ahead of generating week ${week_key}: ${String(e)}`,
    );
  }

  const insertedAt = deps.now();
  deps.store.insert({
    week_key,
    status: "generating",
    created_at: insertedAt,
    updated_at: insertedAt,
  });

  // START of this run's cost tracking (SPEC §9.3): reset BEFORE buildPlan
  // makes any calls, so this run's persisted total is only ITS calls, never
  // a prior run's leftover spend. Runs are sequential (one generateForWeek
  // at a time), so a single shared meter reset here is correct.
  deps.meter?.reset();

  let ts: string | undefined;
  let plan: EnrichedWeekPlan | undefined;

  try {
    plan = await deps.buildPlan(week_key);
    const posted = await deps.post(plan);
    ts = posted.ts;
    transition(
      deps.store,
      week_key,
      "suggested",
      { thread_ts: ts, working_plan: plan, ...spendPatch(deps.meter) },
      deps.now(),
    );
  } catch (e) {
    if (ts === undefined) {
      // Nothing posted -- a clean failure. No Slack thread exists, so
      // there's nothing to reconcile: mark `failed` and alert a human.
      // (No secrets: the alert carries only the week_key + error message,
      // never the working plan or household prose.) The run may still have
      // spent tokens before the failure (e.g. buildPlan's selection call
      // succeeded, a later repair call/post failed) -- §9.3 cares about that
      // spend even though the run itself failed, so it's persisted here too.
      transition(
        deps.store,
        week_key,
        "failed",
        { ...spendPatch(deps.meter) },
        deps.now(),
      );
      await deps.alert(
        `generation for week ${week_key} failed before posting: ${String(e)}`,
      );
    } else {
      // `post` already succeeded (irreversible) but recording it locally
      // faltered. Retry a bounded number of times; if every attempt still
      // fails, deliberately LEAVE the row `generating` rather than risk a
      // half-written `suggested` row (missing thread_ts/working_plan would
      // be worse than a row startup catch-up can still detect and resolve).
      let succeeded = false;
      for (let attempt = 0; attempt < MAX_SUGGESTED_WRITE_RETRIES; attempt++) {
        try {
          transition(
            deps.store,
            week_key,
            "suggested",
            { thread_ts: ts, working_plan: plan, ...spendPatch(deps.meter) },
            deps.now(),
          );
          succeeded = true;
          break;
        } catch (retryErr) {
          // Silent-but-diagnosable: no secret (no working_plan), just enough
          // to see a recurring write fault in logs (bd6.4 catch-up cares).
          console.warn(
            `suggested-write retry ${attempt + 1}/${MAX_SUGGESTED_WRITE_RETRIES} failed for week ${week_key}: ${String(retryErr)}`,
          );
        }
      }
      if (succeeded) {
        // The row reached `suggested` after all -- this run is a full
        // success from the caller's perspective. Rethrowing here would make
        // a fully-successful generation look like a failure, risking a
        // later force-regenerate against an already-posted row (duplicate
        // Slack post). No alert either: nothing is actually wrong now.
        return "generated";
      }
    }
    throw e;
  }

  return "generated";
}
