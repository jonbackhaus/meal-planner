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
export const EXTRACTOR_VERSION = 1;

export interface StructuredStoreOptions {
  /** Database file path — same file as the VectorStore. Default: DEFAULT_VECTOR_STORE_PATH. Use ":memory:" for tests. */
  path?: string;
}

export interface StructuredRecord {
  contentHash: string;
  extractorVersion: number;
  /** null when extraction has never succeeded for this note (e.g. a needs_review-only record after a failed attempt). */
  fields: ExtractedFields | null;
  needsReview: boolean;
}

export type UpsertStructuredInput = StructuredRecord;

interface StructuredFieldsRow {
  content_hash: string;
  extractor_version: number;
  fields_json: string | null;
  needs_review: number;
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
  }

  /** The stored structured record for a note id, or null if never upserted. */
  getStructured(noteId: string): StructuredRecord | null {
    const row = this.db
      .prepare(
        "SELECT content_hash, extractor_version, fields_json, needs_review FROM structured_fields WHERE note_id = ?",
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
    };
  }

  /** Insert or replace the structured record for a note id (keyed by note_id, one row per note). */
  upsertStructured(noteId: string, record: UpsertStructuredInput): void {
    this.db
      .prepare(
        `INSERT INTO structured_fields (note_id, content_hash, extractor_version, fields_json, needs_review)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           extractor_version = excluded.extractor_version,
           fields_json = excluded.fields_json,
           needs_review = excluded.needs_review`,
      )
      .run(
        noteId,
        record.contentHash,
        record.extractorVersion,
        record.fields ? JSON.stringify(record.fields) : null,
        record.needsReview ? 1 : 0,
      );
  }

  close(): void {
    this.db.close();
  }
}
