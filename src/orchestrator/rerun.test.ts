import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseReRunArgs,
  ReRunRefusedError,
  ReRunUsageError,
  reRunWeek,
} from "./rerun.js";
import { SessionStore } from "./session-store.js";

function makeStore() {
  return new SessionStore({ path: ":memory:" });
}

let store: SessionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

const WEEK = "2026-07-12";

describe("reRunWeek", () => {
  it('a `failed` row: deletes it, calls generateForWeek(wk, {force:true}), returns "generated"', async () => {
    store = makeStore();
    store.insert({
      week_key: WEEK,
      status: "failed",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });
    const generateForWeek = vi.fn(async () => "generated" as const);

    const result = await reRunWeek(WEEK, {}, { store, generateForWeek });

    expect(result).toBe("generated");
    expect(generateForWeek).toHaveBeenCalledWith(WEEK, { force: true });
    expect(generateForWeek).toHaveBeenCalledTimes(1);
  });

  it("deletes the existing `failed` row BEFORE calling generateForWeek (no row present at call time)", async () => {
    store = makeStore();
    const theStore = store;
    store.insert({
      week_key: WEEK,
      status: "failed",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });
    const generateForWeek = vi.fn(async () => {
      expect(theStore.get(WEEK)).toBeNull();
      return "generated" as const;
    });

    await reRunWeek(WEEK, {}, { store, generateForWeek });

    expect(generateForWeek).toHaveBeenCalledTimes(1);
  });

  it.each([
    "suggested",
    "committed",
    "under_revision",
  ] as const)("a NON-`failed` row (`%s`) WITHOUT --force: throws ReRunRefusedError, does not delete, does not generate", async (status) => {
    store = makeStore();
    store.insert({
      week_key: WEEK,
      status,
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });
    const generateForWeek = vi.fn(async () => "generated" as const);

    await expect(
      reRunWeek(WEEK, {}, { store, generateForWeek }),
    ).rejects.toThrow(ReRunRefusedError);

    expect(generateForWeek).not.toHaveBeenCalled();
    // Not deleted.
    expect(store.get(WEEK)?.status).toBe(status);
  });

  it("ReRunRefusedError names the week_key and current status, and carries no secret (no working_plan)", async () => {
    store = makeStore();
    const plan = { some: "household prose that must never leak" };
    store.insert({
      week_key: WEEK,
      status: "suggested",
      working_plan: plan,
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });
    const generateForWeek = vi.fn(async () => "generated" as const);

    let caught: unknown;
    try {
      await reRunWeek(WEEK, {}, { store, generateForWeek });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ReRunRefusedError);
    const err = caught as ReRunRefusedError;
    expect(err.message).toContain(WEEK);
    expect(err.message).toContain("suggested");
    expect(err.message).not.toContain("household prose");
    expect(err.weekKey).toBe(WEEK);
    expect(err.status).toBe("suggested");
  });

  it("a non-failed row WITH force:true proceeds: deletes + generates", async () => {
    store = makeStore();
    store.insert({
      week_key: WEEK,
      status: "suggested",
      thread_ts: "old.ts",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });
    const generateForWeek = vi.fn(async () => "generated" as const);

    const result = await reRunWeek(
      WEEK,
      { force: true },
      { store, generateForWeek },
    );

    expect(result).toBe("generated");
    expect(generateForWeek).toHaveBeenCalledWith(WEEK, { force: true });
  });

  it("a week with NO existing row just generates (force:true), no delete needed", async () => {
    store = makeStore();
    const generateForWeek = vi.fn(async () => "generated" as const);

    const result = await reRunWeek(WEEK, {}, { store, generateForWeek });

    expect(result).toBe("generated");
    expect(generateForWeek).toHaveBeenCalledWith(WEEK, { force: true });
  });

  it('throws if generateForWeek unexpectedly returns "skipped" despite force:true (invariant guard)', async () => {
    store = makeStore();
    const generateForWeek = vi.fn(async () => "skipped" as const);

    await expect(
      reRunWeek(WEEK, {}, { store, generateForWeek }),
    ).rejects.toThrow();
  });
});

describe("parseReRunArgs", () => {
  it("parses a bare week_key", () => {
    expect(parseReRunArgs(["2026-07-12"])).toEqual({
      week_key: "2026-07-12",
      force: false,
    });
  });

  it("parses a week_key with --force", () => {
    expect(parseReRunArgs(["2026-07-12", "--force"])).toEqual({
      week_key: "2026-07-12",
      force: true,
    });
  });

  it("throws a usage error on empty argv", () => {
    expect(() => parseReRunArgs([])).toThrow(ReRunUsageError);
  });

  it("throws a usage error when the first arg looks like a flag, not a week_key", () => {
    expect(() => parseReRunArgs(["--force"])).toThrow(ReRunUsageError);
  });

  it("throws a usage error on an unrecognized trailing argument", () => {
    expect(() => parseReRunArgs(["2026-07-12", "--bogus"])).toThrow(
      ReRunUsageError,
    );
  });
});
