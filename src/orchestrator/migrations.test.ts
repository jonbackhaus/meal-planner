import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_VERSION,
  type Migration,
  pendingMigrations,
  runMigrations,
} from "./migrations.js";

/**
 * `runMigrations` (bd6.13): forward-only `PRAGMA user_version` runner. Under
 * test: (1) a fresh DB is stamped to the baseline v1; (2) a DB already at some
 * vN is left untouched; (3) pending migrations apply in order, each bumping
 * `user_version`; (4) a migration's `run` and its version bump are ONE
 * transaction, so a throwing migration rolls back atomically.
 */

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function userVersion(d: Database.Database): number {
  return d.pragma("user_version", { simple: true }) as number;
}

describe("runMigrations", () => {
  it("stamps baseline v1 on a fresh DB (user_version 0 -> 1)", () => {
    db = new Database(":memory:");
    expect(userVersion(db)).toBe(0);

    runMigrations(db);

    expect(userVersion(db)).toBe(BASELINE_VERSION);
    expect(userVersion(db)).toBe(1);
  });

  it("leaves a DB already at vN untouched (no re-stamp, no downgrade)", () => {
    db = new Database(":memory:");
    db.pragma("user_version = 5");

    runMigrations(db);

    expect(userVersion(db)).toBe(5);
  });

  it("applies pending migrations in ascending order, bumping user_version to each `to`", () => {
    db = new Database(":memory:");
    const order: number[] = [];
    const list: Migration[] = [
      {
        to: 2,
        run(d) {
          order.push(2);
          d.exec("CREATE TABLE t2 (id INTEGER)");
        },
      },
      {
        to: 3,
        run(d) {
          order.push(3);
          d.exec("CREATE TABLE t3 (id INTEGER)");
        },
      },
    ];

    runMigrations(db, list);

    expect(order).toEqual([2, 3]);
    expect(userVersion(db)).toBe(3);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('t2','t3') ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(["t2", "t3"]);
  });

  it("skips a migration whose `to` <= current version", () => {
    db = new Database(":memory:");
    db.pragma("user_version = 2");
    const ran: number[] = [];
    const list: Migration[] = [
      { to: 2, run: () => ran.push(2) },
      {
        to: 3,
        run(d) {
          ran.push(3);
          d.exec("CREATE TABLE only_three (id INTEGER)");
        },
      },
    ];

    runMigrations(db, list);

    // to:2 is not > current(2), so it is skipped; to:3 runs.
    expect(ran).toEqual([3]);
    expect(userVersion(db)).toBe(3);
  });

  it("rolls back a migration's schema change AND version bump atomically when `run` throws", () => {
    db = new Database(":memory:");
    runMigrations(db); // baseline -> v1
    expect(userVersion(db)).toBe(1);

    const list: Migration[] = [
      {
        to: 2,
        run(d) {
          // A partial change followed by a throw: the whole migration
          // (change + version bump) must roll back together.
          d.exec("CREATE TABLE will_rollback (id INTEGER)");
          throw new Error("boom");
        },
      },
    ];

    expect(() => runMigrations(db as Database.Database, list)).toThrow("boom");

    // Version NOT bumped, and the partial table change was rolled back.
    expect(userVersion(db)).toBe(1);
    const found = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='will_rollback'",
      )
      .get();
    expect(found).toBeUndefined();
  });
});

describe("pendingMigrations", () => {
  it("returns only migrations whose `to` exceeds the current version, in list order", () => {
    db = new Database(":memory:");
    db.pragma("user_version = 2");
    const list: Migration[] = [
      { to: 2, run: () => {} },
      { to: 3, run: () => {} },
      { to: 4, run: () => {} },
    ];

    expect(pendingMigrations(db, list).map((m) => m.to)).toEqual([3, 4]);
  });

  it("is empty for the shipped (v1.0) migration list", () => {
    db = new Database(":memory:");
    runMigrations(db); // -> v1 baseline
    // Default list is empty in v1.0.
    expect(pendingMigrations(db)).toEqual([]);
  });
});
