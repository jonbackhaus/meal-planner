import { execFile as execFileCallback } from "node:child_process";

/**
 * Local calendar reader (ADR-0004 D1, bead r0o.1).
 *
 * Reads events from Calendar.app via `osascript` — the same ownership/shape
 * as the Apple Notes reader (`../recipe-mcp/notes-reader.ts`): shell out to
 * JXA (`osascript -l JavaScript`), have the script print a JSON array to
 * stdout, parse + type it here. No native EventKit binding, no new runtime
 * dependency.
 *
 * **Why this reads as "via EventKit" (ADR-0004 D1) despite being JXA:**
 * Calendar.app's scripting bridge is itself built on EventKit, and macOS
 * gates it with the **"Calendars"** TCC (Transparency, Consent & Control)
 * category specifically — not the generic "Automation" category the Notes
 * reader triggers for Notes.app. Same subprocess shape, different (and, per
 * ADR-0004 D1, more specific) permission surface. See RUNBOOK §0.1/§7 for the
 * grant procedure.
 *
 * **Scope — allowlist-scoped by default caller, all-calendars if omitted
 * (ADR-0004 D1, amended bead swl):** callers pass `calendarNames`
 * (`CalendarConfig.include[].name`) to scope the JXA query to only those
 * calendars — Apple Scripting-Bridge `.whose()` date queries are slow, and
 * unscoped reads across every subscribed/shared iCloud calendar intermittently
 * exceed the read timeout (bead swl). When `calendarNames` is omitted, this
 * reader falls back to the original read-ALL-calendars behavior (back-compat
 * for any direct caller that hasn't opted in). Classifying capacity
 * (ADR-0004 D3) remains a downstream concern owned by the classifier (bead
 * r0o.3) — this module only reads and types raw events.
 */

/**
 * Confirmation status of a calendar event, as classified from EventKit's
 * status enum via Calendar.app scripting.
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
   * bead swl). When omitted/undefined, reads every calendar Calendar.app
   * aggregates (the original, slower ADR-0004 D1 behavior — kept for
   * back-compat). An empty array queries nothing and short-circuits to `[]`
   * without invoking `osascript`, consistent with "empty allowlist marks no
   * night busy".
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
 * Read timeout for the osascript call. Mirrors `notes-reader.ts`'s reasoning:
 * a first-run "Calendars" permission prompt can stall `osascript`
 * indefinitely with no way to answer it under launchd — this bounds that so
 * a hang surfaces as a clear, actionable error instead of blocking the
 * daemon forever. A healthy allowlist-scoped read (bead swl) measured ~17.5s
 * — Apple Scripting-Bridge is fundamentally slow, not sub-second. Set to 25s:
 * enough headroom over the ~17s healthy read, but low enough that a hanging
 * read (a subscribed iCloud calendar mid-refresh — observed 90s+) DEGRADES to
 * the static schedule FAST rather than stalling the run for minutes. Reading
 * the calendar is best-effort (ADR-0004 D6 degrade-don't-fail); a slow read is
 * not worth blocking the Sunday post. Still bounded/retried by `MAX_READ_ATTEMPTS`.
 */
const READ_TIMEOUT_MS = 25_000;

/**
 * stdout buffer cap for the osascript call. A week's worth of events across
 * every subscribed calendar is tiny (a few KB of JSON) compared to a full
 * Notes recipe corpus, but this stays generous for the same reason
 * `notes-reader.ts` does: a maxBuffer overflow fails the read silently rather
 * than loudly.
 */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Bounded retry count for a timed-out read (bead r0o.8): 1 initial attempt +
 * 1 retry. Live verification showed the FIRST `readCalendarEvents` call
 * against a cold Calendar.app can exceed `READ_TIMEOUT_MS`, while an
 * immediate retry against the now-warm app succeeds in under a second.
 * Under launchd there's no warm app and no one to retry by hand, so a single
 * bounded internal retry absorbs that one-time cold-start cost without
 * risking an unbounded hang: total worst case is `MAX_READ_ATTEMPTS *
 * READ_TIMEOUT_MS`, still finite. A retry only fires on the
 * timeout/killed case (below) — any other osascript failure (e.g. a TCC
 * denial, malformed output) is not transient and still surfaces on the
 * first attempt.
 */
const MAX_READ_ATTEMPTS = 2;

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

/**
 * The JXA source executed by `osascript -l JavaScript`. Receives the range's
 * start/end as ISO-8601 strings in `argv[0]`/`argv[1]`, an optional
 * JSON-encoded array of calendar names to scope to in `argv[2]` (bead swl),
 * and prints a JSON array of `{calendarName, title, start, end, allDay,
 * status}` to stdout.
 *
 * When `argv[2]` names calendars, they're fetched directly via
 * `Calendar.calendars.byName(name)` (wrapped in try/catch so a
 * configured-but-absent calendar is skipped, not thrown) — NOT by
 * enumerating every calendar and filtering by `.name()`, which is a large
 * part of what makes an unscoped read slow. When `argv[2]` is absent/empty,
 * this falls back to enumerating every calendar Calendar.app exposes (the
 * original ADR-0004 D1 all-calendars behavior). Each calendar's and each
 * event's property reads are wrapped individually so one mis-behaving
 * calendar/event (a degenerate recurrence, a share with a transient read
 * error) can't fail the whole read — it's just skipped, mirroring the Notes
 * reader's per-note-property defensiveness.
 */
export const CALENDAR_READER_SCRIPT = `
function run(argv) {
  var rangeStart = new Date(String(argv[0]));
  var rangeEnd = new Date(String(argv[1]));

  var names = null;
  if (argv.length > 2 && String(argv[2]).length > 0) {
    try { names = JSON.parse(String(argv[2])); } catch (eNames) { names = null; }
  }

  var Calendar = Application("Calendar");
  Calendar.includeStandardAdditions = true;

  var result = [];

  function readCalendar(cal, calName) {
    var events;
    try {
      events = cal.events.whose({
        _and: [
          { startDate: { _lessThan: rangeEnd } },
          { endDate: { _greaterThan: rangeStart } }
        ]
      })();
    } catch (e2) { return; }

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var s, en;
      try { s = ev.startDate(); } catch (e3) { continue; }
      try { en = ev.endDate(); } catch (e4) { continue; }

      var title = "";
      try { title = String(ev.summary()); } catch (e5) {}

      var allDay = false;
      try { allDay = Boolean(ev.alldayEvent()); } catch (e6) {}

      var status = "confirmed";
      try { status = String(ev.status()); } catch (e7) {}

      result.push({
        calendarName: calName,
        title: title,
        start: s.toISOString(),
        end: en.toISOString(),
        allDay: allDay,
        status: status
      });
    }
  }

  if (names) {
    for (var n = 0; n < names.length; n++) {
      var cal, calName;
      try {
        cal = Calendar.calendars.byName(String(names[n]));
        calName = String(cal.name());
      } catch (eByName) { continue; }
      readCalendar(cal, calName);
    }
  } else {
    var calendars = Calendar.calendars();
    for (var c = 0; c < calendars.length; c++) {
      var calNameAll;
      try { calNameAll = String(calendars[c].name()); } catch (e) { continue; }
      readCalendar(calendars[c], calNameAll);
    }
  }

  return JSON.stringify(result);
}
`;

/**
 * Decodes the standard five HTML/XML entities plus numeric character
 * references (`&#NN;`, `&#xNN;`). Calendar.app's JXA scripting bridge
 * returns event titles/calendar names HTML-entity-encoded (e.g.
 * `Mercato Italian Kitchen &amp; Bar`), and `title` feeds the Slack render
 * and a future LLM interpretation layer (ADR-0004) — decode at parse time
 * rather than adding a new runtime dependency for five well-known entities.
 */
function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|#39|#x27|#(\d+)|#x([0-9a-fA-F]+));/g,
    (match, entity: string, decimal?: string, hex?: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "#39":
        case "#x27":
          return "'";
        default:
          if (decimal !== undefined) {
            return String.fromCodePoint(Number.parseInt(decimal, 10));
          }
          if (hex !== undefined) {
            return String.fromCodePoint(Number.parseInt(hex, 16));
          }
          return match;
      }
    },
  );
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
      `calendar-reader: could not parse osascript output as JSON: ${(error as Error).message}\noutput was: ${trimmed}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `calendar-reader: expected a JSON array from osascript, got: ${trimmed}`,
    );
  }
  return parsed as RawCalendarEventJson[];
}

/**
 * Normalizes Calendar.app's raw status string to `CalendarEventStatus`.
 *
 * Only an explicit "tentative" or "cancelled"/"canceled" (Apple's scripting
 * dictionaries are inconsistent about the double-L) map away from the
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
 * Reads calendar events scoped to `[options.start, options.end)`, via
 * `osascript -l JavaScript`. When `options.calendarNames` is given (bead
 * swl), the JXA queries only those calendars — a large speedup and
 * reliability fix over reading every calendar Calendar.app aggregates
 * (ADR-0004 D1's original, unscoped behavior, still the fallback when
 * `calendarNames` is omitted). An empty `calendarNames` array queries
 * nothing and returns `[]` without invoking `osascript`. Returns typed
 * `CalendarEvent[]` — capacity classification remains the downstream
 * classifier's job (ADR-0004 D3, bead r0o.3).
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

  const scriptArgs =
    calendarNames !== undefined
      ? [
          "-l",
          "JavaScript",
          "-e",
          CALENDAR_READER_SCRIPT,
          start.toISOString(),
          end.toISOString(),
          JSON.stringify(calendarNames),
        ]
      : [
          "-l",
          "JavaScript",
          "-e",
          CALENDAR_READER_SCRIPT,
          start.toISOString(),
          end.toISOString(),
        ];

  let stdout: string | undefined;
  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
    try {
      ({ stdout } = await execFile("osascript", scriptArgs, {
        timeout: READ_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
      }));
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { killed?: boolean };
      if (!(err.killed || err.code === "ETIMEDOUT")) {
        throw error;
      }
      // Cold-start timeout (bead r0o.8): retry once against the now-warm
      // Calendar.app before surfacing the actionable error below.
      if (attempt < MAX_READ_ATTEMPTS) {
        continue;
      }
      throw new Error(
        `calendar-reader: reading Calendar.app events timed out after ${READ_TIMEOUT_MS}ms. Calendar.app may be prompting for the "Calendars" automation permission — grant the terminal/daemon Calendars access (RUNBOOK §0.1) and retry.`,
      );
    }
  }
  // Unreachable: the loop above either assigns `stdout` and breaks, or
  // throws. Narrows the type for the parse step below.
  if (stdout === undefined) {
    throw new Error("calendar-reader: unreachable — no stdout and no error");
  }

  const rawEvents = parseCalendarEventsJson(stdout);
  return rawEvents.map((event) => ({
    calendarName: decodeHtmlEntities(event.calendarName),
    title: decodeHtmlEntities(event.title),
    start: new Date(event.start),
    end: new Date(event.end),
    allDay: event.allDay,
    status: normalizeStatus(event.status),
  }));
}
