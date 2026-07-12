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
  it("opening the store twice against the same file does not error (idempotent schema)", () => {
    store = makeStore();
    expect(() => new SessionStore({ path: ":memory:" }).close()).not.toThrow();
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
