import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { preMigrationBackup, rollingBootBackup } from "./backup.js";
import { pendingMigrations } from "./migrations.js";

/**
 * Boot-time backup orchestration for the session DB (bd6.13), run in `main()`
 * BEFORE `new SessionStore(...)` (whose constructor runs `runMigrations`). Two
 * triggers, per ADR 0002:
 *
 *  1. ROLLING boot copy — BEST-EFFORT: a backup failure must NOT crash boot,
 *     so it is logged and swallowed (the daemon keeps booting). Retention =
 *     keep the last 8 boot copies.
 *  2. MANDATORY pre-migration copy — taken only when a REAL migration is
 *     pending. If it fails, the error PROPAGATES and boot aborts *before* the
 *     constructor migrates, so a destructive migration never runs without a
 *     snapshot.
 *
 * v1.0 note: the `migrations` list is empty, so `pendingMigrations` returns
 * nothing and the pre-migration branch is dormant. v1's only "migration" is
 * the non-destructive baseline `user_version` stamp, which transforms no data;
 * the rolling copy above already snapshots the pre-stamp DB. When the first
 * DESTRUCTIVE migration lands (v2.0 `day`), it will register in `migrations`
 * and this pre-migration gate activates automatically.
 *
 * On first boot the DB file does not exist yet — nothing to back up — so this
 * is a silent no-op.
 */
export interface BootBackupDeps {
  /** Path to the session SQLite DB (`profile.sqlitePath`). */
  sessionDbPath: string;
  /** Injected ISO clock (matches the daemon's `nowIso`). */
  nowIso: () => string;
  /** Override the backup directory; defaults to `<sessionDbDir>/backups`. */
  backupDir?: string;
  logger?: Pick<Console, "log" | "warn">;
}

export async function backupSessionDbAtBoot(
  deps: BootBackupDeps,
): Promise<void> {
  const { sessionDbPath, nowIso, logger = console } = deps;
  if (!existsSync(sessionDbPath)) {
    return; // first boot: no DB to back up yet
  }
  const backupDir = deps.backupDir ?? join(dirname(sessionDbPath), "backups");

  const db = new Database(sessionDbPath);
  try {
    // (1) Rolling boot copy — best-effort; never crashes boot.
    try {
      const dest = await rollingBootBackup({ db, backupDir, now: nowIso });
      logger.log(`[backup] rolling boot copy written: ${dest}`);
    } catch (e) {
      logger.warn(
        `[backup] rolling boot copy failed (continuing boot): ${String(e)}`,
      );
    }

    // (2) Mandatory pre-migration copy — only when a real migration is
    // pending. Deliberately NOT wrapped in try/catch: a failure must abort
    // boot before the SessionStore constructor applies the migration.
    if (pendingMigrations(db).length > 0) {
      const dest = await preMigrationBackup({ db, backupDir, now: nowIso });
      logger.log(`[backup] pre-migration copy written: ${dest}`);
    }
  } finally {
    db.close();
  }
}
