import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupSessionDbAtBoot } from "./boot-backup.js";

/**
 * `backupSessionDbAtBoot` (bd6.13) boot orchestration. Under test: (1) a
 * first boot with no DB file is a silent no-op; (2) an existing DB gets a
 * rolling boot copy; (3) with no pending migrations (v1.0) NO pre-migration
 * copy is taken.
 */

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function seedSessionDb(path: string): void {
  const d = new Database(path);
  d.pragma("journal_mode = WAL");
  d.exec("CREATE TABLE session (week_key TEXT PRIMARY KEY, status TEXT)");
  d.close();
}

const silentLogger = { log: () => {}, warn: () => {} };

describe("backupSessionDbAtBoot", () => {
  it("is a no-op on first boot (session DB file does not exist yet)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "boot-backup-test-"));
    const sessionDbPath = join(tmp, "meal-planner.sqlite");

    await backupSessionDbAtBoot({
      sessionDbPath,
      nowIso: () => "2026-07-18T06:00:00.000Z",
      logger: silentLogger,
    });

    // Nothing created — no backups dir.
    expect(existsSync(join(tmp, "backups"))).toBe(false);
  });

  it("writes a rolling boot copy (and NO pre-migration copy in v1.0) when the DB exists", async () => {
    tmp = mkdtempSync(join(tmpdir(), "boot-backup-test-"));
    const sessionDbPath = join(tmp, "meal-planner.sqlite");
    seedSessionDb(sessionDbPath);

    await backupSessionDbAtBoot({
      sessionDbPath,
      nowIso: () => "2026-07-18T06:00:00.000Z",
      logger: silentLogger,
    });

    const files = readdirSync(join(tmp, "backups"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("session-2026-07-18T06-00-00.000Z.sqlite");
    // v1.0 has no pending migrations, so no pre-migration copy is written.
    expect(files.some((f) => f.includes("premigration"))).toBe(false);
  });

  it("does not crash boot when the rolling copy fails (best-effort)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "boot-backup-test-"));
    const sessionDbPath = join(tmp, "meal-planner.sqlite");
    seedSessionDb(sessionDbPath);
    const warn = vi.fn();

    // Point the backup dir at a path that is actually a FILE, so mkdir/backup
    // fails — the boot must log and continue rather than throw.
    const badDir = join(tmp, "meal-planner.sqlite"); // an existing file, not a dir

    await expect(
      backupSessionDbAtBoot({
        sessionDbPath,
        backupDir: badDir,
        nowIso: () => "2026-07-18T06:00:00.000Z",
        logger: { log: () => {}, warn },
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
  });
});
