import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOT_BACKUP_RETENTION,
  preMigrationBackup,
  pruneBootBackups,
  rollingBootBackup,
} from "./backup.js";

/**
 * `backup.ts` (bd6.13): WAL-consistent online `.backup()` of the session DB.
 * Under test: (1) a rolling boot copy is a real, openable copy of the source;
 * (2) the rolling policy keeps only the last 8 boot copies (fake clock ->
 * deterministic filenames -> assertable prune); (3) pre-migration copies are
 * retained (not pruned as boot copies).
 */

let tmp: string | undefined;
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeSourceDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("journal_mode = WAL");
  d.exec("CREATE TABLE session (week_key TEXT PRIMARY KEY, status TEXT)");
  d.prepare("INSERT INTO session (week_key, status) VALUES (?, ?)").run(
    "2026-07-12",
    "suggested",
  );
  return d;
}

/** A fake clock producing distinct, ordered ISO timestamps (with colons). */
function fakeClock(): () => string {
  let i = 0;
  return () => {
    const ss = String(i).padStart(2, "0");
    i += 1;
    return `2026-07-18T06:00:${ss}.000Z`;
  };
}

describe("rollingBootBackup", () => {
  it("writes a WAL-consistent copy that opens and contains the source rows", async () => {
    tmp = mkdtempSync(join(tmpdir(), "backup-test-"));
    db = makeSourceDb();
    const backupDir = join(tmp, "backups");

    const dest = await rollingBootBackup({
      db,
      backupDir,
      now: () => "2026-07-18T06:00:00.000Z",
    });

    // Colons in the ISO timestamp must be sanitized out of the filename.
    expect(dest).toContain("session-2026-07-18T06-00-00.000Z.sqlite");
    expect(dest).not.toContain(":");

    const copy = new Database(dest, { readonly: true });
    try {
      const row = copy
        .prepare("SELECT status FROM session WHERE week_key = ?")
        .get("2026-07-12") as { status: string } | undefined;
      expect(row?.status).toBe("suggested");
    } finally {
      copy.close();
    }
  });

  it(`keeps only the last ${BOOT_BACKUP_RETENTION} boot copies, pruning older ones`, async () => {
    tmp = mkdtempSync(join(tmpdir(), "backup-test-"));
    db = makeSourceDb();
    const backupDir = join(tmp, "backups");
    const now = fakeClock();

    // Take more than the retention limit.
    for (let n = 0; n < BOOT_BACKUP_RETENTION + 2; n += 1) {
      await rollingBootBackup({ db, backupDir, now });
    }

    const files = readdirSync(backupDir).sort();
    expect(files).toHaveLength(BOOT_BACKUP_RETENTION);
    // The two OLDEST (seconds 00 and 01) must have been pruned; the newest 8
    // (seconds 02..09) survive.
    expect(files[0]).toContain("06-00-02");
    expect(files.at(-1)).toContain("06-00-09");
    expect(files.some((f) => f.includes("06-00-00"))).toBe(false);
    expect(files.some((f) => f.includes("06-00-01"))).toBe(false);
  });

  it("honours a custom retention count", async () => {
    tmp = mkdtempSync(join(tmpdir(), "backup-test-"));
    db = makeSourceDb();
    const backupDir = join(tmp, "backups");
    const now = fakeClock();

    for (let n = 0; n < 5; n += 1) {
      await rollingBootBackup({ db, backupDir, now }, 3);
    }

    expect(readdirSync(backupDir)).toHaveLength(3);
  });
});

describe("preMigrationBackup", () => {
  it("writes a retained pre-migration copy that pruneBootBackups never deletes", async () => {
    tmp = mkdtempSync(join(tmpdir(), "backup-test-"));
    db = makeSourceDb();
    const backupDir = join(tmp, "backups");
    const now = fakeClock();

    const preDest = await preMigrationBackup({ db, backupDir, now });
    expect(preDest).toContain("premigration");

    // Fill past the boot retention with rolling copies, then prune hard.
    for (let n = 0; n < BOOT_BACKUP_RETENTION + 3; n += 1) {
      await rollingBootBackup({ db, backupDir, now });
    }
    pruneBootBackups(backupDir, BOOT_BACKUP_RETENTION);

    const files = readdirSync(backupDir);
    // The pre-migration copy is retained despite heavy boot churn.
    expect(files.some((f) => f.includes("premigration"))).toBe(true);
    // Boot copies are still capped at the retention limit.
    expect(files.filter((f) => !f.includes("premigration"))).toHaveLength(
      BOOT_BACKUP_RETENTION,
    );
  });
});

describe("pruneBootBackups", () => {
  it("is a no-op when the backup dir does not exist yet", () => {
    tmp = mkdtempSync(join(tmpdir(), "backup-test-"));
    expect(() =>
      pruneBootBackups(join(tmp as string, "does-not-exist")),
    ).not.toThrow();
  });
});
