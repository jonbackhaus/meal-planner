import { describe, expect, it, vi } from "vitest";
import type { RawNote } from "./notes-reader.js";
import { embeddableTextHash, syncNotes } from "./sync.js";

function note(overrides: Partial<RawNote> = {}): RawNote {
  return {
    id: "note-1",
    title: "Weeknight Chili",
    body: "Ground beef, beans, chili powder.",
    modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeFakeStore(initialHashes: Record<string, string> = {}) {
  const hashes = new Map(Object.entries(initialHashes));
  const upserted: Array<{
    id: string;
    vector: number[];
    meta: { title: string; body: string; hash: string; modifiedAt: Date };
  }> = [];
  return {
    getStoredHash: vi.fn((id: string) => hashes.get(id)),
    upsert: vi.fn(
      (
        id: string,
        vector: number[],
        meta: { title: string; body: string; hash: string; modifiedAt: Date },
      ) => {
        hashes.set(id, meta.hash);
        upserted.push({ id, vector, meta });
      },
    ),
    upserted,
  };
}

function makeFakeEmbedder() {
  const embed = vi.fn(async (text: string) => [text.length, 0, 0]);
  return { embed };
}

describe("syncNotes", () => {
  it("embeds and upserts a brand-new note", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const readNotes = vi.fn(async () => [note()]);

    const result = await syncNotes({ readNotes, embedder, store });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.upserted[0].id).toBe("note-1");
    expect(store.upserted[0].meta.title).toBe("Weeknight Chili");
    expect(result).toEqual({ total: 1, processed: 1, skipped: 0 });
  });

  it("hash-gate: skips a note whose stored hash matches its current content", async () => {
    const unchangedNote = note();
    const currentHash = embeddableTextHash(unchangedNote);
    const store = makeFakeStore({ "note-1": currentHash });
    const embedder = makeFakeEmbedder();
    const readNotes = vi.fn(async () => [unchangedNote]);

    const result = await syncNotes({ readNotes, embedder, store });

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ total: 1, processed: 0, skipped: 1 });
  });

  it("re-embeds a note whose body changed (title unchanged), stored hash differs from current content hash", async () => {
    const originalNote = note();
    const staleHash = embeddableTextHash(originalNote);
    const changedNote = note({ body: "New body text entirely." });
    const store = makeFakeStore({ "note-1": staleHash });
    const embedder = makeFakeEmbedder();
    const readNotes = vi.fn(async () => [changedNote]);

    const result = await syncNotes({ readNotes, embedder, store });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 1, processed: 1, skipped: 1 - 1 });
  });

  it("re-embeds and re-upserts a note whose TITLE changed (body identical) — regression: the hash gate must cover title+body, not body only", async () => {
    const originalNote = note({
      title: "Weeknight Chili",
      body: "Ground beef, beans, chili powder.",
    });
    const staleHash = embeddableTextHash(originalNote);
    const renamedNote = note({
      title: "Weeknight Chili Deluxe",
      body: originalNote.body,
    });
    const store = makeFakeStore({ "note-1": staleHash });
    const embedder = makeFakeEmbedder();
    const readNotes = vi.fn(async () => [renamedNote]);

    const result = await syncNotes({ readNotes, embedder, store });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.upserted[0].meta.title).toBe("Weeknight Chili Deluxe");
    expect(result).toEqual({ total: 1, processed: 1, skipped: 0 });
  });

  it("processes a mix of unchanged, changed, and new notes correctly", async () => {
    const unchanged = note({ id: "note-unchanged", body: "stable body" });
    const unchangedHash = embeddableTextHash(unchanged);

    const changed = note({ id: "note-changed", body: "new body" });
    const brandNew = note({ id: "note-new", body: "fresh body" });

    const store = makeFakeStore({
      "note-unchanged": unchangedHash,
      "note-changed": "old-stale-hash",
    });
    const embedder = makeFakeEmbedder();
    const readNotes = vi.fn(async () => [unchanged, changed, brandNew]);

    const result = await syncNotes({ readNotes, embedder, store });

    expect(result).toEqual({ total: 3, processed: 2, skipped: 1 });
    const upsertedIds = store.upserted.map((u) => u.id);
    expect(upsertedIds).toEqual(
      expect.arrayContaining(["note-changed", "note-new"]),
    );
    expect(upsertedIds).not.toContain("note-unchanged");
  });

  it("embeds title+body combined text (so a title-only edit still changes what's embedded)", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const readNotes = vi.fn(async () => [
      note({ title: "My Title", body: "My Body" }),
    ]);

    await syncNotes({ readNotes, embedder, store });

    const [embeddedText] = embedder.embed.mock.calls[0];
    expect(embeddedText).toContain("My Title");
    expect(embeddedText).toContain("My Body");
  });

  it("stores the note's title, body, hash, and modifiedAt as metadata on upsert", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const modifiedAt = new Date("2026-02-02T00:00:00.000Z");
    const readNotes = vi.fn(async () => [
      note({ title: "T", body: "B", modifiedAt }),
    ]);

    await syncNotes({ readNotes, embedder, store });

    expect(store.upserted[0].meta).toEqual(
      expect.objectContaining({ title: "T", body: "B", modifiedAt }),
    );
    expect(store.upserted[0].meta.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns total:0/processed:0/skipped:0 for an empty note set", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const readNotes = vi.fn(async () => []);

    const result = await syncNotes({ readNotes, embedder, store });

    expect(result).toEqual({ total: 0, processed: 0, skipped: 0 });
  });

  it("propagates an embedder failure for an individual note", async () => {
    const store = makeFakeStore();
    const embedder = {
      embed: vi.fn(async () => {
        throw new Error("embedding failed");
      }),
    };
    const readNotes = vi.fn(async () => [note()]);

    await expect(syncNotes({ readNotes, embedder, store })).rejects.toThrow(
      "embedding failed",
    );
  });
});
