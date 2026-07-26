import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_VERSION,
  currentVersion,
  type Migration,
  migrations,
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

    // Isolated from the shipped list (which now includes a real `session`-
    // table migration, bd meal-planner-2b2) -- this test targets only the
    // generic baseline-stamping behavior.
    runMigrations(db, []);

    expect(userVersion(db)).toBe(BASELINE_VERSION);
    expect(userVersion(db)).toBe(1);
  });

  it("leaves a DB already at vN untouched (no re-stamp, no downgrade)", () => {
    db = new Database(":memory:");
    db.pragma("user_version = 5");

    runMigrations(db, []);

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
    runMigrations(db, []); // baseline -> v1, isolated from the shipped list
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

  it("is empty for the shipped migration list once fully applied", () => {
    db = new Database(":memory:");
    // The shipped list's to:2 migration expects a `session` table to already
    // exist (it ALTERs it) -- mirrors SessionStore's real constructor order
    // (initSchema() creates the table, THEN runMigrations() applies this).
    db.exec("CREATE TABLE session (week_key TEXT PRIMARY KEY)");
    runMigrations(db); // -> baseline + every shipped migration
    expect(pendingMigrations(db)).toEqual([]);
  });
});

describe("the shipped migrations list (bd meal-planner-2b2)", () => {
  it("to:2 adds the last_posted_plan column to a baseline `session` table", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE session (
        week_key     TEXT PRIMARY KEY,
        status       TEXT NOT NULL,
        thread_ts    TEXT,
        working_plan TEXT,
        turn_count   INTEGER NOT NULL DEFAULT 0,
        token_spend  INTEGER NOT NULL DEFAULT 0,
        cost_usd     REAL    NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `);

    const database = db;
    runMigrations(database, migrations);

    expect(currentVersion(database)).toBeGreaterThanOrEqual(2);
    const columns = database
      .prepare("PRAGMA table_info(session)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).toContain("last_posted_plan");

    // The new column is usable immediately (nullable, no default needed).
    expect(() =>
      database
        .prepare(
          "INSERT INTO session (week_key, status, last_posted_plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "2026-07-12",
          "suggested",
          null,
          "2026-07-12T06:00:00.000Z",
          "2026-07-12T06:00:00.000Z",
        ),
    ).not.toThrow();
  });
});
