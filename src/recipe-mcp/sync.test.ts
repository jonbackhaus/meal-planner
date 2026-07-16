import { describe, expect, it, vi } from "vitest";
import { contentHash, type RawNote } from "./notes-reader.js";
import { EXTRACTOR_VERSION } from "./structured-store.js";
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

function extractedFields() {
  return {
    time: { active: 20, total: 45, prep: 10, confidence: 0.8 },
    ingredients: [
      {
        raw: "1 lb ground beef",
        name: "ground beef",
        quantity: { kind: "scalar" as const, value: 1 },
        unit: "lb",
        optional: false,
        confidence: 0.9,
        needs_review: false,
      },
    ],
    veg_status: "contains_meat" as const,
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

interface FakeStructuredRecord {
  contentHash: string;
  extractorVersion: number;
  fields: ReturnType<typeof extractedFields> | null;
  needsReview: boolean;
}

function makeFakeStructuredStore(
  initial: Record<string, FakeStructuredRecord> = {},
) {
  const records = new Map(Object.entries(initial));
  const tags = new Map<string, string[]>();
  const upsertStructured = vi.fn(
    (noteId: string, record: FakeStructuredRecord) => {
      records.set(noteId, record);
    },
  );
  const upsertTags = vi.fn((noteId: string, t: string[]) => {
    tags.set(noteId, t);
  });
  return {
    getStructured: vi.fn((noteId: string) => records.get(noteId) ?? null),
    upsertStructured,
    upsertTags,
    records,
    tags,
  };
}

function makeFakeLlm(
  impl: () => Promise<{
    text: string;
    usage: { inputTokens: number; outputTokens: number };
  }>,
) {
  return { runQuery: vi.fn(impl) };
}

function llmReturning(fields: unknown) {
  return makeFakeLlm(async () => ({
    text: JSON.stringify(fields),
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
}

describe("syncNotes — embedding (unchanged behavior)", () => {
  it("embeds and upserts a brand-new note", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [note()]);

    const result = await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.upserted[0].id).toBe("note-1");
    expect(store.upserted[0].meta.title).toBe("Weeknight Chili");
    expect(result).toEqual({
      total: 1,
      processed: 1,
      skipped: 0,
      extractionFailures: 0,
    });
  });

  it("hash-gate: skips embedding a note whose stored hash matches its current content", async () => {
    const unchangedNote = note();
    const currentHash = embeddableTextHash(unchangedNote);
    const store = makeFakeStore({ "note-1": currentHash });
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(unchangedNote),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [unchangedNote]);

    const result = await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("re-embeds a note whose body changed (title unchanged)", async () => {
    const originalNote = note();
    const staleHash = embeddableTextHash(originalNote);
    const changedNote = note({ body: "New body text entirely." });
    const store = makeFakeStore({ "note-1": staleHash });
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [changedNote]);

    const result = await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
  });

  it("re-embeds and re-upserts a note whose TITLE changed (body identical)", async () => {
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
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(originalNote),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [renamedNote]);

    const result = await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.upserted[0].meta.title).toBe("Weeknight Chili Deluxe");
    expect(result.processed).toBe(1);
    // Body is unchanged, so extraction should NOT re-run — proves the two gates are independent.
    expect(llm.runQuery).not.toHaveBeenCalled();
  });

  it("propagates an embedder failure for an individual note", async () => {
    const store = makeFakeStore();
    const embedder = {
      embed: vi.fn(async () => {
        throw new Error("embedding failed");
      }),
    };
    const structuredStore = makeFakeStructuredStore();
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [note()]);

    await expect(
      syncNotes({
        readNotes,
        embedder,
        store,
        structuredStore,
        llm,
        readNoteTags: () => new Map(),
      }),
    ).rejects.toThrow("embedding failed");
  });

  it("returns total:0/processed:0/skipped:0/extractionFailures:0 for an empty note set", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => []);

    const result = await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(result).toEqual({
      total: 0,
      processed: 0,
      skipped: 0,
      extractionFailures: 0,
    });
  });
});

describe("syncNotes — extraction gate (body-only hash + extractor version, independent of the embed gate)", () => {
  it("does NOT re-extract a note whose body is unchanged and whose cached extractor version is current", async () => {
    const unchangedNote = note();
    const store = makeFakeStore({
      "note-1": embeddableTextHash(unchangedNote),
    });
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(unchangedNote),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [unchangedNote]);

    await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(llm.runQuery).not.toHaveBeenCalled();
    expect(structuredStore.upsertStructured).not.toHaveBeenCalled();
  });

  it("re-extracts a note whose body changed, and upserts the new fields keyed by body-only hash", async () => {
    const changedNote = note({ body: "A completely different recipe body." });
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: "stale-body-hash",
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [changedNote]);

    await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(structuredStore.upsertStructured).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({
        contentHash: contentHash(changedNote),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      }),
    );
  });

  it("a brand-new note (never extracted before) is extracted", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [note()]);

    await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(structuredStore.upsertStructured).toHaveBeenCalledTimes(1);
  });

  it("a bumped EXTRACTOR_VERSION forces re-extraction even though the body hash is unchanged", async () => {
    const unchangedNote = note();
    const store = makeFakeStore({
      "note-1": embeddableTextHash(unchangedNote),
    });
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(unchangedNote),
        extractorVersion: EXTRACTOR_VERSION - 1, // stale version
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [unchangedNote]);

    await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(structuredStore.upsertStructured).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({ extractorVersion: EXTRACTOR_VERSION }),
    );
  });

  it("a title-only edit re-embeds but does NOT re-extract (independent gates)", async () => {
    const originalNote = note();
    const store = makeFakeStore({ "note-1": embeddableTextHash(originalNote) });
    const renamedNote = note({ title: "New Title" });
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(originalNote),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [renamedNote]);

    const result = await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(embedder.embed).toHaveBeenCalledTimes(1); // re-embedded
    expect(llm.runQuery).not.toHaveBeenCalled(); // NOT re-extracted
    expect(result.processed).toBe(1);
  });

  it("isolates a per-note extraction failure: marks needs_review, continues the sync, and reflects it in the summary", async () => {
    const badNote = note({ id: "note-bad" });
    const goodNote = note({ id: "note-good" });
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = {
      runQuery: vi
        .fn()
        // note-bad: extraction throws on both the initial attempt and the one repair retry
        .mockResolvedValueOnce({
          text: "not json at all",
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: "still not json",
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        // note-good: succeeds
        .mockResolvedValueOnce({
          text: JSON.stringify(extractedFields()),
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    };
    const readNotes = vi.fn(async () => [badNote, goodNote]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(result.extractionFailures).toBe(1);
    expect(result.total).toBe(2);
    // The bad note is marked needs_review with a minimal record (no fields).
    expect(structuredStore.upsertStructured).toHaveBeenCalledWith(
      "note-bad",
      expect.objectContaining({ needsReview: true, fields: null }),
    );
    // The good note still gets extracted normally — one bad note must not block the batch.
    expect(structuredStore.upsertStructured).toHaveBeenCalledWith(
      "note-good",
      expect.objectContaining({
        needsReview: false,
        fields: extractedFields(),
      }),
    );
    // Both notes are still embedded — extraction failure doesn't block embedding either.
    expect(store.upsert).toHaveBeenCalledTimes(2);
    // The warning logs the note id only — no body/secret dump.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("note-bad"));
    for (const call of warnSpy.mock.calls) {
      expect(call.join(" ")).not.toContain(badNote.body);
    }

    warnSpy.mockRestore();
  });

  it("retries a needs_review note on the next sync even though its body hash still matches", async () => {
    const flaggedNote = note();
    const store = makeFakeStore({ "note-1": embeddableTextHash(flaggedNote) });
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(flaggedNote),
        extractorVersion: EXTRACTOR_VERSION,
        fields: null,
        needsReview: true,
      },
    });
    const llm = llmReturning(extractedFields());
    const readNotes = vi.fn(async () => [flaggedNote]);

    await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(structuredStore.upsertStructured).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({
        needsReview: false,
        fields: extractedFields(),
      }),
    );
  });
});

describe("syncNotes — NoteStore tags (bd tags feature)", () => {
  it("writes each note's tags (keyed by id suffix) even when extraction is skipped", async () => {
    const unchangedNote = note({ id: "x-coredata://S/ICNote/p10474" });
    const store = makeFakeStore({
      "x-coredata://S/ICNote/p10474": embeddableTextHash(unchangedNote),
    });
    const structuredStore = makeFakeStructuredStore({
      "x-coredata://S/ICNote/p10474": {
        contentHash: contentHash(unchangedNote),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const embedder = makeFakeEmbedder();
    const llm = llmReturning(extractedFields());

    await syncNotes({
      readNotes: vi.fn(async () => [unchangedNote]),
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map([["p10474", ["side", "5-stars"]]]),
    });

    // Skipped for embedding AND extraction, but tags still refreshed.
    expect(structuredStore.upsertTags).toHaveBeenCalledWith(
      "x-coredata://S/ICNote/p10474",
      ["side", "5-stars"],
    );
    expect(llm.runQuery).not.toHaveBeenCalled();
  });

  it("writes an empty tag list for a note with no hashtags", async () => {
    const structuredStore = makeFakeStructuredStore();
    await syncNotes({
      readNotes: vi.fn(async () => [note({ id: "x-coredata://S/ICNote/p7" })]),
      embedder: makeFakeEmbedder(),
      store: makeFakeStore(),
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => new Map(),
    });

    expect(structuredStore.upsertTags).toHaveBeenCalledWith(
      "x-coredata://S/ICNote/p7",
      [],
    );
  });
});
