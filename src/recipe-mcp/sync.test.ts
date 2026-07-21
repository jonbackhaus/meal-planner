import { describe, expect, it, vi } from "vitest";
import { CostCapExceededError } from "../cost/cost-cap-exceeded-error.js";
import { contentHash, type RawNote } from "./notes-reader.js";
import { EXTRACTOR_VERSION } from "./structured-store.js";
import {
  countStaleNotes,
  embeddableTextHash,
  MAX_EXTRACTION_ATTEMPTS,
  syncNotes,
} from "./sync.js";

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
    listIds: vi.fn(() => [...hashes.keys()]),
    deleteMany: vi.fn((ids: string[]) => {
      for (const id of ids) {
        hashes.delete(id);
      }
    }),
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
  failedAttempts?: number;
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
    listIds: vi.fn(() => [...new Set([...records.keys(), ...tags.keys()])]),
    deleteMany: vi.fn((ids: string[]) => {
      for (const id of ids) {
        records.delete(id);
        tags.delete(id);
      }
    }),
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
      removed: 0,
      suspiciousEmptyRead: false,
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
      removed: 0,
      suspiciousEmptyRead: false,
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

  it("ABORTS the batch (rethrows) on CostCapExceededError without corrupting the note record", async () => {
    // The per-run dollar cap (SPEC §9.3) is NOT an ordinary extraction failure:
    // once the metered llm trips it, every remaining note would be re-extracted
    // uncapped AND mislabeled needs_review. So the cap error must rethrow and
    // stop the batch, leaving the offending note's cache record untouched.
    const firstNote = note({ id: "note-first" });
    const secondNote = note({ id: "note-second" });
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = {
      runQuery: vi.fn(async () => {
        throw new CostCapExceededError(3, 2);
      }),
    };
    const readNotes = vi.fn(async () => [firstNote, secondNote]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      syncNotes({
        readNotes,
        embedder,
        store,
        structuredStore,
        llm,
        readNoteTags: () => new Map(),
      }),
    ).rejects.toThrow(CostCapExceededError);

    // The note is NOT marked needs_review -- its good/absent record is preserved.
    expect(structuredStore.upsertStructured).not.toHaveBeenCalled();
    // The batch aborted at the first note: the second note was never reached.
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);

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

describe("syncNotes — extraction attempt cap / backoff (q95.7)", () => {
  function llmAlwaysFailing() {
    // Returns unparseable text on every call, so both the initial attempt and
    // the one repair retry fail -> deterministic ExtractionError every sync.
    return makeFakeLlm(async () => ({
      text: "not json at all",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
  }

  it("stops re-extracting a deterministically-failing note after the cap, then resumes when the body changes", async () => {
    const failingNote = note();
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = llmAlwaysFailing();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const deps = {
      readNotes: vi.fn(async () => [failingNote]),
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map<string, string[]>(),
    };

    // Syncs 1..3 each attempt extraction (2 llm calls: initial + repair) and fail.
    for (let i = 0; i < 3; i += 1) {
      const r = await syncNotes(deps);
      expect(r.extractionFailures).toBe(1);
    }
    // 3 failed attempts x 2 llm calls each.
    expect(llm.runQuery).toHaveBeenCalledTimes(6);
    expect(structuredStore.records.get("note-1")?.failedAttempts).toBe(3);

    // Sync 4+: the note is capped -> extraction skipped, NOT counted as a failure.
    const capped = await syncNotes(deps);
    expect(capped.extractionFailures).toBe(0);
    await syncNotes(deps);
    expect(llm.runQuery).toHaveBeenCalledTimes(6); // unchanged: no further attempts

    // Body change resets the counter and re-enables extraction.
    const changedNote = note({ body: "A brand-new recipe body entirely." });
    deps.readNotes = vi.fn(async () => [changedNote]);
    await syncNotes(deps);
    expect(llm.runQuery).toHaveBeenCalledTimes(8); // one fresh attempt (2 calls)
    // Counter reset to 1 for the new body (a single fresh failure), not 4.
    expect(structuredStore.records.get("note-1")?.failedAttempts).toBe(1);

    warnSpy.mockRestore();
  });

  it("does NOT count a store-write error after a SUCCESSFUL extraction as an extraction failure", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    // The extraction succeeds, but the success-path store write throws. It must
    // surface as itself, not be swallowed/relabeled as an extraction failure.
    structuredStore.upsertStructured.mockImplementation(() => {
      throw new Error("db write failed");
    });
    const llm = llmReturning(extractedFields());

    await expect(
      syncNotes({
        readNotes: vi.fn(async () => [note()]),
        embedder,
        store,
        structuredStore,
        llm,
        readNoteTags: () => new Map(),
      }),
    ).rejects.toThrow("db write failed");

    // The one upsert attempt was the SUCCESS write (fields present, not needs_review):
    // the error was not caught and re-labeled a needs_review extraction failure.
    expect(structuredStore.upsertStructured).toHaveBeenCalledTimes(1);
    expect(structuredStore.upsertStructured).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({
        needsReview: false,
        fields: extractedFields(),
      }),
    );
  });

  it("logs a redacted failure reason (error.message) on an extraction failure", async () => {
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore();
    const llm = llmAlwaysFailing();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncNotes({
      readNotes: vi.fn(async () => [note()]),
      embedder,
      store,
      structuredStore,
      llm,
      readNoteTags: () => new Map(),
    });

    const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("note-1");
    // The concrete (secret-free) reason from ExtractionError is surfaced.
    expect(logged).toContain("could not parse JSON");
    warnSpy.mockRestore();
  });

  it("a CostCapExceededError aborts the batch and does NOT increment the attempt counter", async () => {
    // Regression for fkg.6 interplay: the per-run dollar cap must still abort
    // (rethrow) AND must never be counted as a per-note attempt-cap failure.
    const cappedNote = note();
    const store = makeFakeStore({ "note-1": "stale-hash" });
    const embedder = makeFakeEmbedder();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: "stale-body-hash", // stale -> extraction attempted
        extractorVersion: EXTRACTOR_VERSION,
        fields: null,
        needsReview: true,
        failedAttempts: 1,
      },
    });
    const llm = {
      runQuery: vi.fn(async () => {
        throw new CostCapExceededError(3, 2);
      }),
    };

    await expect(
      syncNotes({
        readNotes: vi.fn(async () => [cappedNote]),
        embedder,
        store,
        structuredStore,
        llm,
        readNoteTags: () => new Map(),
      }),
    ).rejects.toThrow(CostCapExceededError);

    // No cache write at all -> the existing counter is left untouched, not bumped.
    expect(structuredStore.upsertStructured).not.toHaveBeenCalled();
    expect(structuredStore.records.get("note-1")?.failedAttempts).toBe(1);
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

  it("preserves cached tags (skips the upsertTags pass, warns once) when the tag read fails", async () => {
    // A null read == "NoteStore locked/unreadable" (e.g. Notes.app syncing or
    // Full Disk Access revoked), which must NOT be mistaken for "no tags exist"
    // and wipe every note's cached tags to [].
    const structuredStore = makeFakeStructuredStore();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncNotes({
      readNotes: vi.fn(async () => [
        note({ id: "x-coredata://S/ICNote/p10474" }),
      ]),
      embedder: makeFakeEmbedder(),
      store: makeFakeStore(),
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => null,
    });

    // The tag pass is skipped entirely — cached tags are left untouched.
    expect(structuredStore.upsertTags).not.toHaveBeenCalled();
    // Exactly one warning for the failed read (not one per note).
    const tagWarnings = warnSpy.mock.calls.filter((c) =>
      c.join(" ").includes("tag"),
    );
    expect(tagWarnings).toHaveLength(1);
    // The rest of the sync still runs — embedding/extraction are unaffected.
    expect(result.total).toBe(1);
    expect(result.processed).toBe(1);

    warnSpy.mockRestore();
  });
});

describe("syncNotes — stale-recipe reconciliation (q95.14)", () => {
  it("removes a note that was DELETED from the source (gone from both stores)", async () => {
    const survivor = note({ id: "note-live" });
    // Both stores hold a stale id ("note-dead") that this sync no longer reads.
    const store = makeFakeStore({
      "note-live": embeddableTextHash(survivor),
      "note-dead": "some-old-hash",
    });
    const structuredStore = makeFakeStructuredStore({
      "note-live": {
        contentHash: contentHash(survivor),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
      "note-dead": {
        contentHash: "old-body-hash",
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncNotes({
      readNotes: vi.fn(async () => [survivor]),
      embedder: makeFakeEmbedder(),
      store,
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => new Map(),
    });

    // The absent id is deleted from BOTH stores; the survivor is untouched.
    expect(store.deleteMany).toHaveBeenCalledWith(["note-dead"]);
    expect(structuredStore.deleteMany).toHaveBeenCalledWith(["note-dead"]);
    expect(store.listIds()).toEqual(["note-live"]);
    expect(structuredStore.listIds()).toEqual(["note-live"]);
    expect(result.removed).toBe(1);

    warnSpy.mockRestore();
  });

  it("removes a note that was MOVED OUT of the recipe folder (absent from this read)", async () => {
    // A moved-out note is indistinguishable from a delete at the read boundary:
    // it simply isn't in `readNotes()` anymore (the drinks-purge scenario).
    const stayed = note({ id: "note-food" });
    const store = makeFakeStore({
      "note-food": embeddableTextHash(stayed),
      "note-drink": "old-hash",
    });
    const structuredStore = makeFakeStructuredStore({
      "note-food": {
        contentHash: contentHash(stayed),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
      // Simulate a tags-only row for the moved-out note (no extraction record).
    });
    structuredStore.tags.set("note-drink", ["cocktail"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncNotes({
      readNotes: vi.fn(async () => [stayed]),
      embedder: makeFakeEmbedder(),
      store,
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => new Map(),
    });

    expect(store.deleteMany).toHaveBeenCalledWith(["note-drink"]);
    expect(structuredStore.deleteMany).toHaveBeenCalledWith(["note-drink"]);
    expect(structuredStore.tags.has("note-drink")).toBe(false);
    expect(result.removed).toBe(1);

    warnSpy.mockRestore();
  });

  it("EMPTY-READ GUARD: 0 notes read while the store holds recipes does NOT wipe the index (warns instead)", async () => {
    const seed: Record<string, string> = {};
    const seedStructured: Record<string, FakeStructuredRecord> = {};
    for (let i = 0; i < 200; i += 1) {
      seed[`note-${i}`] = `hash-${i}`;
      seedStructured[`note-${i}`] = {
        contentHash: `body-${i}`,
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      };
    }
    const store = makeFakeStore(seed);
    const structuredStore = makeFakeStructuredStore(seedStructured);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncNotes({
      readNotes: vi.fn(async () => []),
      embedder: makeFakeEmbedder(),
      store,
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => new Map(),
    });

    // Reconciliation is SKIPPED entirely — nothing deleted.
    expect(store.deleteMany).not.toHaveBeenCalled();
    expect(structuredStore.deleteMany).not.toHaveBeenCalled();
    expect(store.listIds()).toHaveLength(200);
    expect(structuredStore.listIds()).toHaveLength(200);
    expect(result.removed).toBe(0);
    // Signals the caller to alert loudly (fkg.7), not just warn.
    expect(result.suspiciousEmptyRead).toBe(true);
    // The operator is warned about the suspicious empty read.
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toMatch(/reconciliation/i);

    warnSpy.mockRestore();
  });

  it("does NOT delete anything when every stored id is still present in the read", async () => {
    const a = note({ id: "note-a" });
    const store = makeFakeStore({ "note-a": embeddableTextHash(a) });
    const structuredStore = makeFakeStructuredStore({
      "note-a": {
        contentHash: contentHash(a),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });

    const result = await syncNotes({
      readNotes: vi.fn(async () => [a]),
      embedder: makeFakeEmbedder(),
      store,
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => new Map(),
    });

    expect(store.deleteMany).not.toHaveBeenCalled();
    expect(structuredStore.deleteMany).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
  });

  it("an empty read into an EMPTY store is a harmless no-op (no delete, no warn)", async () => {
    const store = makeFakeStore();
    const structuredStore = makeFakeStructuredStore();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncNotes({
      readNotes: vi.fn(async () => []),
      embedder: makeFakeEmbedder(),
      store,
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => new Map(),
    });

    expect(store.deleteMany).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
    // An empty read into an empty index is NOT suspicious — no alert signal.
    expect(result.suspiciousEmptyRead).toBe(false);
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).not.toMatch(/reconciliation/i);

    warnSpy.mockRestore();
  });
});

describe("countStaleNotes (bd meal-planner-a9e)", () => {
  it("counts a note needing (re-)embedding as stale, without embedding it", async () => {
    const a = note({ id: "note-1" });
    // No stored hash at all -> new note -> needs embed.
    const store = makeFakeStore();
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(a),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });

    const result = await countStaleNotes({
      readNotes: vi.fn(async () => [a]),
      store,
      structuredStore,
    });

    expect(result).toEqual({ total: 1, stale: 1 });
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("counts a note needing re-extraction (body hash changed) as stale", async () => {
    const a = note({ id: "note-1", body: "new body text" });
    const embedHash = embeddableTextHash(a);
    const store = makeFakeStore({ "note-1": embedHash }); // embed hash matches -> not stale on embed gate
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: "stale-body-hash",
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });

    const result = await countStaleNotes({
      readNotes: vi.fn(async () => [a]),
      store,
      structuredStore,
    });

    expect(result).toEqual({ total: 1, stale: 1 });
  });

  it("does not count an up-to-date note (both gates satisfied) as stale", async () => {
    const a = note({ id: "note-1" });
    const embedHash = embeddableTextHash(a);
    const store = makeFakeStore({ "note-1": embedHash });
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(a),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });

    const result = await countStaleNotes({
      readNotes: vi.fn(async () => [a]),
      store,
      structuredStore,
    });

    expect(result).toEqual({ total: 1, stale: 0 });
  });

  it("does not count an up-to-date note flagged needsReview but already capped-out (parked) as stale", async () => {
    const a = note({ id: "note-1" });
    const embedHash = embeddableTextHash(a);
    const store = makeFakeStore({ "note-1": embedHash });
    const structuredStore = makeFakeStructuredStore({
      "note-1": {
        contentHash: contentHash(a),
        extractorVersion: EXTRACTOR_VERSION,
        fields: null,
        needsReview: true,
        failedAttempts: MAX_EXTRACTION_ATTEMPTS,
      },
    });

    const result = await countStaleNotes({
      readNotes: vi.fn(async () => [a]),
      store,
      structuredStore,
    });

    expect(result).toEqual({ total: 1, stale: 0 });
  });

  it("mirrors a real syncNotes pass's affected-note set over a mixed batch, without doing any embed/extraction", async () => {
    const fresh = note({ id: "note-fresh", body: "fresh body" });
    const staleEmbed = note({ id: "note-stale-embed", body: "same body" });
    const staleExtraction = note({
      id: "note-stale-extraction",
      body: "changed body",
    });

    const store = makeFakeStore({
      "note-fresh": embeddableTextHash(fresh),
      "note-stale-embed": "outdated-embed-hash",
      "note-stale-extraction": embeddableTextHash(staleExtraction),
    });
    const structuredStore = makeFakeStructuredStore({
      "note-fresh": {
        contentHash: contentHash(fresh),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
      "note-stale-embed": {
        contentHash: contentHash(staleEmbed),
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
      "note-stale-extraction": {
        contentHash: "old-body-hash",
        extractorVersion: EXTRACTOR_VERSION,
        fields: extractedFields(),
        needsReview: false,
      },
    });
    const readNotes = vi.fn(async () => [fresh, staleEmbed, staleExtraction]);

    const counted = await countStaleNotes({
      readNotes,
      store,
      structuredStore,
    });
    // "note-stale-embed" (embed gate) and "note-stale-extraction" (extraction
    // gate) are stale; "note-fresh" is up to date on both gates.
    expect(counted).toEqual({ total: 3, stale: 2 });

    // Cross-check against a real syncNotes pass over the SAME fixtures: no
    // embed call for "note-fresh", confirming the pre-count didn't just count
    // everything.
    const embedder = makeFakeEmbedder();
    await syncNotes({
      readNotes,
      embedder,
      store,
      structuredStore,
      llm: llmReturning(extractedFields()),
      readNoteTags: () => new Map(),
    });
    expect(embedder.embed).toHaveBeenCalledTimes(1); // only "note-stale-embed"
  });
});
