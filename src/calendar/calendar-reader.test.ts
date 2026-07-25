import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CalendarEvent, readCalendarEvents } from "./calendar-reader.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

const EXPECTED_BINARY_PATH = fileURLToPath(
  new URL("../../native/ekreader", import.meta.url),
);

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

function mockEkreaderStdout(stdout: string) {
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    lastArgCallback(args)(null, stdout, "");
    return undefined;
  }) as unknown as typeof execFile);
}

function mockEkreaderFailure(
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
  delete process.env.MP_EKREADER_PATH;
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
  it("invokes the native/ekreader binary with the requested range as ISO strings", async () => {
    mockEkreaderStdout("[]");

    await readCalendarEvents({ start: WEEK_START, end: WEEK_END });

    expect(mockedExecFile).toHaveBeenCalledWith(
      EXPECTED_BINARY_PATH,
      [WEEK_START.toISOString(), WEEK_END.toISOString()],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("bounds the read with a timeout and a generous maxBuffer", async () => {
    mockEkreaderStdout("[]");

    await readCalendarEvents({ start: WEEK_START, end: WEEK_END });

    const options = mockedExecFile.mock.calls[0][2] as {
      timeout?: number;
      maxBuffer?: number;
    };
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it("sets the ekreader timeout to 20s (EventKit is ms-fast, generous headroom for a huge calendar)", async () => {
    mockEkreaderStdout("[]");

    await readCalendarEvents({ start: WEEK_START, end: WEEK_END });

    const options = mockedExecFile.mock.calls[0][2] as { timeout?: number };
    expect(options.timeout).toBe(20_000);
  });

  it("rejects a range where end is not after start", async () => {
    await expect(
      readCalendarEvents({ start: WEEK_END, end: WEEK_START }),
    ).rejects.toThrow(/must be after/i);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("maps an ekreader timeout to a clear, actionable error", async () => {
    mockEkreaderFailure("spawn ekreader ETIMEDOUT", {
      killed: true,
      signal: "SIGTERM",
    });

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/timed out/i);
  });

  it("maps ekreader exit code 3 (TCC denial) to a clear, actionable error mentioning the grant, not a hang", async () => {
    mockEkreaderFailure("Command failed with exit code 3", { code: 3 });

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/Calendars access not granted/i);
  });

  it("maps ENOENT (binary not built) to a clear error pointing at pnpm build:native", async () => {
    mockEkreaderFailure("spawn native/ekreader ENOENT", { code: "ENOENT" });

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/pnpm build:native/i);
  });

  it("propagates a non-timeout, non-TCC, non-ENOENT ekreader failure as-is", async () => {
    mockEkreaderFailure("Command failed with exit code 1");

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/exit code 1/i);
  });

  it("returns an empty array when there are no events", async () => {
    mockEkreaderStdout("[]");

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events).toEqual([]);
  });

  it("parses a single event into a typed CalendarEvent", async () => {
    mockEkreaderStdout(JSON.stringify([rawEvent()]));

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
    mockEkreaderStdout(
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
    mockEkreaderStdout(
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
    mockEkreaderStdout(JSON.stringify([rawEvent({ status: "tentative" })]));

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].status).toBe("tentative");
  });

  it("normalizes both cancelled and canceled spellings to canceled", async () => {
    mockEkreaderStdout(
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
    mockEkreaderStdout(JSON.stringify([rawEvent({ status: "none" })]));

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].status).toBe("confirmed");
  });

  it("normalizes an unrecognized/future status string to confirmed (safe-conservative default)", async () => {
    mockEkreaderStdout(
      JSON.stringify([rawEvent({ status: "some-future-enum-value" })]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].status).toBe("confirmed");
  });

  it("throws a clear error when ekreader output is not valid JSON", async () => {
    mockEkreaderStdout("not json");

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/could not parse/i);
  });

  it("throws a clear error when ekreader output is valid JSON but not an array", async () => {
    mockEkreaderStdout(JSON.stringify({ not: "an array" }));

    await expect(
      readCalendarEvents({ start: WEEK_START, end: WEEK_END }),
    ).rejects.toThrow(/expected a JSON array/i);
  });

  it("preserves special characters (quotes, unicode) in titles round-tripped through JSON", async () => {
    mockEkreaderStdout(
      JSON.stringify([rawEvent({ title: 'Grandma\'s "birthday" party 🎂' })]),
    );

    const events = await readCalendarEvents({
      start: WEEK_START,
      end: WEEK_END,
    });

    expect(events[0].title).toBe('Grandma\'s "birthday" party 🎂');
  });

  it("respects MP_EKREADER_PATH to override the resolved binary path", async () => {
    process.env.MP_EKREADER_PATH = "/custom/path/to/ekreader";
    mockEkreaderStdout("[]");

    await readCalendarEvents({ start: WEEK_START, end: WEEK_END });

    expect(mockedExecFile).toHaveBeenCalledWith(
      "/custom/path/to/ekreader",
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
  });

  describe("calendarNames scoping (bead swl)", () => {
    it("passes the calendar names through to ekreader as trailing args", async () => {
      mockEkreaderStdout("[]");

      await readCalendarEvents({
        start: WEEK_START,
        end: WEEK_END,
        calendarNames: ["Family Schedule", "Appointments"],
      });

      expect(mockedExecFile).toHaveBeenCalledWith(
        EXPECTED_BINARY_PATH,
        [
          WEEK_START.toISOString(),
          WEEK_END.toISOString(),
          "Family Schedule",
          "Appointments",
        ],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("still parses events normally when calendarNames is provided", async () => {
      mockEkreaderStdout(JSON.stringify([rawEvent()]));

      const events = await readCalendarEvents({
        start: WEEK_START,
        end: WEEK_END,
        calendarNames: ["Family Schedule"],
      });

      expect(events).toHaveLength(1);
      expect(events[0].calendarName).toBe("Family");
    });

    it("an empty calendarNames array short-circuits to [] without invoking ekreader", async () => {
      const events = await readCalendarEvents({
        start: WEEK_START,
        end: WEEK_END,
        calendarNames: [],
      });

      expect(events).toEqual([]);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it("omitted calendarNames keeps the back-compat all-calendars invocation (no trailing args)", async () => {
      mockEkreaderStdout("[]");

      await readCalendarEvents({ start: WEEK_START, end: WEEK_END });

      expect(mockedExecFile).toHaveBeenCalledWith(
        EXPECTED_BINARY_PATH,
        [WEEK_START.toISOString(), WEEK_END.toISOString()],
        expect.any(Object),
        expect.any(Function),
      );
    });
  });
});
