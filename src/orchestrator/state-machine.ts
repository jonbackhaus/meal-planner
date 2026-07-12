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
 * `/mealplan-approved`) — they're encoded here for completeness (so the
 * table matches the ADR exactly) but nothing in v1.0 transitions into them.
 */

/**
 * The ADR 0002 state machine table, `from -> [allowed `to`s]`. `committed`
 * has a self-loop (re-issued approval / soft-commit, ADR 0002 "re-approve");
 * `failed` and `expired` are fully terminal (no outgoing edges).
 */
export const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  generating: ["suggested", "failed"],
  suggested: ["under_revision", "committed", "expired"],
  under_revision: ["committed", "expired"],
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
 */
export function transition(
  store: SessionStore,
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
