import type { RevisionHandler } from "../slack/inbound-router.js";
import type { RevisionResult } from "./revision.js";
import type { SessionStore } from "./session-store.js";

/**
 * B4 (bd meal-planner-3e2.5, ADR 0007 D4): single-writer serialization on the
 * session row, the `under_revision` transition (ADR 0002), and the supersede
 * signal that lets `/mp-approve` win over an in-flight revision.
 *
 * Two composable pieces, both keyed by `week_key` (== session id):
 *
 *  - `RevisionCoordinator` -- a tiny per-key mutex (`runExclusive`, so two
 *    revision operations on the SAME session never interleave; different
 *    sessions run fully independently) plus a per-key "superseded" flag an
 *    approval sets (`supersede`) and a revision checks (`isSuperseded`).
 *  - `serializeRevisionHandler` -- wraps a downstream `RevisionHandler` (the
 *    SAME A4 seam B1's `createRevisionHandler`, `./revision.js`, and B3's
 *    `createDebouncedRevisionHandler`, `./revision-debounce.js`, implement)
 *    so each `onReply` runs exclusively per week_key and drives the session
 *    row's `status` to `under_revision` for the duration, back to `suggested`
 *    once it settles (ADR 0002's `suggested <-> under_revision` transition) --
 *    skipped entirely once the week has been superseded.
 *  - `guardOnRevised` -- wraps the `onRevised` callback (`RevisionHandlerDeps
 *    .onRevised`, `./revision.js`; the real implementation is B2's
 *    `createRevisionPostHandler`, `./revision-post.js`) so the session row's
 *    `working_plan` write-back -- explicitly left to B4 by both B1 and B2's
 *    doc comments -- only happens if the week has NOT been superseded by an
 *    approval that landed while the mutation/validate/post pipeline was
 *    in flight. A late revision result that lands after supersede is
 *    dropped, never overwriting the plan approval already committed.
 *
 * NOT wired into `index.ts` here -- composing these around B1/B2/B3's output
 * (and calling `RevisionCoordinator.supersede` from the Todoist approval
 * handler, `../todoist-commit/approval-handler.js`) is the boot-assembly
 * task, bd meal-planner-uo1. This module only builds and exports the
 * primitives.
 */

/**
 * Per-`week_key` mutex + supersede flag. Deliberately in-memory (mirrors
 * `revision-debounce.ts`'s own in-memory burst map) -- both are per-process
 * coordination state for a single resident daemon, not durable facts; the
 * durable fact this drives (session `status`) IS persisted, via
 * `serializeRevisionHandler`/`guardOnRevised` below.
 */
export interface RevisionCoordinator {
  /** True once `supersede(weekKey)` has been called for this week -- permanent for the life of the process (a week's session never un-supersedes). */
  isSuperseded(weekKey: string): boolean;
  /** Marks `weekKey` superseded (ADR 0007 D4: approval wins). Idempotent -- safe to call more than once, e.g. on a soft-commit re-approval. */
  supersede(weekKey: string): void;
  /**
   * Runs `fn` exclusively for `weekKey`: if another `runExclusive` call for
   * the SAME `weekKey` is still pending, this one queues behind it (FIFO);
   * a different `weekKey` runs immediately, in parallel. A queued call runs
   * regardless of whether the one ahead of it in the same queue resolved or
   * rejected (one bad revision must not wedge the next).
   */
  runExclusive<T>(weekKey: string, fn: () => Promise<T>): Promise<T>;
}

export function createRevisionCoordinator(): RevisionCoordinator {
  const superseded = new Set<string>();
  const queues = new Map<string, Promise<void>>();

  return {
    isSuperseded(weekKey: string): boolean {
      return superseded.has(weekKey);
    },
    supersede(weekKey: string): void {
      superseded.add(weekKey);
    },
    runExclusive<T>(weekKey: string, fn: () => Promise<T>): Promise<T> {
      const prior = queues.get(weekKey) ?? Promise.resolve();
      // Wait for whatever's ahead of us in this key's queue to SETTLE
      // (success or failure -- `.catch(() => {})` swallows a prior
      // rejection so it can't wedge this or later calls), then run `fn`.
      const started = prior.catch(() => {}).then(() => fn());
      // What the NEXT call for this key chains onto -- always a
      // resolved-shaped promise, so a rejection from `fn` here doesn't
      // propagate into the queue itself (the caller of THIS `runExclusive`
      // still sees `started`'s real rejection via the returned promise).
      queues.set(
        weekKey,
        started.then(
          () => undefined,
          () => undefined,
        ),
      );
      return started;
    },
  };
}

export interface RevisionSerializerDeps {
  /** Only the two methods this wrapper needs -- keeps it decoupled from the full `SessionStore` surface (matches `revision.ts`/`approval-handler.ts`'s own narrowing convention). */
  sessionStore: Pick<SessionStore, "get" | "update">;
  coordinator: RevisionCoordinator;
  /** Injected clock for `SessionStore.update`'s `updated_at`; defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Wraps a downstream `RevisionHandler` so each `onReply` for a given
 * `weekKey`:
 *
 *  1. Runs exclusively for that `weekKey` (`RevisionCoordinator.runExclusive`)
 *     -- a second reply for the same week queues behind the first instead of
 *     racing it; a reply for a different week runs independently.
 *  2. Is skipped entirely (never reaches `downstream.onReply`) if the week
 *     was already superseded by an approval (ADR 0007 D4).
 *  3. Drives the session row `suggested -> under_revision` (ADR 0002) before
 *     calling downstream, then `under_revision -> suggested` after it
 *     settles -- UNLESS the week was superseded while downstream ran, in
 *     which case the approval path already owns the row's resting state and
 *     this leaves it alone.
 *
 * Never throws out of `onReply`: mirrors `createRevisionHandler`'s /
 * `createDebouncedRevisionHandler`'s own "never let one bad message wedge
 * the listener" contract -- a downstream failure is swallowed here (the
 * `finally` below still restores `status`), not propagated to the router.
 */
export function serializeRevisionHandler(
  downstream: RevisionHandler,
  deps: RevisionSerializerDeps,
): RevisionHandler {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());

  return {
    onReply(reply): Promise<void> {
      return deps.coordinator.runExclusive(reply.weekKey, async () => {
        if (deps.coordinator.isSuperseded(reply.weekKey)) {
          logger.log(
            `[revision-coordinator] week ${reply.weekKey} already superseded by approval; skipping revision`,
          );
          return;
        }

        const before = deps.sessionStore.get(reply.weekKey);
        if (before?.status === "suggested") {
          deps.sessionStore.update(reply.weekKey, {
            status: "under_revision",
            updated_at: now().toISOString(),
          });
        }

        try {
          await downstream.onReply(reply);
        } catch (err) {
          logger.error(
            `[revision-coordinator] downstream onReply failed for week ${reply.weekKey}: ${String(err)}`,
          );
        } finally {
          if (!deps.coordinator.isSuperseded(reply.weekKey)) {
            const after = deps.sessionStore.get(reply.weekKey);
            if (after?.status === "under_revision") {
              deps.sessionStore.update(reply.weekKey, {
                status: "suggested",
                updated_at: now().toISOString(),
              });
            }
          }
        }
      });
    },
  };
}

export interface OnRevisedGuardDeps {
  /** Only the write this wrapper needs -- keeps it decoupled from the full `SessionStore` surface. */
  sessionStore: Pick<SessionStore, "update">;
  coordinator: RevisionCoordinator;
  /** Injected clock for `SessionStore.update`'s `updated_at`; defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Wraps `RevisionHandlerDeps.onRevised` (`./revision.js`; the real
 * implementation is B2's `createRevisionPostHandler`, `./revision-post.js`,
 * which validates + re-posts but -- by design, see both modules' doc
 * comments -- never touches `SessionStore`) so the session row's
 * `working_plan` write-back happens HERE, guarded by the supersede signal on
 * both sides of the (async, validate-then-post) downstream call:
 *
 *  - Superseded BEFORE downstream runs -> drop the result entirely, never
 *    validate/post it (the approval already committed the row's plan; a
 *    replaced-out revision has nothing useful to say).
 *  - Superseded WHILE downstream runs (the exact ADR 0007 D4 race: approval
 *    lands mid-validate/mid-post) -> still let the in-flight post finish
 *    (it's already an irreversible Slack side effect, same append-only
 *    rationale as ADR 0007 D2), but do NOT write `working_plan` back onto
 *    the row -- the late result must not overwrite what approval committed.
 *  - Not superseded either time -> write `working_plan` back onto the row,
 *    the normal case.
 *
 * Also snapshots `last_posted_plan` alongside `working_plan` (bd
 * meal-planner-2b2, RATIFIED design, `/mp-reset`): this is the "each revision
 * re-post" checkpoint the ratified design calls for -- `downstream` (B2's
 * `createRevisionPostHandler`, `./revision-post.ts`) only reaches this point
 * after `postRevisionReply` has ALREADY succeeded, so a write here is by
 * definition a successful post.
 */
export function guardOnRevised(
  downstream: (result: RevisionResult) => Promise<void> | void,
  deps: OnRevisedGuardDeps,
): (result: RevisionResult) => Promise<void> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());

  return async (result: RevisionResult): Promise<void> => {
    if (deps.coordinator.isSuperseded(result.weekKey)) {
      logger.log(
        `[revision-coordinator] week ${result.weekKey} superseded before posting; dropping revision result`,
      );
      return;
    }

    await downstream(result);

    if (deps.coordinator.isSuperseded(result.weekKey)) {
      logger.log(
        `[revision-coordinator] week ${result.weekKey} superseded while posting; NOT overwriting the committed working_plan`,
      );
      return;
    }

    deps.sessionStore.update(result.weekKey, {
      working_plan: result.revisedPlan,
      last_posted_plan: result.revisedPlan,
      updated_at: now().toISOString(),
    });
  };
}
