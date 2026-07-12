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

function execFile(
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args as string[], (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
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
 */
export const NOTES_READER_SCRIPT = `
function run(argv) {
  const folderName = argv[0];
  const Notes = Application("Notes");
  Notes.includeStandardAdditions = true;
  const folders = Notes.folders.whose({ name: folderName });
  if (folders.length === 0) {
    return JSON.stringify([]);
  }
  const notes = folders[0].notes();
  const result = notes.map(function (n) {
    return {
      id: n.id(),
      title: n.name(),
      body: n.body(),
      modifiedAt: n.modificationDate().toISOString(),
    };
  });
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
  const { stdout } = await execFile("osascript", [
    "-l",
    "JavaScript",
    "-e",
    NOTES_READER_SCRIPT,
    folderName,
  ]);
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
