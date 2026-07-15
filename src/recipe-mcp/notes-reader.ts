import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Apple Notes reader (recipe MCP server data-ingestion foundation).
 *
 * Reads recipe notes from Apple Notes via `osascript` — the documented,
 * permission-gated automation path (never parses NoteStore.sqlite directly).
 *
 * Implementation choice: the script passed to `osascript` is JavaScript for
 * Automation (`-l JavaScript`), not classic AppleScript source. Both are
 * "AppleScript" in the OSA (Open Scripting Architecture) sense — same
 * `osascript` binary, same Notes automation permission prompt — but JXA lets
 * the script return `JSON.stringify(...)` directly, which is far more robust
 * for note bodies containing quotes/newlines/unicode than delimiter-based
 * AppleScript text output.
 *
 * "Recipe" scoping: notes are read from a single named Notes folder
 * (default "Recipes", configurable via `NotesReaderOptions.folderName`).
 * This keeps scoping simple and user-controlled: file recipe notes under
 * that folder in Notes and they're picked up; anything else is ignored.
 */

/** A single note as read from Apple Notes, before any structured extraction. */
export interface RawNote {
  id: string;
  title: string;
  body: string;
  modifiedAt: Date;
}

export interface NotesReaderOptions {
  /** Name of the Notes folder to scope "recipe" notes to. Default: "Recipes". */
  folderName?: string;
}

export const DEFAULT_RECIPES_FOLDER = "Recipes";

interface RawNoteJson {
  id: string;
  title: string;
  body: string;
  modifiedAt: string;
}

/**
 * Read timeout for the osascript call. Bulk property reads make a healthy read
 * fast (~seconds), but a first-run macOS automation-permission prompt can stall
 * `osascript` indefinitely; this bounds that so a hang surfaces as a clear error
 * instead of blocking the daemon/CLI forever.
 */
const READ_TIMEOUT_MS = 180_000;

/**
 * stdout buffer cap for the osascript call. A large Notes folder (hundreds of
 * recipe bodies) easily exceeds execFile's 1 MB default, which would otherwise
 * fail the read with "maxBuffer exceeded". 64 MB comfortably covers a big
 * corpus.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

interface ExecFileOpts {
  timeout: number;
  maxBuffer: number;
}

function execFile(
  file: string,
  args: readonly string[],
  options: ExecFileOpts,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      file,
      args as string[],
      options,
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

// Very small HTML-to-text pass: Notes.app note bodies are HTML source. We
// don't need (or want) a full HTML parser dependency here — the structured
// extraction pass (q95.3) works off this plain-ish text, not markup — so
// this strips tags and decodes a small, common set of entities.
const HTML_TAG_PATTERN = /<[^>]*>/g;
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function stripHtml(html: string): string {
  const withoutTags = html.replace(HTML_TAG_PATTERN, "\n");
  const decoded = withoutTags.replace(
    /&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  );
  return decoded
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/**
 * The JXA source executed by `osascript -l JavaScript`. Receives the folder
 * name as `argv[0]` and prints a JSON array of `{id, title, body,
 * modifiedAt}` to stdout. `body` is the raw HTML note body; callers of
 * `readNotes` strip it to plain text via `stripHtml`.
 *
 * Performance + robustness (bd meal-planner-q95.9). Two problems with the naive
 * `notes.map(n => ({ id: n.id(), body: n.body(), ... }))`:
 *
 *   1. One Apple Event PER property PER note (4 x N round-trips) — on a real
 *      corpus (~800 notes at ~70ms/event) that takes minutes and effectively
 *      hangs. Fixed by reading each property in BULK (one Apple Event across all
 *      notes).
 *   2. `note.body()` returns the note's rich-text HTML, which on real recipes
 *      embeds full-resolution images as base64 data URIs — ~350 KB PER note,
 *      hundreds of MB across the folder. That overflows the read buffer and
 *      makes `JSON.stringify` fail (silently returning an empty result), and a
 *      single un-coercible note poisons a whole-collection `body()` read
 *      (AppleEvent -1741). Fixed by reading `note.plaintext()` instead: the
 *      text-only view (no markup, no images), ~1.8 KB/note, which is exactly
 *      what the downstream extraction/embedding wants anyway (the old code
 *      immediately stripped the HTML to text via `stripHtml`).
 *
 * Folder lookup iterates accounts and matches on the TRIMMED folder name, so a
 * stray trailing space in a Notes folder name (a common cause of a silent empty
 * read) still matches, and account-scoped folders are found.
 */
export const NOTES_READER_SCRIPT = `
function run(argv) {
  const target = String(argv[0] == null ? "" : argv[0]).trim();
  const Notes = Application("Notes");
  Notes.includeStandardAdditions = true;

  var folder = null;
  var accounts = Notes.accounts();
  for (var a = 0; a < accounts.length && !folder; a++) {
    var folders = accounts[a].folders();
    for (var i = 0; i < folders.length; i++) {
      var fname = "";
      try { fname = String(folders[i].name()).trim(); } catch (e) { continue; }
      if (fname === target) { folder = folders[i]; break; }
    }
  }
  if (!folder) { return JSON.stringify([]); }

  var notes = folder.notes;
  var count = notes.length;
  if (count === 0) { return JSON.stringify([]); }

  var ids = notes.id();
  var names = notes.name();
  var mods = notes.modificationDate();
  var texts = notes.plaintext();

  var result = new Array(count);
  for (var k = 0; k < count; k++) {
    var iso;
    try { iso = mods[k].toISOString(); } catch (e3) { iso = new Date(0).toISOString(); }
    result[k] = {
      id: String(ids[k]),
      title: names[k] == null ? "" : String(names[k]),
      body: texts[k] == null ? "" : String(texts[k]),
      modifiedAt: iso
    };
  }
  return JSON.stringify(result);
}
`;

function parseNotesJson(stdout: string): RawNoteJson[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `notes-reader: could not parse osascript output as JSON: ${(error as Error).message}\noutput was: ${trimmed}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `notes-reader: expected a JSON array from osascript, got: ${trimmed}`,
    );
  }
  return parsed as RawNoteJson[];
}

/**
 * Reads recipe notes from Apple Notes (scoped to a single folder) via
 * `osascript -l JavaScript`. Returns typed, plain-text-bodied `RawNote[]`.
 */
export async function readNotes(
  options: NotesReaderOptions = {},
): Promise<RawNote[]> {
  const folderName = options.folderName ?? DEFAULT_RECIPES_FOLDER;
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      "osascript",
      ["-l", "JavaScript", "-e", NOTES_READER_SCRIPT, folderName],
      { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
    ));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean };
    if (err.killed || err.code === "ETIMEDOUT") {
      throw new Error(
        `notes-reader: reading Apple Notes folder "${folderName}" timed out after ${READ_TIMEOUT_MS}ms. Notes may be prompting for automation permission — grant the terminal/daemon control of Notes and retry.`,
      );
    }
    throw error;
  }
  const rawNotes = parseNotesJson(stdout);
  return rawNotes.map((note) => ({
    id: note.id,
    title: note.title,
    body: stripHtml(note.body),
    modifiedAt: new Date(note.modifiedAt),
  }));
}

/**
 * Stable content hash of a note's body, used to hash-gate re-embedding /
 * re-extraction (sync.ts skips a note whose stored hash still matches).
 */
export function contentHash(note: Pick<RawNote, "body">): string {
  return createHash("sha256").update(note.body, "utf8").digest("hex");
}
