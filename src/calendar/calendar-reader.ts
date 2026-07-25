import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Local calendar reader (ADR-0004 D1, bead ob8).
 *
 * Reads events from Calendar.app via a small compiled Swift helper
 * (`native/ekreader`) that talks to **native EventKit**
 * (`EKEventStore.events(matching:)`) directly — no Scripting-Bridge/JXA in
 * the hot path. Same subprocess-and-parse-JSON shape as before (and as the
 * Apple Notes reader, `../recipe-mcp/notes-reader.ts`): shell out, have the
 * binary print a JSON array to stdout, parse + type it here.
 *
 * **Why this replaced the original `osascript`/JXA backend (bead swl → ob8):**
 * Calendar.app's Scripting-Bridge `.whose()` date queries are fundamentally
 * slow — even scoped to a 2-calendar allowlist a read measured ~17.5s, and an
 * unscoped read (or one hitting a mid-refresh subscribed iCloud calendar)
 * could hang 90s+. Native EventKit reads the same data in milliseconds, and
 * fails fast (~0s, exit code 3) on a TCC denial instead of hanging — a
 * strictly better fit for a launchd daemon with no UI to answer a stalled
 * permission prompt. ADR-0004 D1 nominally said "via EventKit" from the
 * start; JXA was always the shortcut this replaces.
 *
 * **TCC grant now keys on the `native/ekreader` binary, not `node`** — see
 * RUNBOOK §0.1 item 3 / §8.1.
 *
 * **Scope — allowlist-scoped by default caller, all-calendars if omitted
 * (ADR-0004 D1, amended bead swl):** callers pass `calendarNames`
 * (`CalendarConfig.include[].name`) to scope the read to only those
 * calendars. When `calendarNames` is omitted, this reader reads every
 * calendar EventKit exposes (back-compat for any direct caller that hasn't
 * opted in). Classifying capacity (ADR-0004 D3) remains a downstream concern
 * owned by the classifier (bead r0o.3) — this module only reads and types
 * raw events.
 */

/**
 * Confirmation status of a calendar event, as reported by EventKit's status
 * enum.
 *
 * `"confirmed"` is also the default for events with no explicit RSVP
 * semantics (EventKit's "none" status) — the common case for a household's
 * own calendar entries, which aren't meeting invites and so never carry an
 * explicit status. Treating them as `"confirmed"` is the safe-conservative
 * choice: a plain personal event is a real commitment.
 *
 * Whether `"tentative"` events count toward reduced cooking capacity is a
 * downstream classifier decision (ratified in bead 7o5: count
 * confirmed + tentative, ignore canceled) — this reader only reports status,
 * it does not filter by it.
 */
export type CalendarEventStatus = "confirmed" | "tentative" | "canceled";

/**
 * A single calendar event as read from Calendar.app, before any
 * classification. This is the seam the event→capacity classifier (ADR-0004
 * D3, bead r0o.3) consumes: `calendarName` is matched against
 * `CalendarConfig.include[].name` to find the event's `role` (bead r0o.2),
 * `start`/`end`/`allDay` are what the classifier overlaps against
 * `CalendarConfig.cookingWindow` (D3 — "all-day events cover the window"),
 * and `status` lets the classifier decide which events count (bead 7o5).
 */
export interface CalendarEvent {
  /** Raw Calendar.app calendar name, e.g. "Jonathan", "Family", "Kids". */
  calendarName: string;
  /** Raw event title, for the render + a future LLM interpretation layer. */
  title: string;
  start: Date;
  end: Date;
  /** All-day events are assumed to cover any cooking window (ADR-0004 D3). */
  allDay: boolean;
  status: CalendarEventStatus;
}

export interface CalendarReaderOptions {
  /** Inclusive lower bound of the query range. */
  start: Date;
  /** Exclusive upper bound of the query range. */
  end: Date;
  /**
   * Scope the read to only these calendar names (`CalendarConfig.include[].name`,
   * bead swl). When omitted/undefined, reads every calendar EventKit exposes
   * (the original ADR-0004 D1 behavior — kept for back-compat). An empty
   * array queries nothing and short-circuits to `[]` without invoking the
   * native reader, consistent with "empty allowlist marks no night busy".
   */
  calendarNames?: string[];
}

interface RawCalendarEventJson {
  calendarName: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: string;
}

/**
 * Read timeout for the `native/ekreader` call. Native EventKit reads return
 * in milliseconds (unlike the retired osascript/Scripting-Bridge backend,
 * which measured ~17.5s even allowlist-scoped) — this stays generous headroom
 * for a very large calendar/household rather than a tight bound, since the
 * cold-start rationale that justified a long osascript timeout no longer
 * applies.
 */
const READ_TIMEOUT_MS = 20_000;

/**
 * stdout buffer cap for the `native/ekreader` call. A week's worth of events
 * across every subscribed calendar is tiny (a few KB of JSON), but this stays
 * generous for the same reason `notes-reader.ts` does: a maxBuffer overflow
 * fails the read silently rather than loudly.
 */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Path to the compiled native EventKit reader binary, resolved relative to
 * this module so it works regardless of the process's cwd (mirrors how
 * `notes-reader.ts` resolves its own local resources). From
 * `dist/calendar/calendar-reader.js`, the repo root is two levels up, so the
 * binary lives at `<root>/native/ekreader` (built by `pnpm build:native`, not
 * part of `pnpm build`/CI — see CLAUDE.md). `MP_EKREADER_PATH` overrides this
 * for tests/alternate layouts.
 */
function resolveEkreaderPath(): string {
  if (process.env.MP_EKREADER_PATH) {
    return process.env.MP_EKREADER_PATH;
  }
  return fileURLToPath(new URL("../../native/ekreader", import.meta.url));
}

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

function parseCalendarEventsJson(stdout: string): RawCalendarEventJson[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `calendar-reader: could not parse ekreader output as JSON: ${(error as Error).message}\noutput was: ${trimmed}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `calendar-reader: expected a JSON array from ekreader, got: ${trimmed}`,
    );
  }
  return parsed as RawCalendarEventJson[];
}

/**
 * Normalizes EventKit's raw status string (as reported by `native/ekreader`)
 * to `CalendarEventStatus`.
 *
 * Only an explicit "tentative" or "cancelled"/"canceled" map away from the
 * default. Anything else — including EventKit's "none" (no RSVP semantics,
 * the common case for a household's own entries) and any unrecognized future
 * value — is treated as `"confirmed"`: the safe-conservative default,
 * consistent with ADR-0004 D6's degrade-never-fail stance (an unrecognized
 * status still counts as a real commitment rather than being silently
 * dropped).
 */
function normalizeStatus(raw: string): CalendarEventStatus {
  const value = raw.trim().toLowerCase();
  if (value === "tentative") {
    return "tentative";
  }
  if (value === "cancelled" || value === "canceled") {
    return "canceled";
  }
  return "confirmed";
}

/**
 * Reads calendar events scoped to `[options.start, options.end)`, via the
 * compiled native EventKit helper (`native/ekreader`, bead ob8). When
 * `options.calendarNames` is given (bead swl), the reader queries only those
 * calendars — an empty `calendarNames` array queries nothing and returns
 * `[]` without invoking the binary. Returns typed `CalendarEvent[]` —
 * capacity classification remains the downstream classifier's job
 * (ADR-0004 D3, bead r0o.3).
 */
export async function readCalendarEvents(
  options: CalendarReaderOptions,
): Promise<CalendarEvent[]> {
  const { start, end, calendarNames } = options;
  if (!(end.getTime() > start.getTime())) {
    throw new Error(
      `calendar-reader: options.end (${end.toISOString()}) must be after options.start (${start.toISOString()})`,
    );
  }
  if (calendarNames !== undefined && calendarNames.length === 0) {
    return [];
  }

  const binaryPath = resolveEkreaderPath();
  const args = [
    start.toISOString(),
    end.toISOString(),
    ...(calendarNames ?? []),
  ];

  let stdout: string;
  try {
    ({ stdout } = await execFile(binaryPath, args, {
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    }));
  } catch (error) {
    const err = error as Error & {
      killed?: boolean;
      code?: string | number;
    };

    if (err.code === "ENOENT") {
      throw new Error(
        "calendar-reader: native/ekreader not built — run `pnpm build:native` (RUNBOOK).",
      );
    }
    if (err.code === 3) {
      throw new Error(
        "calendar-reader: Calendars access not granted for the ekreader binary — grant it (RUNBOOK §0.1) — DEGRADES fast, no hang.",
      );
    }
    if (err.killed || err.code === "ETIMEDOUT") {
      throw new Error(
        `calendar-reader: reading Calendar.app events via native/ekreader timed out after ${READ_TIMEOUT_MS}ms.`,
      );
    }
    throw error;
  }

  const rawEvents = parseCalendarEventsJson(stdout);
  return rawEvents.map((event) => ({
    calendarName: event.calendarName,
    title: event.title,
    start: new Date(event.start),
    end: new Date(event.end),
    allDay: event.allDay,
    status: normalizeStatus(event.status),
  }));
}
