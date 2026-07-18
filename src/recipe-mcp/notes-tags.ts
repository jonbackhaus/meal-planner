import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { normalizeTag } from "./tag-metadata.js";

/**
 * Reads Apple Notes hashtags for every note from the local `NoteStore.sqlite`
 * (bd — NoteStore tags feature). This is the ONE place the app touches the
 * NoteStore DB directly, and deliberately so: hashtags are unreachable via
 * osascript (a note exposes only body/plaintext/name/id/dates), yet SPEC §5.2's
 * whole tag-driven design depends on them. Unlike the note *body* (a fragile
 * gzip'd-protobuf blob we never parse), hashtags live in flat, stable columns
 * (`ZTYPEUTI1`/`ZNOTE1`/`ZALTTEXT`), so a targeted read here is low-risk.
 *
 * Returns a map from the osascript note-id SUFFIX ("p<Z_PK>", e.g. "p10474")
 * to that note's normalized, deduped tags. Keying by the suffix avoids needing
 * the Core Data store UUID: callers match on the trailing segment of the
 * osascript id (`x-coredata://<uuid>/ICNote/p10474`).
 *
 * Fails SOFT but SIGNALLED: a missing/locked/unreadable DB (or absent table)
 * returns `null` plus a single warning, never a throw — a Notes-DB hiccup must
 * not abort a sync. `null` ("read failed") is deliberately DISTINCT from an
 * empty map ("read succeeded, no note has any hashtag"): the caller preserves
 * its cached tags on `null` rather than wiping them all to `[]` (q95.13).
 */

const HASHTAG_UTI = "com.apple.notes.inlinetextattachment.hashtag";

export interface NotesTagsOptions {
  /** Override the NoteStore path (tests / non-default installs). */
  storePath?: string;
}

function defaultStorePath(): string {
  return join(
    homedir(),
    "Library",
    "Group Containers",
    "group.com.apple.notes",
    "NoteStore.sqlite",
  );
}

export function readNoteTags(
  opts: NotesTagsOptions = {},
): Map<string, string[]> | null {
  const storePath = opts.storePath ?? defaultStorePath();
  const byNote = new Map<string, string[]>();

  let db: Database.Database;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    console.warn(
      `notes-tags: could not open NoteStore at "${storePath}" (${(error as Error).message}); returning null so the caller preserves cached tags`,
    );
    return null;
  }

  try {
    const rows = db
      .prepare(
        "SELECT ZNOTE1 AS note, ZALTTEXT AS tag FROM ZICCLOUDSYNCINGOBJECT " +
          "WHERE ZTYPEUTI1 = ? AND ZNOTE1 IS NOT NULL AND ZALTTEXT IS NOT NULL",
      )
      .all(HASHTAG_UTI) as Array<{ note: number; tag: string }>;

    for (const row of rows) {
      const tag = normalizeTag(String(row.tag));
      if (tag === null) {
        continue;
      }
      const key = `p${row.note}`;
      const existing = byNote.get(key);
      if (existing === undefined) {
        byNote.set(key, [tag]);
      } else if (!existing.includes(tag)) {
        existing.push(tag);
      }
    }
  } catch (error) {
    console.warn(
      `notes-tags: failed reading hashtags from NoteStore (${(error as Error).message}); returning null so the caller preserves cached tags`,
    );
    return null;
  } finally {
    db.close();
  }

  return byNote;
}

/** Extracts the "p<N>" suffix from an osascript note id (`x-coredata://…/ICNote/p10474` -> "p10474"). */
export function noteIdSuffix(noteId: string): string {
  const slash = noteId.lastIndexOf("/");
  return slash >= 0 ? noteId.slice(slash + 1) : noteId;
}
