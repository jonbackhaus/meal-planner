import type { LlmClient } from "../llm/llm-client.js";
import type { Embedder } from "./embedder.js";
import type { RawNote } from "./notes-reader.js";
import { readNoteTags } from "./notes-tags.js";
import {
  type SyncResult,
  type SyncStore,
  type SyncStructuredStore,
  syncNotes,
} from "./sync.js";

/**
 * The already-constructed collaborators one `syncNotes` pass needs, in the
 * shape both the daemon (`src/index.ts`) and the standalone CLI
 * (`src/sync-cli.ts`) can supply. Deliberately env-free: the caller resolves
 * the recipe folder (e.g. from `MP_RECIPES_FOLDER`) and passes it as
 * `RunSyncOptions.folderName`, so this module stays trivially unit-testable.
 */
export interface RunSyncDeps {
  /** Reads recipe notes from the source, optionally scoped to a folder. Satisfied by `notes-reader`'s `readNotes`. */
  readNotes: (opts?: { folderName?: string }) => Promise<RawNote[]>;
  embedder: Embedder;
  /** Vector index write surface; satisfied structurally by `VectorStore`. */
  vectorStore: SyncStore;
  /** Structured-field cache; satisfied structurally by `StructuredStore`. */
  structuredStore: SyncStructuredStore;
  llm: LlmClient;
  /** NoteStore hashtag reader; defaults to the real `readNoteTags`. Injectable for hermetic tests. */
  readNoteTags?: () => Map<string, string[]>;
}

export interface RunSyncOptions {
  /** Notes folder to scope the sync to; passed straight to `readNotes` (defaults to notes-reader's own default when omitted). */
  folderName?: string;
}

/**
 * Runs one `syncNotes` pass over the given collaborators, binding
 * `opts.folderName` into `readNotes`. Returns `syncNotes`'s `SyncResult`
 * unchanged. The single wiring point shared by the daemon's auto-sync and the
 * `pnpm sync` CLI — sync internals (hash gates, per-note extraction isolation)
 * live in `sync.ts` and are tested there.
 */
export function runSync(
  deps: RunSyncDeps,
  opts: RunSyncOptions = {},
): Promise<SyncResult> {
  return syncNotes({
    readNotes: () => deps.readNotes({ folderName: opts.folderName }),
    embedder: deps.embedder,
    store: deps.vectorStore,
    structuredStore: deps.structuredStore,
    llm: deps.llm,
    readNoteTags: deps.readNoteTags ?? (() => readNoteTags()),
  });
}
