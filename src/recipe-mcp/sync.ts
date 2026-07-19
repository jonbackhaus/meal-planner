import { createHash } from "node:crypto";
import { CostCapExceededError } from "../cost/cost-cap-exceeded-error.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { Embedder } from "./embedder.js";
import { type ExtractedFields, extractRecipeFields } from "./extraction.js";
import { contentHash, type RawNote } from "./notes-reader.js";
import { noteIdSuffix } from "./notes-tags.js";
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
 *    next sync even if the body is unchanged) — UNTIL the note hits the
 *    per-note attempt cap (`MAX_EXTRACTION_ATTEMPTS`, q95.7), after which
 *    the `needsReview` retry is suppressed until the body changes. A body
 *    edit invalidates both gates (and resets the failure counter); a
 *    title-only edit invalidates only the embedding gate.
 */

/** Minimal store surface sync.ts needs — satisfied structurally by VectorStore. */
export interface SyncStore {
  getStoredHash(id: string): string | undefined;
  upsert(
    id: string,
    vector: number[],
    meta: { title: string; body: string; hash: string; modifiedAt: Date },
  ): void;
  /** All note ids currently in the index — diffed against this sync's read for stale-recipe reconciliation (q95.14). */
  listIds(): string[];
  /** Hard-delete the given note ids (and their vector rows) — stale-recipe reconciliation (q95.14). */
  deleteMany(ids: string[]): void;
}

/** A cached structured-extraction record, as read from / written to the structured-field cache. */
export interface SyncStructuredRecord {
  contentHash: string;
  extractorVersion: number;
  fields: ExtractedFields | null;
  needsReview: boolean;
  /**
   * Consecutive extraction failures for the current body + extractor version
   * (q95.7). Optional on read (absent == 0 for pre-field rows); always written
   * on a failure/success by sync so the attempt cap can bound retries.
   */
  failedAttempts?: number;
}

/**
 * Max consecutive extraction attempts for one note before it's parked (q95.7).
 * A note whose extraction deterministically fails would otherwise re-attempt
 * (1 initial + 1 repair = 2 LLM calls) on EVERY sync forever, because
 * `needsReview` is a staleness OR-condition and the failed record rewrites
 * `contentHash` to current. After this many consecutive failures we STOP
 * re-extracting it until its body changes (which resets the counter). A body
 * edit or a successful extraction resets the count to 0.
 */
export const MAX_EXTRACTION_ATTEMPTS = 3;

/** Minimal structured-cache surface sync.ts needs — satisfied structurally by StructuredStore. */
export interface SyncStructuredStore {
  getStructured(noteId: string): SyncStructuredRecord | null;
  upsertStructured(noteId: string, record: SyncStructuredRecord): void;
  /** Writes the note's NoteStore hashtags, independent of the extraction record. */
  upsertTags(noteId: string, tags: string[]): void;
  /** All note ids with a stored record (incl. tags-only rows) — for stale-recipe reconciliation (q95.14). */
  listIds(): string[];
  /** Hard-delete the structured records (fields + tags) for the given ids — stale-recipe reconciliation (q95.14). */
  deleteMany(ids: string[]): void;
}

export interface SyncDeps {
  readNotes: () => Promise<RawNote[]>;
  embedder: Embedder;
  store: SyncStore;
  structuredStore: SyncStructuredStore;
  llm: LlmClient;
  /**
   * Returns every note's NoteStore hashtags, keyed by the note-id suffix
   * ("p<N>"). Injected (default: the real `readNoteTags`) so sync is testable
   * with a canned map and no dependency on the local Notes DB. Read ONCE per
   * sync (one query), then applied per note — cheap, so tags refresh every
   * sync while the expensive LLM extraction stays body-hash-gated.
   *
   * Returns `null` when the read FAILED (NoteStore missing/locked/unreadable),
   * as distinct from an empty map ("read succeeded, no note has any hashtag").
   * On `null` the tag pass is skipped so cached tags are preserved, not wiped
   * to `[]` (q95.13).
   */
  readNoteTags: () => Map<string, string[]> | null;
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
  /**
   * Notes removed from the index this sync because their source note was
   * deleted or moved out of the recipe folder (stale-recipe reconciliation,
   * q95.14). 0 when nothing was stale OR when the empty-read guard skipped
   * reconciliation.
   */
  removed: number;
  /**
   * `true` when the empty-read guard tripped: the read returned 0 notes while
   * the index still holds recipes (q95.14). That is the denied / failed Notes
   * read fingerprint (macOS Automation / Full Disk Access revoked, folder
   * renamed) — NOT a mass delete — so reconciliation was skipped and the run
   * proceeds against the existing index. This is a passive SIGNAL, not an
   * error: `syncNotes` stays alert-free (no notifier dependency); the caller
   * that HAS the alert composite (`makeBuildPlanWithSync`) turns it into a loud
   * `#agent-alerts` alert (fkg.7), because a silent empty read otherwise looks
   * indistinguishable from "no recipes". `false` on every healthy sync,
   * including a legitimate empty read into an already-empty index.
   */
  suspiciousEmptyRead: boolean;
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
 * all). An EXTRACTION failure for one note is caught, logged (note id +
 * redacted reason — never the body or raw LLM output), recorded as a minimal
 * `needs_review: true` cache entry with an incremented failure counter (so
 * it's retried on the next sync regardless of body hash, but only until it
 * hits `MAX_EXTRACTION_ATTEMPTS` — q95.7), and does NOT stop the batch —
 * reflected in `SyncResult.extractionFailures`. The one exception is a
 * `CostCapExceededError` (SPEC §9.3, bd meal-planner-fkg.6): the per-run
 * dollar cap is NOT a per-note failure, so it rethrows to abort the batch
 * WITHOUT marking the note `needs_review`.
 */
export async function syncNotes(deps: SyncDeps): Promise<SyncResult> {
  const notes = await deps.readNotes();
  // `null` == the NoteStore read FAILED (locked/unreadable), which must NOT be
  // conflated with an empty map ("no tags anywhere"): wiping every note's cached
  // tags to `[]` on a transient hiccup would empty the tag-driven pools and fail
  // the plan run (q95.13). On failure we skip the tag pass entirely (below),
  // preserving cached tags, and warn ONCE for the whole sync.
  const tagsByNote = deps.readNoteTags();
  if (tagsByNote === null) {
    console.warn(
      "sync: NoteStore tag read failed; preserving existing cached tags (skipping tag refresh this sync)",
    );
  }

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

    // Tags refresh every sync (cheap), independent of the extraction gate
    // below — a hashtag edit must take effect without a body change. Written
    // BEFORE the extraction `continue` so unchanged notes still get updated.
    // Skipped entirely when the read failed (`tagsByNote === null`) so cached
    // tags survive a NoteStore hiccup rather than being wiped to `[]`.
    if (tagsByNote !== null) {
      deps.structuredStore.upsertTags(
        note.id,
        tagsByNote.get(noteIdSuffix(note.id)) ?? [],
      );
    }

    const bodyHash = contentHash(note);
    const structured = deps.structuredStore.getStructured(note.id);
    // The failure counter only applies while the body + extractor version are
    // unchanged; a body/version change is a fresh start (`priorFailures` == 0).
    const priorFailures =
      structured !== null &&
      structured.contentHash === bodyHash &&
      structured.extractorVersion === EXTRACTOR_VERSION
        ? (structured.failedAttempts ?? 0)
        : 0;
    // Attempt cap (q95.7): once a note has failed MAX_EXTRACTION_ATTEMPTS times
    // in a row on this same body+version, stop re-extracting it. The `needsReview`
    // OR-condition below is suppressed while capped, so the note is parked until
    // its body changes (which invalidates `contentHash` and forces re-extraction
    // with the counter reset). Body/version changes still bypass the cap.
    const cappedOut = priorFailures >= MAX_EXTRACTION_ATTEMPTS;
    const extractionIsStale =
      structured === null ||
      structured.contentHash !== bodyHash ||
      structured.extractorVersion !== EXTRACTOR_VERSION ||
      (structured.needsReview && !cappedOut);

    if (!extractionIsStale) {
      continue;
    }

    let fields: ExtractedFields;
    try {
      fields = await extractRecipeFields(note, deps.llm);
    } catch (err) {
      // The per-run dollar cap (SPEC §9.3, bd meal-planner-fkg.6) is NOT an
      // isolated extraction failure: once tripped, every remaining note would
      // re-extract uncapped AND be mislabeled needs_review. Rethrow to ABORT
      // the batch, leaving this note's cache record untouched (no needs_review
      // write, no attempt increment). Everything else stays a per-note failure.
      if (err instanceof CostCapExceededError) {
        throw err;
      }
      extractionFailures += 1;
      // Log the (already proven secret-free) reason so failures are triageable
      // — ExtractionError carries only the note id + a short reason, never the
      // body or raw LLM output (see extraction.ts).
      console.warn(
        `sync: extraction failed for note ${note.id}; marking needs_review for retry on next sync; reason: ${(err as Error).message}`,
      );
      deps.structuredStore.upsertStructured(note.id, {
        contentHash: bodyHash,
        extractorVersion: EXTRACTOR_VERSION,
        fields: null,
        needsReview: true,
        failedAttempts: priorFailures + 1,
      });
      continue;
    }

    // Success path is OUTSIDE the try: a store-write error here is a real DB
    // fault, not an extraction failure — let it surface as itself rather than
    // discarding a good extraction and mislabeling the note needs_review (q95.7).
    deps.structuredStore.upsertStructured(note.id, {
      contentHash: bodyHash,
      extractorVersion: EXTRACTOR_VERSION,
      fields,
      needsReview: false,
      failedAttempts: 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Stale-recipe reconciliation (q95.14).
  //
  // The per-note loop above only ever touches notes PRESENT in this sync's read,
  // so a note DELETED from Apple Notes — or MOVED OUT of the recipe folder (the
  // drinks-purge scenario, commit fa2714e) — is simply absent and would linger
  // in the index forever: its vector row keeps ranking in `search_recipes`, it
  // can be selected into a plan, and `get_recipe` still returns it. ADR-0001
  // makes sync the single owner of index freshness, so removal is sync's job.
  //
  // HARD DELETE (not a tombstone): the index is fully regenerable via `pnpm
  // sync`, and historical session `working_plan`s already store the full
  // enriched Recipe (they never re-fetch a deleted id), so there is nothing to
  // preserve by keeping the row. We delete from BOTH stores' rows for the id so
  // no orphan (a vector row without structured fields, or vice versa) survives.
  //
  // EMPTY-READ GUARD (critical): a read of 0 notes while the store holds recipes
  // is the folder-rename / Full-Disk-Access-revoked failure mode — NOT a mass
  // deletion — and reconciling then would WIPE the whole index. So when nothing
  // was read but the store is non-empty we SKIP reconciliation entirely and warn
  // (mirrors the tag-read `null` guard above). A read of 0 into an already-empty
  // store is a harmless no-op. This is deliberately the ONE simple guard; a
  // proportional "dropped > X% of the corpus" guard is intentionally omitted for
  // v1.0 (a legitimate big cleanup shouldn't need an override), and can be added
  // later if real syncs show large partial-read drops.
  let removed = 0;
  let suspiciousEmptyRead = false;
  const readIds = new Set(notes.map((note) => note.id));
  const storedIds = new Set<string>([
    ...deps.store.listIds(),
    ...deps.structuredStore.listIds(),
  ]);

  if (notes.length === 0 && storedIds.size > 0) {
    // Signal the caller (which owns the alert composite) to alert LOUDLY: a
    // console.warn here is not enough — this fingerprint (denied/failed Notes
    // read masquerading as "no recipes") must reach #agent-alerts (fkg.7).
    suspiciousEmptyRead = true;
    console.warn(
      `sync: read 0 notes while the index holds ${storedIds.size} recipe(s); SKIPPING stale-recipe reconciliation (suspected folder rename / permission loss, not a mass delete)`,
    );
  } else {
    const absentIds = [...storedIds].filter((id) => !readIds.has(id));
    if (absentIds.length > 0) {
      deps.store.deleteMany(absentIds);
      deps.structuredStore.deleteMany(absentIds);
      removed = absentIds.length;
      console.warn(
        `sync: reconciliation removed ${removed} stale recipe(s) absent from this sync (deleted or moved out of the recipe folder)`,
      );
    }
  }

  return {
    total: notes.length,
    processed,
    skipped,
    extractionFailures,
    removed,
    suspiciousEmptyRead,
  };
}
