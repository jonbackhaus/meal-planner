import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";

// Real in-memory better-sqlite3 (matches src/recipe-mcp/vector-store.test.ts):
// we exercise the real SQL path rather than mocking better-sqlite3.

function makeStore() {
  return new SessionStore({ path: ":memory:" });
}

let store: SessionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("SessionStore", () => {
  it("reopening the SAME file-backed db is idempotent and preserves prior data (real schema reopen, not two independent :memory: DBs)", () => {
    // Two `:memory:` stores are independent databases, so opening two of
    // them only proves `CREATE TABLE IF NOT EXISTS` works on two *empty*
    // DBs -- it does NOT prove that reopening an *existing* db (schema
    // already present, data already written) is idempotent. Use a real
    // temp file, matching src/recipe-mcp/vector-store.test.ts's pattern.
    const path = `${process.env.TMPDIR ?? "/tmp"}/session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const first = new SessionStore({ path });
    first.insert({
      week_key: "2026-07-12",
      status: "generating",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });
    first.close();

    let second: SessionStore | undefined;
    try {
      expect(() => {
        second = new SessionStore({ path });
      }).not.toThrow();

      const row = second?.get("2026-07-12");
      expect(row).not.toBeNull();
      expect(row?.week_key).toBe("2026-07-12");
      expect(row?.status).toBe("generating");
    } finally {
      second?.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  it("round-trips insert -> get, including default counter values", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "generating",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    const row = store.get("2026-07-12");

    expect(row).not.toBeNull();
    expect(row?.week_key).toBe("2026-07-12");
    expect(row?.status).toBe("generating");
    expect(row?.thread_ts).toBeNull();
    expect(row?.working_plan).toBeNull();
    expect(row?.turn_count).toBe(0);
    expect(row?.token_spend).toBe(0);
    expect(row?.cost_usd).toBe(0);
    expect(row?.created_at).toBe("2026-07-12T06:00:00.000Z");
    expect(row?.updated_at).toBe("2026-07-12T06:00:00.000Z");
  });

  it("returns null from get for an unknown week_key", () => {
    store = makeStore();
    expect(store.get("1999-01-01")).toBeNull();
  });

  it("update mutates status, thread_ts, and working_plan; re-get reflects it", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "generating",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    const plan = { meals: [{ day: null, title: "Tacos" }] };
    store.update("2026-07-12", {
      status: "suggested",
      thread_ts: "1234.5678",
      working_plan: plan,
      updated_at: "2026-07-12T06:05:00.000Z",
    });

    const row = store.get("2026-07-12");
    expect(row?.status).toBe("suggested");
    expect(row?.thread_ts).toBe("1234.5678");
    expect(row?.working_plan).toEqual(plan);
    expect(row?.updated_at).toBe("2026-07-12T06:05:00.000Z");
  });

  it("update mutates turn_count, token_spend, and cost_usd", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    store.update("2026-07-12", {
      turn_count: 3,
      token_spend: 4200,
      cost_usd: 0.42,
      updated_at: "2026-07-12T07:00:00.000Z",
    });

    const row = store.get("2026-07-12");
    expect(row?.turn_count).toBe(3);
    expect(row?.token_spend).toBe(4200);
    expect(row?.cost_usd).toBe(0.42);
  });

  it("update() with a single-field patch does not clobber omitted fields (no-clobber correctness)", () => {
    store = makeStore();
    const plan = { meals: [{ day: "Monday", title: "Pasta" }] };
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      thread_ts: "1111.2222",
      working_plan: plan,
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    // Touch ONLY turn_count.
    store.update("2026-07-12", { turn_count: 1 });

    const row = store.get("2026-07-12");
    expect(row?.turn_count).toBe(1);
    // These must survive untouched. If update() ever regressed to a
    // full-row overwrite (e.g. rebuilding every column from `patch` with
    // defaults for anything unset), these would come back as the default
    // status, null thread_ts, and null working_plan -- so this is a real,
    // falsifiable assertion, not a tautology.
    expect(row?.status).toBe("suggested");
    expect(row?.thread_ts).toBe("1111.2222");
    expect(row?.working_plan).toEqual(plan);
  });

  it("update() can explicitly clear thread_ts to null while leaving other fields intact", () => {
    store = makeStore();
    const plan = { meals: [{ day: "Monday", title: "Pasta" }] };
    store.insert({
      week_key: "2026-07-12",
      status: "suggested",
      thread_ts: "1111.2222",
      working_plan: plan,
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    store.update("2026-07-12", { thread_ts: null });

    const row = store.get("2026-07-12");
    expect(row?.thread_ts).toBeNull();
    expect(row?.status).toBe("suggested");
    expect(row?.working_plan).toEqual(plan);
  });

  it("round-trips an arbitrary working_plan object through JSON serialization", () => {
    store = makeStore();
    const plan = {
      weekKey: "2026-07-12",
      meals: [
        { day: "Sunday", title: "Roast Chicken", recipeId: "r1" },
        { day: null, title: "Leftover Night", recipeId: null },
      ],
    };
    store.insert({
      week_key: "2026-07-12",
      status: "generating",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    store.update("2026-07-12", {
      working_plan: plan,
      updated_at: "2026-07-12T06:01:00.000Z",
    });

    const row = store.get("2026-07-12");
    expect(row?.working_plan).toEqual(plan);
  });

  it("getByThreadTs finds the session by thread_ts", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "generating",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });
    store.update("2026-07-12", {
      status: "suggested",
      thread_ts: "1234.5678",
      updated_at: "2026-07-12T06:05:00.000Z",
    });

    const row = store.getByThreadTs("1234.5678");

    expect(row).not.toBeNull();
    expect(row?.week_key).toBe("2026-07-12");
  });

  it("getByThreadTs returns null when no session has that thread_ts", () => {
    store = makeStore();
    expect(store.getByThreadTs("nonexistent")).toBeNull();
  });

  it("throws on inserting a duplicate week_key (primary key constraint)", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "generating",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    expect(() =>
      store?.insert({
        week_key: "2026-07-12",
        status: "generating",
        created_at: "2026-07-12T06:10:00.000Z",
        updated_at: "2026-07-12T06:10:00.000Z",
      }),
    ).toThrow();
  });
});
