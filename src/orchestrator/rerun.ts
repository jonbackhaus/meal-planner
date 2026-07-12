import type { SessionStore } from "./session-store.js";

/**
 * `reRunWeek` / `parseReRunArgs` — the operator re-run affordance (ratified
 * decision meal-planner-2fh, bd meal-planner-bd6.6). When a week's row ends
 * up `failed` (a mid-flight crash `generateForWeek`/bd6.3 couldn't recover
 * from, surfaced by startup catch-up's bd6.4 alert), an operator manually
 * re-runs it: `re-run <week_key> [--force]`.
 *
 * This module is deliberately just the tested logic (`reRunWeek` +
 * `parseReRunArgs`) — wiring a CLI subcommand into the daemon's actual
 * argv/subcommand router is a LATER integration step, not this task. Keeping
 * this seam thin means that later step is a one-line call:
 * `reRunWeek(...parseReRunArgs(argv), deps)`.
 *
 * ## Why there are two different "force"s
 *
 * `generateForWeek(week_key, {force: true})` (generate.ts) bypasses ONLY its
 * OWN idempotency SKIP gate — it does not touch an existing row, so if one is
 * still there `store.insert` still throws on the PRIMARY KEY constraint. So
 * re-run must itself CLEAR the existing row (`store.delete`) before calling
 * `generateForWeek` with `force: true` — that's what "reuses the dev
 * force-regenerate path" means in the ratified decision.
 *
 * Separately, re-run's OWN `opts.force` guards something generate.ts's force
 * has nothing to do with: whether it's SAFE to regenerate at all. A
 * `suggested`/`under_revision`/`committed` row already has a real Slack
 * thread (`thread_ts`) from a prior successful post — blowing that row away
 * and regenerating would post a SECOND, duplicate message for the same week.
 * Only a `failed` row is safe to re-run unconditionally, because `failed`
 * (per generate.ts) is only ever reached when `post` never returned a `ts` —
 * there is no thread to duplicate. Re-running anything else requires the
 * operator to explicitly acknowledge the risk via re-run's `--force`.
 */

export interface ReRunWeekOpts {
  /**
   * Re-run's OWN force flag — distinct from `generateForWeek`'s. Overrides
   * the non-`failed`-row safety guard (see `ReRunRefusedError`), NOT the
   * idempotency gate (this function always passes `{force: true}` down to
   * `generateForWeek` regardless of this flag).
   */
  force?: boolean;
}

export interface ReRunWeekDeps {
  store: SessionStore;
  /** bd6.3's `generateForWeek`, bound by the caller. */
  generateForWeek: (
    weekKey: string,
    opts: { force?: boolean },
  ) => Promise<"generated" | "skipped">;
  /** Optional; not required for v1.0 re-run (no alert path exercised here). */
  alert?: (message: string) => Promise<void>;
}

/**
 * Thrown when `reRunWeek` refuses to re-run a week whose existing row is NOT
 * `failed` and the caller didn't pass `--force`. Re-running a `suggested`/
 * `under_revision`/`committed` week would regenerate and re-post a plan that
 * already has a real Slack thread, i.e. a duplicate post. Carries only the
 * `week_key` + current `status` (identifiers, never `working_plan` or any
 * household prose) — always safe to log or alert on.
 */
export class ReRunRefusedError extends Error {
  readonly weekKey: string;
  readonly status: string;

  constructor(weekKey: string, status: string) {
    super(
      `re-run refused for week ${weekKey}: existing row is "${status}", not "failed". ` +
        `Re-running a "${status}" week risks posting a duplicate Slack message for a ` +
        `plan that has already been posted. Pass --force to override and regenerate anyway.`,
    );
    this.name = "ReRunRefusedError";
    this.weekKey = weekKey;
    this.status = status;
  }
}

/**
 * Manually re-runs generation for `week_key` (ratified decision
 * meal-planner-2fh). Logic:
 *
 * 1. Read the existing row, if any.
 * 2. Refuse (`ReRunRefusedError`, no delete, no generate) if a row exists,
 *    it's NOT `failed`, and the operator didn't pass `opts.force` — see the
 *    module doc's "two forces" note for why.
 * 3. If a row exists (and step 2 didn't refuse), clear it via `store.delete`
 *    — the audit trail going forward is the fresh generation this call
 *    produces, not the stale/failed row it replaces.
 * 4. Call `generateForWeek(week_key, {force: true})`, reusing the exact same
 *    generation path (re-inserts `generating`, builds, posts, transitions to
 *    `suggested`) a normal trigger/catch-up run would use.
 *
 * A `week_key` with no existing row at all is always allowed (nothing to
 * refuse, nothing to delete) — re-running a week that was never generated is
 * harmless; it's just a first generation.
 */
export async function reRunWeek(
  week_key: string,
  opts: ReRunWeekOpts,
  deps: ReRunWeekDeps,
): Promise<"generated"> {
  const row = deps.store.get(week_key);

  if (row && row.status !== "failed" && !opts.force) {
    throw new ReRunRefusedError(week_key, row.status);
  }

  if (row) {
    deps.store.delete(week_key);
  }

  const result = await deps.generateForWeek(week_key, { force: true });
  if (result !== "generated") {
    // Unreachable in practice: generateForWeek only ever returns "skipped"
    // when ITS OWN idempotency gate fires (no row + !force), and this call
    // always passes force:true. Guarded explicitly (rather than cast)
    // so a future change to that invariant fails loudly here instead of
    // silently mislabeling a skip as a successful re-run.
    throw new Error(
      `reRunWeek: generateForWeek unexpectedly returned "${result}" for week ${week_key} despite force:true`,
    );
  }
  return result;
}

/** The typed shape `parseReRunArgs` produces from a re-run subcommand's argv. */
export interface ReRunArgs {
  week_key: string;
  force: boolean;
}

/**
 * Thrown by `parseReRunArgs` on missing/invalid argv. Message-only (no
 * identifiers to carry) — always safe to log.
 */
export class ReRunUsageError extends Error {
  constructor(message: string) {
    super(`usage: re-run <week_key> [--force] -- ${message}`);
    this.name = "ReRunUsageError";
  }
}

/**
 * Thin CLI arg parse for the re-run subcommand: `[<week_key>, --force?]` ->
 * `{week_key, force}`. Deliberately NOT wired into `src/index.ts` here — the
 * actual daemon CLI dispatch is a later integration step; this just provides
 * the tested parse so that integration is a one-line call.
 */
export function parseReRunArgs(argv: string[]): ReRunArgs {
  const [week_key, ...rest] = argv;
  if (week_key === undefined || week_key.startsWith("--")) {
    throw new ReRunUsageError("missing required <week_key> argument");
  }

  let force = false;
  for (const arg of rest) {
    if (arg === "--force") {
      force = true;
    } else {
      throw new ReRunUsageError(`unrecognized argument "${arg}"`);
    }
  }

  return { week_key, force };
}
