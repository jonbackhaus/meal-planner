import type {
  SessionPatch,
  SessionStatus,
  SessionStore,
} from "./session-store.js";

/**
 * The state-machine transition table + guarded apply (ADR 0002 "State
 * machine"). `session-store.ts` is deliberately storage + CRUD only (see its
 * header) — it does not know which transitions are legal. This module is the
 * guard layered on top: `generateForWeek` (bd6.3) and later tasks (v3.0
 * revision/approval flows) call `transition()` rather than `store.update()`
 * directly whenever they're changing `status`, so an illegal edge throws
 * instead of silently corrupting the record.
 *
 * v1.0 (this repo) only ever DRIVES `(none)->generating`, `generating-
 * >suggested`, `generating->failed`, and `suggested->expired`. The
 * `under_revision`/`committed` edges are v3.0 (first inbound reply /
 * `/mp-approved`) — they're encoded here for completeness (so the
 * table matches the ADR exactly) but nothing in v1.0 transitions into them.
 *
 * `paused_cost` (ADR-0007 D6, SPEC §9.3, bd meal-planner-3e2.6) is a v3.0
 * addition, additive to the table below: `suggested`/`under_revision` ->
 * `paused_cost` on a revision cost-cap breach (src/cost/revision-cost-guard.ts),
 * and `paused_cost` -> `suggested` ONLY via that module's explicit operator
 * reset (never auto-resumed). `paused_cost` -> `committed` (ADR-0007 D7,
 * bd meal-planner-iu7.5, C4) is the one exception: approval always wins,
 * even on a paused thread, so `../todoist-commit/approval-handler.ts` drives
 * this edge through the normal `transition()` guard below rather than
 * bypassing it.
 */

/**
 * The ADR 0002 state machine table, `from -> [allowed `to`s]`. `committed`
 * has a self-loop (re-issued approval / soft-commit, ADR 0002 "re-approve");
 * `failed` and `expired` are fully terminal (no outgoing edges).
 */
export const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  generating: ["suggested", "failed"],
  suggested: ["under_revision", "paused_cost", "committed", "expired"],
  under_revision: ["paused_cost", "committed", "expired"],
  // Cleared via an explicit operator reset (ADR-0007 D6) back to
  // `suggested`, the normal resting state, never auto-resumed; OR via
  // `/mp-approved` straight to `committed` (ADR-0007 D7) -- approval
  // always wins, even on a paused thread.
  paused_cost: ["suggested", "committed"],
  committed: ["committed"],
  failed: [],
  expired: [],
};

/** Whether `from -> to` is a legal edge in the ADR 0002 table. */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Thrown by `transition()` when the requested `from -> to` edge isn't in
 * `ALLOWED_TRANSITIONS` (including the case where `week_key` has no row at
 * all, i.e. `from` is `null` — every real edge requires an existing row).
 * Carries `weekKey`/`from`/`to` (identifiers only, never the working plan or
 * any household prose) so callers can safely log/alert on it.
 */
export class IllegalTransitionError extends Error {
  readonly weekKey: string;
  readonly from: SessionStatus | null;
  readonly to: SessionStatus;

  constructor(weekKey: string, from: SessionStatus | null, to: SessionStatus) {
    super(
      `illegal transition for week ${weekKey}: ${from ?? "(no row)"} -> ${to}`,
    );
    this.name = "IllegalTransitionError";
    this.weekKey = weekKey;
    this.from = from;
    this.to = to;
  }
}

/** The mutable fields `transition()` may patch alongside the status change. */
export type TransitionPatch = Omit<SessionPatch, "status" | "updated_at">;

/**
 * Guarded status change: reads the current row, throws `IllegalTransitionError`
 * if `from -> to` isn't allowed (or there's no row at all), else applies
 * `store.update` with the new status + `patch` + `updatedAt` in one write.
 *
 * This is the guard `session-store.ts` deliberately left out (see its
 * `update()` doc) — every status-changing write in the orchestrator should
 * go through this, not `store.update()` directly.
 *
 * `store` is narrowed to `Pick<SessionStore, "get" | "update">` (rather than
 * the full `SessionStore`) so callers that only hold that narrower slice —
 * e.g. `src/cost/revision-cost-guard.ts`'s `RevisionCostGuardDeps`, matching
 * the same narrowing convention `revision-coordinator.ts`/`approval-
 * handler.ts` already use — can call this without widening their own deps to
 * the full store surface. A real `SessionStore` instance still satisfies this
 * structurally, so every existing caller is unaffected.
 */
export function transition(
  store: Pick<SessionStore, "get" | "update">,
  week_key: string,
  to: SessionStatus,
  patch: TransitionPatch,
  updatedAt: string,
): void {
  const current = store.get(week_key);
  if (!current) {
    throw new IllegalTransitionError(week_key, null, to);
  }
  if (!canTransition(current.status, to)) {
    throw new IllegalTransitionError(week_key, current.status, to);
  }
  store.update(week_key, { ...patch, status: to, updated_at: updatedAt });
}
