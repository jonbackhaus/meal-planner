import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/**
 * Vector store for the recipe MCP server's local index (ADR 0001: the
 * recipe server owns its own index + structured-field cache, a database
 * file separate from the E3 session DB).
 *
 * Backed by `better-sqlite3` + the `sqlite-vec` extension. Two tables:
 *  - `notes`: metadata companion table (id, title, body, hash, modified_at),
 *    keyed by an integer `rowid` that also serves as the primary key of the
 *    vec0 virtual table (vec0 requires integer rowids bound as BigInt).
 *  - `vec_notes`: a `vec0` virtual table holding the embedding, using
 *    `distance_metric=cosine` so `1 - distance` is a cosine-similarity score.
 *
 * `exclude_ids` filtering happens in application code (post-query), not in
 * the vec0 KNN `WHERE` clause: vec0 requires a bare `MATCH ... AND k = ?` (or
 * `LIMIT`) knn constraint with no other predicates on the same table in the
 * same query (verified against the installed sqlite-vec version) — so we
 * over-fetch by the exclusion count and filter/slice afterward.
 */

export interface NoteMeta {
  title: string;
  body: string;
  hash: string;
  modifiedAt: Date;
}

export interface SearchResult {
  id: string;
  title: string;
  score: number;
}

/** Minimal note-metadata shape returned by `getNote` (id/title/body only — no hash/modifiedAt). */
export interface StoredNote {
  id: string;
  title: string;
  body: string;
}

export interface SearchOptions {
  limit?: number;
  exclude_ids?: string[];
}

export interface VectorStoreOptions {
  /** Database file path. Default: "./data/recipe-index.sqlite". Use ":memory:" for an ephemeral store (tests). */
  path?: string;
  /** Embedding vector dimensionality. Default: 384 (Xenova/all-MiniLM-L6-v2). */
  dimensions?: number;
}

export const DEFAULT_VECTOR_STORE_PATH = "./data/recipe-index.sqlite";
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

const DEFAULT_SEARCH_LIMIT = 10;

interface NoteRow {
  rowid: number;
  id: string;
  hash: string;
}

interface SearchRow {
  id: string;
  title: string;
  distance: number;
}

export class VectorStore {
  private readonly db: Database.Database;
  private readonly dimensions: number;

  constructor(options: VectorStoreOptions = {}) {
    const path = options.path ?? DEFAULT_VECTOR_STORE_PATH;
    this.dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new Error(
        `VectorStore: dimensions must be a positive integer, got ${this.dimensions}`,
      );
    }

    if (path !== ":memory:") {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(
        embedding float[${this.dimensions}] distance_metric=cosine
      );
    `);
  }

  /**
   * Insert or update a note's embedding + metadata, keyed by its stable
   * Apple Notes `id`. New ids get a fresh integer rowid (shared by the
   * metadata row and the vec0 row); existing ids are updated in place.
   */
  upsert(id: string, vector: number[], meta: NoteMeta): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `VectorStore.upsert: vector has ${vector.length} dimensions, expected ${this.dimensions}`,
      );
    }
    const embedding = new Float32Array(vector);
    const modifiedAt = meta.modifiedAt.toISOString();

    const existing = this.db
      .prepare("SELECT rowid FROM notes WHERE id = ?")
      .get(id) as { rowid: number } | undefined;

    const upsertTx = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            "UPDATE notes SET title = ?, body = ?, hash = ?, modified_at = ? WHERE rowid = ?",
          )
          .run(meta.title, meta.body, meta.hash, modifiedAt, existing.rowid);
        this.db
          .prepare("UPDATE vec_notes SET embedding = ? WHERE rowid = ?")
          .run(embedding, BigInt(existing.rowid));
      } else {
        const info = this.db
          .prepare(
            "INSERT INTO notes (id, title, body, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, meta.title, meta.body, meta.hash, modifiedAt);
        this.db
          .prepare("INSERT INTO vec_notes (rowid, embedding) VALUES (?, ?)")
          .run(BigInt(info.lastInsertRowid), embedding);
      }
    });
    upsertTx();
  }

  /** The stored content hash for a note id, or undefined if never upserted (hash-gate primitive for sync.ts). */
  getStoredHash(id: string): string | undefined {
    const row = this.db
      .prepare("SELECT hash FROM notes WHERE id = ?")
      .get(id) as Pick<NoteRow, "hash"> | undefined;
    return row?.hash;
  }

  /**
   * Every note id currently in the index (stale-recipe reconciliation,
   * q95.14). The authoritative set sync diffs against the ids it just read, to
   * find rows whose source note was deleted / moved out of the recipe folder.
   */
  listIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM notes").all() as Array<
      Pick<NoteRow, "id">
    >;
    return rows.map((r) => r.id);
  }

  /**
   * Hard-delete the given note ids from BOTH the metadata table and the vec0
   * embedding table (stale-recipe reconciliation, q95.14). Deleting the `notes`
   * row alone would orphan the `vec_notes` embedding (which shares the integer
   * rowid) — it would keep matching in `search` while its metadata JOIN returns
   * nothing. Unknown/absent ids are skipped; an empty list is a no-op. Wrapped
   * in one transaction so the two tables never diverge on a mid-batch failure.
   */
  deleteMany(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const selectRowid = this.db.prepare("SELECT rowid FROM notes WHERE id = ?");
    const deleteVec = this.db.prepare("DELETE FROM vec_notes WHERE rowid = ?");
    const deleteNote = this.db.prepare("DELETE FROM notes WHERE rowid = ?");
    const deleteTx = this.db.transaction((toDelete: string[]) => {
      for (const id of toDelete) {
        const row = selectRowid.get(id) as { rowid: number } | undefined;
        if (!row) {
          continue;
        }
        deleteVec.run(BigInt(row.rowid));
        deleteNote.run(row.rowid);
      }
    });
    deleteTx(ids);
  }

  /** The stored id/title/body for a note id, or null if never upserted (note-metadata accessor for get_recipe). */
  getNote(id: string): StoredNote | null {
    const row = this.db
      .prepare("SELECT id, title, body FROM notes WHERE id = ?")
      .get(id) as StoredNote | undefined;
    return row ?? null;
  }

  /**
   * Nearest-neighbor search by cosine similarity. Returns candidates ordered
   * by descending score (`1 - cosine distance`), most similar first.
   */
  search(queryVector: number[], options: SearchOptions = {}): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `VectorStore.search: query vector has ${queryVector.length} dimensions, expected ${this.dimensions}`,
      );
    }
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    const excludeIds = new Set(options.exclude_ids ?? []);
    // Over-fetch to account for post-filtering excluded ids (vec0 knn
    // queries don't support additional predicates alongside MATCH/k).
    const fetchLimit = limit + excludeIds.size;

    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.title AS title, v.distance AS distance
         FROM vec_notes v
         JOIN notes n ON n.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
      )
      .all(new Float32Array(queryVector), fetchLimit) as SearchRow[];

    return rows
      .filter((row) => !excludeIds.has(row.id))
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        title: row.title,
        score: 1 - row.distance,
      }));
  }

  close(): void {
    this.db.close();
  }
}
