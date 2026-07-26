import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupSessionDbAtBoot } from "./boot-backup.js";
import { migrations, runMigrations } from "./migrations.js";

/**
 * `backupSessionDbAtBoot` (bd6.13) boot orchestration. Under test: (1) a
 * first boot with no DB file is a silent no-op; (2) an existing DB gets a
 * rolling boot copy; (3) a DB with a REAL pending migration (bd
 * meal-planner-2b2's `to:2`, the first one shipped) ALSO gets a mandatory
 * pre-migration copy -- the gate the v1.0-era doc comment predicted would
 * "activate automatically"; (4) an already-fully-migrated DB gets no
 * pre-migration copy (nothing pending).
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

/** A DB already brought fully up to date -- no migration left pending. */
function seedFullyMigratedSessionDb(path: string): void {
  const d = new Database(path);
  d.pragma("journal_mode = WAL");
  d.exec("CREATE TABLE session (week_key TEXT PRIMARY KEY, status TEXT)");
  runMigrations(d, migrations);
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

  it("writes a rolling boot copy AND a mandatory pre-migration copy when a real migration is pending (bd meal-planner-2b2)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "boot-backup-test-"));
    const sessionDbPath = join(tmp, "meal-planner.sqlite");
    seedSessionDb(sessionDbPath);

    await backupSessionDbAtBoot({
      sessionDbPath,
      nowIso: () => "2026-07-18T06:00:00.000Z",
      logger: silentLogger,
    });

    const files = readdirSync(join(tmp, "backups"));
    // The rolling boot copy, PLUS a mandatory pre-migration copy -- this DB
    // has never had `to:2` (last_posted_plan) applied, so it's pending.
    expect(files).toHaveLength(2);
    expect(
      files.some((f) => f === "session-2026-07-18T06-00-00.000Z.sqlite"),
    ).toBe(true);
    expect(
      files.some(
        (f) =>
          f.includes("premigration") &&
          f.startsWith("session-2026-07-18T06-00-00.000Z"),
      ),
    ).toBe(true);
  });

  it("writes ONLY a rolling boot copy (no pre-migration copy) when the DB is already fully migrated", async () => {
    tmp = mkdtempSync(join(tmpdir(), "boot-backup-test-"));
    const sessionDbPath = join(tmp, "meal-planner.sqlite");
    seedFullyMigratedSessionDb(sessionDbPath);

    await backupSessionDbAtBoot({
      sessionDbPath,
      nowIso: () => "2026-07-18T06:00:00.000Z",
      logger: silentLogger,
    });

    const files = readdirSync(join(tmp, "backups"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("session-2026-07-18T06-00-00.000Z.sqlite");
    expect(files.some((f) => f.includes("premigration"))).toBe(false);
  });

  it("does not crash boot when the rolling copy fails (best-effort)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "boot-backup-test-"));
    const sessionDbPath = join(tmp, "meal-planner.sqlite");
    // Fully migrated: isolates this test to ONLY the rolling-copy failure
    // path -- with a pending migration also in play, the (deliberately
    // unguarded) mandatory pre-migration copy would ALSO hit the same bad
    // dir and propagate, which is a different scenario (tested separately).
    seedFullyMigratedSessionDb(sessionDbPath);
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
