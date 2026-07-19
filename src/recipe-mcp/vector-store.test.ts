import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { VectorStore } from "./vector-store.js";

// Real in-memory better-sqlite3 + sqlite-vec: the native extension loads
// cleanly in this test environment (verified manually before writing this
// suite), so we exercise the real SQL/vector-search path rather than mocking
// sqlite-vec calls.

function makeStore(dimensions = 3) {
  return new VectorStore({ path: ":memory:", dimensions });
}

let store: VectorStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("VectorStore", () => {
  it("returns undefined for a hash lookup on an id that has never been upserted", () => {
    store = makeStore();
    expect(store.getStoredHash("missing")).toBeUndefined();
  });

  it("round-trips upsert -> search: the nearest vector is returned first", () => {
    store = makeStore();
    store.upsert("note-close", [1, 0, 0], {
      title: "Close Match",
      body: "body a",
      hash: "hash-a",
      modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    store.upsert("note-far", [0, 0, 1], {
      title: "Far Match",
      body: "body b",
      hash: "hash-b",
      modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const results = store.search([1, 0, 0], { limit: 2 });

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("note-close");
    expect(results[0].title).toBe("Close Match");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects the limit option", () => {
    store = makeStore();
    for (let i = 0; i < 5; i++) {
      store.upsert(`note-${i}`, [1, 0, 0], {
        title: `Note ${i}`,
        body: "body",
        hash: `hash-${i}`,
        modifiedAt: new Date(),
      });
    }

    const results = store.search([1, 0, 0], { limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("excludes ids passed via exclude_ids", () => {
    store = makeStore();
    store.upsert("note-a", [1, 0, 0], {
      title: "A",
      body: "body",
      hash: "hash-a",
      modifiedAt: new Date(),
    });
    store.upsert("note-b", [0.9, 0.1, 0], {
      title: "B",
      body: "body",
      hash: "hash-b",
      modifiedAt: new Date(),
    });
    store.upsert("note-c", [0, 1, 0], {
      title: "C",
      body: "body",
      hash: "hash-c",
      modifiedAt: new Date(),
    });

    const results = store.search([1, 0, 0], {
      limit: 5,
      exclude_ids: ["note-a"],
    });

    expect(results.map((r) => r.id)).not.toContain("note-a");
    expect(results.map((r) => r.id)).toEqual(
      expect.arrayContaining(["note-b", "note-c"]),
    );
  });

  it("upsert on an existing id updates metadata and embedding rather than duplicating the row", () => {
    store = makeStore();
    store.upsert("note-a", [1, 0, 0], {
      title: "Original Title",
      body: "original body",
      hash: "hash-1",
      modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    store.upsert("note-a", [0, 1, 0], {
      title: "Updated Title",
      body: "updated body",
      hash: "hash-2",
      modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(store.getStoredHash("note-a")).toBe("hash-2");

    const results = store.search([0, 1, 0], { limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Updated Title");
  });

  it("getStoredHash reflects the hash-gate value used by sync", () => {
    store = makeStore();
    store.upsert("note-a", [1, 0, 0], {
      title: "A",
      body: "body",
      hash: "abc123",
      modifiedAt: new Date(),
    });

    expect(store.getStoredHash("note-a")).toBe("abc123");
    expect(store.getStoredHash("note-nonexistent")).toBeUndefined();
  });

  describe("getNote", () => {
    it("returns null for an id that has never been upserted", () => {
      store = makeStore();
      expect(store.getNote("missing")).toBeNull();
    });

    it("returns the stored id/title/body for an upserted note", () => {
      store = makeStore();
      store.upsert("note-a", [1, 0, 0], {
        title: "A Title",
        body: "A body",
        hash: "hash-a",
        modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(store.getNote("note-a")).toEqual({
        id: "note-a",
        title: "A Title",
        body: "A body",
      });
    });

    it("reflects the latest metadata after an upsert on an existing id", () => {
      store = makeStore();
      store.upsert("note-a", [1, 0, 0], {
        title: "Original Title",
        body: "original body",
        hash: "hash-1",
        modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      store.upsert("note-a", [0, 1, 0], {
        title: "Updated Title",
        body: "updated body",
        hash: "hash-2",
        modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
      });

      expect(store.getNote("note-a")).toEqual({
        id: "note-a",
        title: "Updated Title",
        body: "updated body",
      });
    });
  });

  describe("listIds / deleteMany (stale-recipe reconciliation, q95.14)", () => {
    it("listIds returns every stored note id (empty when none)", () => {
      store = makeStore();
      expect(store.listIds()).toEqual([]);

      store.upsert("note-a", [1, 0, 0], {
        title: "A",
        body: "body",
        hash: "hash-a",
        modifiedAt: new Date(),
      });
      store.upsert("note-b", [0, 1, 0], {
        title: "B",
        body: "body",
        hash: "hash-b",
        modifiedAt: new Date(),
      });

      expect(store.listIds().sort()).toEqual(["note-a", "note-b"]);
    });

    it("deleteMany removes the note AND its vector row so it no longer ranks in search", () => {
      store = makeStore();
      store.upsert("note-keep", [1, 0, 0], {
        title: "Keep",
        body: "body",
        hash: "hash-keep",
        modifiedAt: new Date(),
      });
      store.upsert("note-drop", [0.9, 0.1, 0], {
        title: "Drop",
        body: "body",
        hash: "hash-drop",
        modifiedAt: new Date(),
      });

      store.deleteMany(["note-drop"]);

      // Gone from the id set, hash lookup, note lookup, AND vector search.
      expect(store.listIds()).toEqual(["note-keep"]);
      expect(store.getStoredHash("note-drop")).toBeUndefined();
      expect(store.getNote("note-drop")).toBeNull();
      const results = store.search([1, 0, 0], { limit: 10 });
      expect(results.map((r) => r.id)).toEqual(["note-keep"]);
    });

    it("deleteMany is a no-op for an empty list and for unknown ids", () => {
      store = makeStore();
      store.upsert("note-a", [1, 0, 0], {
        title: "A",
        body: "body",
        hash: "hash-a",
        modifiedAt: new Date(),
      });

      store.deleteMany([]);
      store.deleteMany(["never-existed"]);

      expect(store.listIds()).toEqual(["note-a"]);
    });

    it("a rowid freed by deleteMany is not reused to corrupt a surviving vector", () => {
      // Regression guard: deleting a note must remove its vec0 row too, else a
      // later insert reusing the rowid would collide with a stale embedding.
      store = makeStore();
      store.upsert("note-a", [1, 0, 0], {
        title: "A",
        body: "body",
        hash: "hash-a",
        modifiedAt: new Date(),
      });
      store.deleteMany(["note-a"]);
      store.upsert("note-b", [0, 1, 0], {
        title: "B",
        body: "body",
        hash: "hash-b",
        modifiedAt: new Date(),
      });

      const results = store.search([0, 1, 0], { limit: 10 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("note-b");
    });
  });

  it("creates schema on open and survives being reopened against the same file path", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/recipe-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const first = new VectorStore({ path, dimensions: 3 });
    first.upsert("note-a", [1, 0, 0], {
      title: "A",
      body: "body",
      hash: "hash-a",
      modifiedAt: new Date(),
    });
    first.close();

    const second = new VectorStore({ path, dimensions: 3 });
    try {
      expect(second.getStoredHash("note-a")).toBe("hash-a");
      const results = second.search([1, 0, 0], { limit: 5 });
      expect(results.map((r) => r.id)).toContain("note-a");
    } finally {
      second.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });
});
