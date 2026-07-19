import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

/**
 * Online, WAL-consistent backups of the SESSION SQLite DB (ADR 0002, bd6.13).
 * The session DB is the permanent historical record and the v3.0 `thread_ts
 * -> week_key` reverse map — rows are retained, never cleaned up, so losing
 * the file is the SPEC's "deaf bot" failure. These helpers use
 * better-sqlite3's online `.backup()` (NOT a filesystem `cp`), which snapshots
 * a transactionally consistent copy even while the DB is in WAL mode.
 *
 * The RECIPE index is deliberately NOT backed up here: it is fully
 * regenerable via `pnpm sync`, so it needs only the ad-hoc `.bak` it already
 * has.
 *
 * Clock policy (matches session-store.ts / the daemon): this module NEVER
 * calls `Date.now()` / `new Date()`. The timestamp that names a backup file is
 * supplied by an injected `now: () => string` (ISO), so filenames are
 * deterministic and testable.
 */

/** Boot copies retained; older boot copies are pruned. */
export const BOOT_BACKUP_RETENTION = 8;

/** Marker distinguishing a retained pre-migration copy from a rolling boot copy. */
const PRE_MIGRATION_MARKER = "premigration";

const BOOT_BACKUP_RE = /^session-.*\.sqlite$/;

/** ISO timestamps carry `:`, illegal in filenames on some filesystems — swap for `-`. */
function sanitizeTimestamp(iso: string): string {
  return iso.replace(/:/g, "-");
}

/** True for a rolling BOOT copy (excludes retained pre-migration copies). */
function isBootBackup(file: string): boolean {
  return BOOT_BACKUP_RE.test(file) && !file.includes(PRE_MIGRATION_MARKER);
}

export interface BackupDeps {
  db: Database.Database;
  /** Directory backups are written to (e.g. `data/backups`). Created if absent. */
  backupDir: string;
  /** Injected clock: returns an ISO timestamp used (sanitized) in the filename. */
  now: () => string;
}

/** Low-level: write a single WAL-consistent copy to `destPath`. */
async function backupDatabase(
  db: Database.Database,
  destPath: string,
): Promise<void> {
  await db.backup(destPath);
}

/**
 * Rolling BOOT copy: writes `session-<timestamp>.sqlite` into `backupDir`,
 * then prunes older boot copies beyond `retention` (default 8). Returns the
 * path written.
 */
export async function rollingBootBackup(
  deps: BackupDeps,
  retention: number = BOOT_BACKUP_RETENTION,
): Promise<string> {
  const { db, backupDir, now } = deps;
  mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, `session-${sanitizeTimestamp(now())}.sqlite`);
  await backupDatabase(db, dest);
  pruneBootBackups(backupDir, retention);
  return dest;
}

/**
 * MANDATORY pre-migration copy: writes
 * `session-<timestamp>-premigration.sqlite` into `backupDir` and returns its
 * path. NOT subject to boot retention — a pre-migration snapshot is a
 * point-of-no-return record kept indefinitely. Callers MUST treat a rejected
 * promise as a reason to ABORT the (destructive) migration.
 */
export async function preMigrationBackup(deps: BackupDeps): Promise<string> {
  const { db, backupDir, now } = deps;
  mkdirSync(backupDir, { recursive: true });
  const dest = join(
    backupDir,
    `session-${sanitizeTimestamp(now())}-${PRE_MIGRATION_MARKER}.sqlite`,
  );
  await backupDatabase(db, dest);
  return dest;
}

/** Prune BOOT copies in `backupDir`, keeping the newest `retention`. */
export function pruneBootBackups(
  backupDir: string,
  retention: number = BOOT_BACKUP_RETENTION,
): void {
  let files: string[];
  try {
    files = readdirSync(backupDir);
  } catch {
    return; // dir doesn't exist yet — nothing to prune
  }
  // Filenames embed a sanitized ISO timestamp, so lexical sort == chronological.
  const boot = files.filter(isBootBackup).sort();
  const stale = boot.slice(0, Math.max(0, boot.length - retention));
  for (const f of stale) {
    rmSync(join(backupDir, f), { force: true });
  }
}
