import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readNoteTags } from "./notes-tags.js";

const HASHTAG_UTI = "com.apple.notes.inlinetextattachment.hashtag";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notestore-fixture-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Builds a minimal NoteStore-shaped fixture DB with the columns readNoteTags queries. */
function buildFixture(
  rows: Array<{ uti: string; note: number | null; tag: string | null }>,
): string {
  const path = join(dir, "NoteStore.sqlite");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZTYPEUTI1 TEXT, ZNOTE1 INTEGER, ZALTTEXT TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO ZICCLOUDSYNCINGOBJECT (ZTYPEUTI1, ZNOTE1, ZALTTEXT) VALUES (?, ?, ?)",
  );
  for (const r of rows) insert.run(r.uti, r.note, r.tag);
  db.close();
  return path;
}

describe("readNoteTags", () => {
  it("maps note-id suffix (p<ZNOTE1>) -> normalized tags, ignoring non-hashtag rows", () => {
    const storePath = buildFixture([
      { uti: HASHTAG_UTI, note: 10474, tag: "#side" },
      { uti: HASHTAG_UTI, note: 10474, tag: "#5stars" },
      { uti: HASHTAG_UTI, note: 639, tag: "#dinner" },
      // non-hashtag attachment: must be ignored
      { uti: "com.apple.notes.table", note: 639, tag: "#nope" },
      // empty/malformed tag: dropped by normalizeTag
      { uti: HASHTAG_UTI, note: 639, tag: "" },
      { uti: HASHTAG_UTI, note: 639, tag: "#5-" },
    ]);

    const map = readNoteTags({ storePath });

    expect(map.get("p10474")?.sort()).toEqual(["5-stars", "side"]);
    expect(map.get("p639")).toEqual(["dinner"]);
    expect([...map.keys()].sort()).toEqual(["p10474", "p639"]);
  });

  it("dedupes repeated tags on the same note", () => {
    const storePath = buildFixture([
      { uti: HASHTAG_UTI, note: 1, tag: "#side" },
      { uti: HASHTAG_UTI, note: 1, tag: "#Side" },
      { uti: HASHTAG_UTI, note: 1, tag: "#doahead" },
      { uti: HASHTAG_UTI, note: 1, tag: "#do-ahead" },
    ]);

    expect(readNoteTags({ storePath }).get("p1")?.sort()).toEqual([
      "do-ahead",
      "side",
    ]);
  });

  it("fails soft (empty map + warn, no throw) when the store file is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const map = readNoteTags({ storePath: join(dir, "does-not-exist.sqlite") });

    expect(map.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
