import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ExtractedFields } from "./extraction.js";
import { DEFAULT_VECTOR_STORE_PATH } from "./vector-store.js";

/**
 * Structured-field cache for the recipe MCP server (ADR 0001 D1): persists,
 * per note, the result of the ingest-time LLM extraction pass
 * (`extraction.ts`), keyed by note id, gated on a content hash + the
 * extractor version.
 *
 * Lives in the SAME sqlite db FILE as `VectorStore` (per ADR 0001 — the
 * recipe server owns one local db file for its index + structured cache),
 * but as its own connection + table (`structured_fields`), independent of
 * `VectorStore`'s `notes`/`vec_notes` tables — mirrors how `VectorStore`
 * itself opens its own `better-sqlite3` connection. Two connections to the
 * same file are safe under WAL (which both stores enable).
 */

/** Bump this to force re-extraction of every note on the next sync, even when a note's body hash is unchanged. */
export const EXTRACTOR_VERSION = 2;

export interface StructuredStoreOptions {
  /** Database file path — same file as the VectorStore. Default: DEFAULT_VECTOR_STORE_PATH. Use ":memory:" for tests. */
  path?: string;
}

/** The extraction-owned portion of a structured record (LLM output + its cache keys). */
export interface UpsertStructuredInput {
  contentHash: string;
  extractorVersion: number;
  /** null when extraction has never succeeded for this note (e.g. a needs_review-only record after a failed attempt). */
  fields: ExtractedFields | null;
  needsReview: boolean;
  /**
   * Count of CONSECUTIVE extraction failures for the current body+extractor
   * version (q95.7). Drives sync.ts's attempt cap: a deterministically-failing
   * note stops being re-extracted once this reaches the cap, until its body (and
   * thus `contentHash`) changes. Omitted on write == 0 (backward-compat with
   * pre-field rows / callers that don't track it).
   */
  failedAttempts?: number;
}

export interface StructuredRecord extends UpsertStructuredInput {
  /** Always populated on read (defaults to 0 for pre-field rows). */
  failedAttempts: number;
  /**
   * The note's Apple Notes hashtags (normalized), sourced from NoteStore and
   * written independently of extraction (`upsertTags`) — they can change
   * without the recipe body changing. `[]` when the note has none / never
   * synced tags. Merged over the LLM extraction at query time (search.ts).
   */
  tags: string[];
}

interface StructuredFieldsRow {
  content_hash: string;
  extractor_version: number;
  fields_json: string | null;
  needs_review: number;
  failed_attempts: number;
  tags_json: string | null;
}

export class StructuredStore {
  private readonly db: Database.Database;

  constructor(options: StructuredStoreOptions = {}) {
    const path = options.path ?? DEFAULT_VECTOR_STORE_PATH;

    if (path !== ":memory:") {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS structured_fields (
        note_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        extractor_version INTEGER NOT NULL,
        fields_json TEXT,
        needs_review INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Migrations: add newer columns to pre-existing DBs. SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so guard on the current column set. Both
    // columns carry defaults so pre-migration rows read back cleanly ([] tags,
    // 0 failed attempts).
    const columns = (
      this.db.prepare("PRAGMA table_info(structured_fields)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    if (!columns.includes("tags_json")) {
      this.db.exec("ALTER TABLE structured_fields ADD COLUMN tags_json TEXT");
    }
    if (!columns.includes("failed_attempts")) {
      this.db.exec(
        "ALTER TABLE structured_fields ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  /** The stored structured record for a note id, or null if never upserted. */
  getStructured(noteId: string): StructuredRecord | null {
    const row = this.db
      .prepare(
        "SELECT content_hash, extractor_version, fields_json, needs_review, failed_attempts, tags_json FROM structured_fields WHERE note_id = ?",
      )
      .get(noteId) as StructuredFieldsRow | undefined;
    if (!row) {
      return null;
    }
    return {
      contentHash: row.content_hash,
      extractorVersion: row.extractor_version,
      fields: row.fields_json
        ? (JSON.parse(row.fields_json) as ExtractedFields)
        : null,
      needsReview: row.needs_review !== 0,
      failedAttempts: row.failed_attempts ?? 0,
      tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : [],
    };
  }

  /** Insert or replace the structured record for a note id (keyed by note_id, one row per note). */
  upsertStructured(noteId: string, record: UpsertStructuredInput): void {
    this.db
      .prepare(
        `INSERT INTO structured_fields (note_id, content_hash, extractor_version, fields_json, needs_review, failed_attempts)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           extractor_version = excluded.extractor_version,
           fields_json = excluded.fields_json,
           needs_review = excluded.needs_review,
           failed_attempts = excluded.failed_attempts`,
      )
      .run(
        noteId,
        record.contentHash,
        record.extractorVersion,
        record.fields ? JSON.stringify(record.fields) : null,
        record.needsReview ? 1 : 0,
        record.failedAttempts ?? 0,
      );
  }

  /**
   * Writes a note's NoteStore hashtags, independent of the extraction record —
   * tags can change (user edits a hashtag) without the recipe body changing,
   * so sync updates them every pass while the (expensive) LLM extraction stays
   * body-hash-gated. Creates a tags-only row (null extraction) if the note has
   * no structured record yet; on an existing row it touches ONLY `tags_json`,
   * preserving any extraction already there.
   */
  upsertTags(noteId: string, tags: string[]): void {
    this.db
      .prepare(
        `INSERT INTO structured_fields (note_id, content_hash, extractor_version, fields_json, needs_review, tags_json)
         VALUES (?, '', 0, NULL, 0, ?)
         ON CONFLICT(note_id) DO UPDATE SET tags_json = excluded.tags_json`,
      )
      .run(noteId, JSON.stringify(tags));
  }

  close(): void {
    this.db.close();
  }
}
