import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CalendarEvent, readCalendarEvents } from "./calendar-reader.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

// Grab the callback as the LAST argument so these helpers work whether
// readCalendarEvents calls execFile as (file, args, cb) or
// (file, args, options, cb).
function lastArgCallback(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

function mockOsascriptStdout(stdout: string) {
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    lastArgCallback(args)(null, stdout, "");
    return undefined;
  }) as unknown as typeof execFile);
}

function mockOsascriptFailure(
  message: string,
  extra: Record<string, unknown> = {},
) {
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    lastArgCallback(args)(
      Object.assign(new Error(message), extra),
      "",
      message,
    );
    return undefined;
  }) as unknown as typeof execFile);
}

afterEach(() => {
  mockedExecFile.mockReset();
});

const WEEK_START = new Date("2026-08-02T00:00:00.000Z");
const WEEK_END = new Date("2026-08-09T00:00:00.000Z");

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    calendarName: "Family",
    title: "Soccer practice",
    start: "2026-08-03T21:00:00.000Z",
    end: "2026-08-03T22:00:00.000Z",
    allDay: false,
    status: "confirmed",
    ...overrides,
  };
}

describe("readCalendarEvents", () => {
  it("invokes osascript with JXA and the requested range as ISO strings", async () => {
    mockOsascriptStdout("[]");

    await readCalendarEvents({ start: WEEK_START, end: WEEK_END });

    expect(mockedExecFile).toHaveBeenCalledWith(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        expect.any(String),
        WEEK_START.toISOString(),
        WEEK_END.toISOString(),
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("bounds the read with a timeout and a generous maxBuffer", async () => {
    mockOsascriptStdout("[]");

    await readCalendarEvents({ start: WEEK_START, end: WEEK_END });

    const options = mockedExecFile.mock.calls[0][2] as {
      timeout?: number;
      maxBuffer?: number;
    };
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it("rejects a range where end is not after start", async () => {
    await expect(
      readCalendarEvents({ start: WEEK_END, end: WEEK_START }),
    ).rejects.toThrow(/must be after/i);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("surfaces an osascript timeout as a clear, actionable error mentioning Calendars permission", async () => {
    mockOsascriptFailure("spawn osascript ETIMEDOUT", {
      killed: true,
      signal: "SIGTERM",
    });

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/timed out/i);
    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/Calendars/);
  });

  it("retries once after a cold-start timeout and returns events from the warm retry (bead r0o.8)", async () => {
    let calls = 0;
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      calls++;
      const cb = lastArgCallback(args);
      if (calls === 1) {
        cb(
          Object.assign(new Error("spawn osascript ETIMEDOUT"), {
            killed: true,
            signal: "SIGTERM",
          }),
          "",
          "",
        );
      } else {
        cb(null, JSON.stringify([rawEvent()]), "");
      }
      return undefined;
    }) as unknown as typeof execFile);

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events).toHaveLength(1);
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });

  it("still throws the actionable timeout error once the bounded retry is exhausted (persistent cold failure)", async () => {
    mockOsascriptFailure("spawn osascript ETIMEDOUT", {
      killed: true,
      signal: "SIGTERM",
    });

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/timed out/i);
    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/Calendars/);
    // 2 attempts per call (the bounded retry), across the 2 calls above.
    expect(mockedExecFile).toHaveBeenCalledTimes(4);
  });

  it("returns an empty array when there are no events", async () => {
    mockOsascriptStdout("[]");

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events).toEqual([]);
  });

  it("parses a single event into a typed CalendarEvent", async () => {
    mockOsascriptStdout(JSON.stringify([rawEvent()]));

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events).toHaveLength(1);
    const [event] = events as [CalendarEvent];
    expect(event).toEqual({
      calendarName: "Family",
      title: "Soccer practice",
      start: new Date("2026-08-03T21:00:00.000Z"),
      end: new Date("2026-08-03T22:00:00.000Z"),
      allDay: false,
      status: "confirmed",
    });
    expect(event.start).toBeInstanceOf(Date);
    expect(event.end).toBeInstanceOf(Date);
  });

  it("parses events from multiple calendars", async () => {
    mockOsascriptStdout(
      JSON.stringify([
        rawEvent({ calendarName: "Jonathan", title: "Dentist" }),
        rawEvent({ calendarName: "Kids", title: "Practice" }),
      ]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.calendarName)).toEqual(["Jonathan", "Kids"]);
  });

  it("marks all-day events with allDay: true", async () => {
    mockOsascriptStdout(
      JSON.stringify([
        rawEvent({
          title: "Out of town",
          start: "2026-08-04T00:00:00.000Z",
          end: "2026-08-05T00:00:00.000Z",
          allDay: true,
        }),
      ]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].allDay).toBe(true);
  });

  it("normalizes a tentative status", async () => {
    mockOsascriptStdout(JSON.stringify([rawEvent({ status: "tentative" })]));

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].status).toBe("tentative");
  });

  it("normalizes both cancelled and canceled spellings to canceled", async () => {
    mockOsascriptStdout(
      JSON.stringify([
        rawEvent({ title: "A", status: "cancelled" }),
        rawEvent({ title: "B", status: "canceled" }),
      ]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events.map((e) => e.status)).toEqual(["canceled", "canceled"]);
  });

  it("normalizes EventKit's no-RSVP 'none' status to confirmed (safe-conservative default)", async () => {
    mockOsascriptStdout(JSON.stringify([rawEvent({ status: "none" })]));

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].status).toBe("confirmed");
  });

  it("normalizes an unrecognized/future status string to confirmed (safe-conservative default)", async () => {
    mockOsascriptStdout(
      JSON.stringify([rawEvent({ status: "some-future-enum-value" })]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].status).toBe("confirmed");
  });

  it("throws a clear error when osascript output is not valid JSON", async () => {
    mockOsascriptStdout("execution error: Calendar got an error");

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/could not parse/i);
  });

  it("throws a clear error when osascript output is valid JSON but not an array", async () => {
    mockOsascriptStdout(JSON.stringify({ not: "an array" }));

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/expected a JSON array/i);
  });

  it("propagates an error when osascript itself fails (e.g. permission denied)", async () => {
    mockOsascriptFailure("execFile: osascript exited with code 1");

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/osascript/i);
  });

  it("preserves special characters (quotes, unicode) in titles round-tripped through JSON", async () => {
    mockOsascriptStdout(
      JSON.stringify([rawEvent({ title: 'Grandma\'s "birthday" party 🎂' })]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].title).toBe('Grandma\'s "birthday" party 🎂');
  });

  it("decodes HTML entities in event titles (Calendar.app's JXA bridge returns entity-encoded titles)", async () => {
    mockOsascriptStdout(
      JSON.stringify([rawEvent({ title: "Dinner &amp; Drinks &lt;3" })]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].title).toBe("Dinner & Drinks <3");
  });
});
