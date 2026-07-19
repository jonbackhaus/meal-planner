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
   *
   * Typed as a plain `void` return position (not `Promise<void> | void`):
   * TypeScript's "return value ignored in void position" rule only applies
   * to a bare `void` target, not a union containing it, so the real
   * `resumeQuietly` (which returns `ActiveSession`) would NOT be assignable
   * here if this were a union. `=> void` stays forward-compatible with a
   * future async `resumeQuietly` too, since a function returning
   * `Promise<void>` is also assignable to `=> void`.
   */
  resumeQuietly: (row: Session) => void;
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
      //
      // CONTAIN a generateForWeek throw (bd6.12): generate.ts rethrows even
      // after it has alerted + marked the row `failed`, and a throw from
      // `store.insert` itself (disk full / SQLITE_BUSY) rethrows with no row
      // written at all. Left unguarded, that propagates out of onStartup ->
      // main() -> process.exit(1) -> launchd KeepAlive crash-boot loop,
      // re-running full sync/LLM spend (+ alert spam) every restart. It has
      // already alerted/recorded inside generateForWeek, so here we only log
      // and CONTINUE booting so the scheduler still starts. (Log-only, not a
      // second alert: the live-row branch below alerts because resumeQuietly
      // does NOT alert internally; catch-up does the opposite.)
      try {
        await generateForWeek(wk, { force: false });
      } catch (err) {
        console.error(
          `startup: catch-up generation for week ${wk} threw; continuing boot (scheduler still starts): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // else: not yet time -- do nothing; the in-process scheduler will fire
    // at the trigger moment.
    return;
  }

  switch (row.status) {
    case "suggested":
    case "under_revision":
    case "committed":
      // resumeQuietly throws `ResumeError` when the durable working_plan no
      // longer parses (schema evolution: a v2.0 `day` field, a rename, an
      // upgrade mid-week with a live row). Left unguarded, that throw would
      // propagate out of onStartup -> main() -> process.exit(1), and launchd
      // KeepAlive would crash-boot loop forever with the scheduler never
      // started and no alert. v1.0 does NOT consume the resumed value, so a
      // failed resume is recoverable: alert (the ResumeError message is
      // already sanitized -- only week_key + a zod-issue summary), then
      // CONTINUE booting without an in-memory plan so the scheduler still
      // starts. Alert-only discipline: the row is NOT mutated (a human /
      // late-reply mapping still needs it).
      try {
        await resumeQuietly(row);
      } catch (err) {
        await alert(
          `resume for week ${wk} failed at startup; continuing without an in-memory plan (scheduler still starts): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    case "generating":
      // Died mid-flight; may or may not have posted. No auto-repost, no
      // auto-generate -- alert a human and mark `failed` so restarts don't
      // re-alert. The message names only the week_key: never the
      // working_plan/thread_ts (could carry household prose).
      //
      // Transition FIRST, then alert (bd6.12): the old order alerted BEFORE an
      // undefended transition, so a store fault on the transition would crash
      // boot AFTER alerting -- and, with the row still `generating`, re-alert +
      // re-crash on every launchd restart (alert spam + crash loop, violating
      // alert-once). Marking `failed` first means the normal path can't
      // alert-then-crash. The transition is ALSO wrapped so even a persistent
      // store fault is contained: log + continue booting (scheduler still
      // starts). A fault leaves the row `generating` and MAY re-alert on a
      // later restart -- an accepted degraded mode; a crash loop is not.
      try {
        transition(store, wk, "failed", {}, n.toISOString());
      } catch (err) {
        console.error(
          `startup: marking interrupted week ${wk} as failed threw; continuing boot (scheduler still starts): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await alert(
        `generation for week ${wk} was interrupted; check #meal-plan, re-run manually if needed`,
      );
      return;
    case "failed":
    case "expired":
      // Already resolved -- no automatic action.
      return;
  }
}
