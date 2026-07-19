import type Database from "better-sqlite3";

/**
 * Forward-only schema versioning for the SESSION DB (ADR 0002, bd6.13), via
 * SQLite's `PRAGMA user_version`. The session DB is the permanent historical
 * record and the v3.0 `thread_ts -> week_key` reverse map (rows retained,
 * never cleaned up), and v2.0 (nullable `day`) / v3.0 (Todoist ids) plan
 * additive schema changes — so it needs a versioning + migration mechanism.
 *
 * The CURRENT `SessionStore.initSchema()` output is treated as BASELINE v1: a
 * fresh DB is stamped `user_version = 1` after `initSchema`. Real additive
 * migrations will each append an entry to {@link migrations} with `to >= 2`;
 * the list starts EMPTY — this ships the mechanism + baseline stamp, ready for
 * the first real migration (which lands with the v2.0 `day` work).
 */

export interface Migration {
  /**
   * The `user_version` this migration brings the DB TO. Must be `>= 2` (v1 is
   * the baseline stamp) and strictly greater than the previous entry's `to`.
   */
  to: number;
  /**
   * Applies the schema change. Runs INSIDE the same transaction as the
   * `user_version` bump, so a throw rolls both back together.
   */
  run(db: Database.Database): void;
}

/** Baseline schema version stamped on a fresh DB after `initSchema`. */
export const BASELINE_VERSION = 1;

/**
 * Ordered, forward-only migrations. EMPTY in v1.0 (baseline only). Append new
 * entries in ascending `to` order; never edit or reorder a shipped entry.
 */
export const migrations: readonly Migration[] = [];

/** The DB's current schema version (`PRAGMA user_version`). */
export function currentVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/** Migrations whose `to` exceeds the DB's current version, in list order. */
export function pendingMigrations(
  db: Database.Database,
  list: readonly Migration[] = migrations,
): readonly Migration[] {
  const current = currentVersion(db);
  return list.filter((m) => m.to > current);
}

/**
 * Stamps baseline v1 on a fresh DB, then applies each pending migration in
 * order. Each migration's `run` and its `user_version` bump execute in ONE
 * transaction, so a failing migration rolls back atomically (schema + version
 * together) and the DB is left at the last good version.
 *
 * Baseline stamp: a fresh (or legacy pre-versioning) DB reports
 * `user_version = 0` after `initSchema`; it is stamped to 1 ONLY when still 0,
 * so a DB already at any vN is never touched or downgraded.
 *
 * The optional `list` parameter exists for testing; production callers pass
 * only `db` and get the shipped {@link migrations}.
 */
export function runMigrations(
  db: Database.Database,
  list: readonly Migration[] = migrations,
): void {
  if (currentVersion(db) === 0) {
    db.pragma(`user_version = ${BASELINE_VERSION}`);
  }

  for (const migration of list) {
    if (migration.to <= currentVersion(db)) {
      continue;
    }
    const apply = db.transaction((m: Migration) => {
      m.run(db);
      db.pragma(`user_version = ${m.to}`);
    });
    apply(migration);
  }
}
