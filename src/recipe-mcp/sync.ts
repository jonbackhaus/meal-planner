import { createHash } from "node:crypto";
import type { LlmClient } from "../llm/llm-client.js";
import type { Embedder } from "./embedder.js";
import { type ExtractedFields, extractRecipeFields } from "./extraction.js";
import { contentHash, type RawNote } from "./notes-reader.js";
import { EXTRACTOR_VERSION } from "./structured-store.js";

/**
 * Sync: read Apple Notes -> embed changed/new notes -> upsert into the
 * vector store, AND (independently) run the ingest-time LLM extraction
 * pass (ADR 0001 D1) -> upsert into the structured-field cache.
 *
 * Two independent hash gates, deliberately not unified:
 *  - Embedding gate: `embeddableTextHash` (title+body). A title-only edit
 *    changes this, so the note is re-embedded (and its stored `title`
 *    column refreshed) even though nothing worth re-extracting changed.
 *  - Extraction gate: notes-reader's body-only `contentHash`, PLUS the
 *    `extractor_version` on the cached record, PLUS the cached record's
 *    `needsReview` flag (a prior failed extraction forces a retry on the
 *    next sync even if the body is unchanged). A body edit invalidates
 *    both gates; a title-only edit invalidates only the embedding gate.
 */

/** Minimal store surface sync.ts needs — satisfied structurally by VectorStore. */
export interface SyncStore {
  getStoredHash(id: string): string | undefined;
  upsert(
    id: string,
    vector: number[],
    meta: { title: string; body: string; hash: string; modifiedAt: Date },
  ): void;
}

/** A cached structured-extraction record, as read from / written to the structured-field cache. */
export interface SyncStructuredRecord {
  contentHash: string;
  extractorVersion: number;
  fields: ExtractedFields | null;
  needsReview: boolean;
}

/** Minimal structured-cache surface sync.ts needs — satisfied structurally by StructuredStore. */
export interface SyncStructuredStore {
  getStructured(noteId: string): SyncStructuredRecord | null;
  upsertStructured(noteId: string, record: SyncStructuredRecord): void;
}

export interface SyncDeps {
  readNotes: () => Promise<RawNote[]>;
  embedder: Embedder;
  store: SyncStore;
  structuredStore: SyncStructuredStore;
  llm: LlmClient;
}

export interface SyncResult {
  /** Total notes read from the source. */
  total: number;
  /** Notes (re-)embedded and upserted because they were new or changed. */
  processed: number;
  /** Notes skipped because their content hash matched the stored hash. */
  skipped: number;
  /** Notes whose extraction failed and were marked needs_review (isolated; sync continued). */
  extractionFailures: number;
}

function embeddableText(note: RawNote): string {
  return `${note.title}\n\n${note.body}`;
}

/**
 * Hash-gate key: a hash of exactly the text that gets embedded and stored
 * (title+body via `embeddableText`), not notes-reader's body-only
 * `contentHash`. This keeps "what's hashed" == "what's embedded" ==
 * "what's stored" from drifting apart — a title-only edit (e.g. a recipe
 * rename) changes this hash, so the note is re-embedded and re-upserted
 * (which is also the only path that refreshes the stored `title` column,
 * per `VectorStore.upsert`).
 *
 * Deliberately separate from notes-reader's `contentHash(note.body)`, which
 * is the ADR-0001-specified cache key for the future structured-field
 * extraction pass (q95.3) — a consumer that legitimately depends on body
 * only and must not be changed here.
 */
export function embeddableTextHash(note: RawNote): string {
  return createHash("sha256")
    .update(embeddableText(note), "utf8")
    .digest("hex");
}

/**
 * Runs one sync pass over every note from the configured source:
 *
 * 1. Embedding (title+body gate): a note that is new or whose
 *    `embeddableTextHash` has changed since the last sync is (re-)embedded
 *    and upserted into the vector store; otherwise it's skipped.
 * 2. Extraction (body-only hash + extractor-version gate, run
 *    independently of step 1 — see module doc comment): a note whose
 *    structured cache entry is missing, stale (body hash or extractor
 *    version mismatch), or flagged `needsReview` is re-extracted via
 *    `extractRecipeFields` and upserted into the structured-field cache.
 *
 * Per-note error isolation: an embedder failure still propagates and fails
 * the whole sync (an embedding is required for the note to be findable at
 * all). An EXTRACTION failure for one note is caught, logged (note id
 * only — never the body or raw LLM output), recorded as a minimal
 * `needs_review: true` cache entry (so it's retried on the next sync
 * regardless of body hash), and does NOT stop the batch — reflected in
 * `SyncResult.extractionFailures`.
 */
export async function syncNotes(deps: SyncDeps): Promise<SyncResult> {
  const notes = await deps.readNotes();

  let processed = 0;
  let skipped = 0;
  let extractionFailures = 0;

  for (const note of notes) {
    const embedHash = embeddableTextHash(note);
    const storedHash = deps.store.getStoredHash(note.id);

    if (storedHash === embedHash) {
      skipped += 1;
    } else {
      const vector = await deps.embedder.embed(embeddableText(note));
      deps.store.upsert(note.id, vector, {
        title: note.title,
        body: note.body,
        hash: embedHash,
        modifiedAt: note.modifiedAt,
      });
      processed += 1;
    }

    const bodyHash = contentHash(note);
    const structured = deps.structuredStore.getStructured(note.id);
    const extractionIsStale =
      structured === null ||
      structured.contentHash !== bodyHash ||
      structured.extractorVersion !== EXTRACTOR_VERSION ||
      structured.needsReview;

    if (!extractionIsStale) {
      continue;
    }

    try {
      const fields = await extractRecipeFields(note, deps.llm);
      deps.structuredStore.upsertStructured(note.id, {
        contentHash: bodyHash,
        extractorVersion: EXTRACTOR_VERSION,
        fields,
        needsReview: false,
      });
    } catch {
      extractionFailures += 1;
      console.warn(
        `sync: extraction failed for note ${note.id}; marking needs_review for retry on next sync`,
      );
      deps.structuredStore.upsertStructured(note.id, {
        contentHash: bodyHash,
        extractorVersion: EXTRACTOR_VERSION,
        fields: null,
        needsReview: true,
      });
    }
  }

  return { total: notes.length, processed, skipped, extractionFailures };
}
