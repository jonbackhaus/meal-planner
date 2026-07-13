import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A clock injected for determinism -- returns the `Date` to stamp a log line
 * with. Real callers pass `() => new Date()`; tests pass a fixed instant.
 */
export type NowDateFn = () => Date;

/**
 * Durable, append-only, timestamped local log on disk (SPEC §9.4): a
 * complete record of every alert even if Slack is unreachable. Appends one
 * `${iso}\t${message}\n` line to `path`, creating the file and any missing
 * intermediate directories as needed.
 *
 * Synchronous (mirrors this repo's other on-disk-store bootstrap pattern --
 * `VectorStore`/`StructuredStore`/`SessionStore` all `mkdirSync` their parent
 * dir the same way) so a caller in a catch-block doesn't need to juggle
 * another await; a single log append is cheap enough not to need async I/O.
 *
 * Never writes anything beyond `path` + `message` -- no secret is written
 * unless the caller passes one, which none of this project's call sites do.
 */
export function appendLog(path: string, message: string, now: NowDateFn): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const line = `${now().toISOString()}\t${message}\n`;
  appendFileSync(path, line, "utf8");
}
