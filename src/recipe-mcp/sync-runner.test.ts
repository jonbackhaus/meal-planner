import { describe, expect, it, vi } from "vitest";
import { contentHash, type RawNote } from "./notes-reader.js";
import { EXTRACTOR_VERSION } from "./structured-store.js";
import { embeddableTextHash } from "./sync.js";
import { runSync } from "./sync-runner.js";

/**
 * `runSync` is a thin factory over `syncNotes` (see sync.test.ts for the sync
 * internals). These tests only pin what runSync itself owns: binding
 * `folderName` into `readNotes`, and returning `syncNotes`'s `SyncResult`
 * unchanged. Fakes mirror sync.test.ts's style.
 */

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
    ingredients: [],
    veg_status: "contains_meat" as const,
    effort_tags: ["weeknight"],
    season_tags: ["all"],
    quality: "untested" as const,
  };
}

/** An unchanged note whose embedding + extraction gates both hit → skipped. */
function skippableDeps(theNote: RawNote) {
  const embed = vi.fn(async (text: string) => [text.length, 0, 0]);
  const vectorStore = {
    getStoredHash: vi.fn(() => embeddableTextHash(theNote)),
    upsert: vi.fn(),
  };
  const structuredStore = {
    getStructured: vi.fn(() => ({
      contentHash: contentHash(theNote),
      extractorVersion: EXTRACTOR_VERSION,
      fields: extractedFields(),
      needsReview: false,
    })),
    upsertStructured: vi.fn(),
  };
  const llm = { runQuery: vi.fn() };
  return { embedder: { embed }, vectorStore, structuredStore, llm };
}

describe("runSync", () => {
  it("passes folderName through to readNotes and returns the SyncResult", async () => {
    const theNote = note();
    const readNotes = vi.fn(async (_opts?: { folderName?: string }) => [
      theNote,
    ]);
    const { embedder, vectorStore, structuredStore, llm } =
      skippableDeps(theNote);

    const result = await runSync(
      { readNotes, embedder, vectorStore, structuredStore, llm },
      { folderName: "Desserts" },
    );

    expect(readNotes).toHaveBeenCalledWith({ folderName: "Desserts" });
    expect(result).toEqual({
      total: 1,
      processed: 0,
      skipped: 1,
      extractionFailures: 0,
    });
  });

  it("passes folderName undefined through when no options are given", async () => {
    const theNote = note();
    const readNotes = vi.fn(async (_opts?: { folderName?: string }) => [
      theNote,
    ]);
    const { embedder, vectorStore, structuredStore, llm } =
      skippableDeps(theNote);

    await runSync({ readNotes, embedder, vectorStore, structuredStore, llm });

    expect(readNotes).toHaveBeenCalledWith({ folderName: undefined });
  });
});
