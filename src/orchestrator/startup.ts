import type { Session, SessionStore } from "./session-store.js";
import { transition } from "./state-machine.js";
import {
  currentPlanWeek,
  triggerMoment,
  type WeekKeyConfig,
} from "./week-key.js";

/**
 * `onStartup` — boot-time reconciliation of the current plan-week against
 * its session row (ADR 0002 D4 "startup catch-up", bd6.4). This is the
 * daemon's crash-recovery entry point: a reboot/crash near the Sunday
 * trigger must not silently skip the week, nor duplicate a Slack post.
 *
 * Three cases (+ sub-cases), per the ADR pseudocode:
 *  1. No row for the current week:
 *     - past the trigger  -> catch up now: `generateForWeek(wk, { force: false })`.
 *     - before the trigger -> do nothing; the in-process scheduler will fire
 *       at the trigger moment (E1, wiring is a later integration step).
 *  2. A "live" row (`suggested`/`under_revision`/`committed`) -> `resumeQuietly(row)`
 *     (reload working_plan/thread_ts; say NOTHING in-thread — bd6.5, injected).
 *  3. A stale `generating` row (died mid-flight) -> it may or may not have
 *     posted to Slack, and there is no way to tell from the row alone. We
 *     deliberately do NOT auto-repost and do NOT auto-generate (either could
 *     duplicate a post that already went out). Instead: alert a human ONCE
 *     (naming only the week_key -- never the working_plan/thread_ts, which
 *     could carry household prose) and transition the row to `failed` so a
 *     repeated restart does not re-alert. A rare manual re-run is the
 *     accepted price of the no-duplicate guarantee.
 *  4. A terminal row (`failed`/`expired`) is already resolved -> no action.
 *
 * Clock policy: `now()` is called exactly ONCE, up front, and that single
 * `Date` is reused for both `currentPlanWeek` and the `>= triggerMoment`
 * comparison. Calling `now()` twice would let the clock tick between the two
 * reads, risking the week_key and the trigger comparison disagreeing (a race
 * this module exists specifically to avoid).
 */

export interface OnStartupDeps {
  cfg: WeekKeyConfig;
  store: SessionStore;
  /** bd6.3, bound (deps already applied) — `generateForWeek(weekKey, opts)`. */
  generateForWeek: (
    weekKey: string,
    opts: { force?: boolean },
  ) => Promise<"generated" | "skipped">;
  /**
   * bd6.5, INJECTED — reloads working_plan/thread_ts and says nothing
   * in-thread. Its internals are out of scope here; onStartup only calls it.
   */
  resumeQuietly: (row: Session) => Promise<void> | void;
  /** E6 #agent-alerts, INJECTED. */
  alert: (message: string) => Promise<void>;
  /** Injected clock (a `Date`, since week-key's functions take a `Date`). */
  now: () => Date;
}

export async function onStartup(deps: OnStartupDeps): Promise<void> {
  const { cfg, store, generateForWeek, resumeQuietly, alert, now } = deps;

  // Computed ONCE and reused for both calls below -- see module doc.
  const n = now();
  const wk = currentPlanWeek(n, cfg);
  const row = store.get(wk);

  if (!row) {
    if (n.getTime() >= triggerMoment(wk, cfg).getTime()) {
      // Missed the trigger (e.g. the daemon was down at the time) -> catch
      // up now. `force: false` preserves generateForWeek's own idempotency
      // gate in case a row shows up between our `get` and this call.
      await generateForWeek(wk, { force: false });
    }
    // else: not yet time -- do nothing; the in-process scheduler will fire
    // at the trigger moment.
    return;
  }

  switch (row.status) {
    case "suggested":
    case "under_revision":
    case "committed":
      await resumeQuietly(row);
      return;
    case "generating":
      // Died mid-flight; may or may not have posted. No auto-repost, no
      // auto-generate -- alert a human and mark `failed` so restarts don't
      // re-alert. The message names only the week_key: never the
      // working_plan/thread_ts (could carry household prose).
      await alert(
        `generation for week ${wk} was interrupted; check #meal-plan, re-run manually if needed`,
      );
      transition(store, wk, "failed", {}, n.toISOString());
      return;
    case "failed":
    case "expired":
      // Already resolved -- no automatic action.
      return;
  }
}
