import { createHash } from "node:crypto";
import type { Embedder } from "./embedder.js";
import type { RawNote } from "./notes-reader.js";

/**
 * Sync: read Apple Notes -> embed changed/new notes -> upsert into the
 * vector store. Hash-gated: a note whose stored hash still matches its
 * current content is skipped (not re-embedded).
 *
 * SEAM for q95.3 (structured-field extraction — NOT implemented here): the
 * per-note loop below is where the LLM extraction pass hooks in, per ADR
 * 0001 D1. It shares this same `changed` decision, extended with an
 * `extractor_version` check (a note is only fully skipped if BOTH the
 * content hash AND the extractor version match — so re-tuning the
 * extraction prompt/model forces a clean re-extract without a manual
 * purge). Extraction writes to a structured-field cache keyed by note.id,
 * separate from (but alongside) the vector upsert performed here.
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

export interface SyncDeps {
  readNotes: () => Promise<RawNote[]>;
  embedder: Embedder;
  store: SyncStore;
}

export interface SyncResult {
  /** Total notes read from the source. */
  total: number;
  /** Notes (re-)embedded and upserted because they were new or changed. */
  processed: number;
  /** Notes skipped because their content hash matched the stored hash. */
  skipped: number;
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
 * Runs one sync pass: reads notes from the configured source, embeds
 * title+body for any note that is new or whose content hash has changed
 * since the last sync, and upserts the vector + metadata into the store.
 * Unchanged notes are skipped entirely (no embed call, no upsert).
 */
export async function syncNotes(deps: SyncDeps): Promise<SyncResult> {
  const notes = await deps.readNotes();

  let processed = 0;
  let skipped = 0;

  for (const note of notes) {
    const hash = embeddableTextHash(note);
    const storedHash = deps.store.getStoredHash(note.id);

    if (storedHash === hash) {
      skipped += 1;
      continue;
    }

    // SEAM (q95.3): structured-field extraction would run here, sharing
    // `hash` and the `changed` decision above.
    const vector = await deps.embedder.embed(embeddableText(note));
    deps.store.upsert(note.id, vector, {
      title: note.title,
      body: note.body,
      hash,
      modifiedAt: note.modifiedAt,
    });
    processed += 1;
  }

  return { total: notes.length, processed, skipped };
}
