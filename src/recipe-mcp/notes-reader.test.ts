import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentHash,
  DEFAULT_RECIPES_FOLDER,
  readNotes,
  stripHtml,
} from "./notes-reader.js";

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
// readNotes calls execFile as (file, args, cb) or (file, args, options, cb).
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

describe("readNotes", () => {
  it("invokes osascript with JXA and the default folder name", async () => {
    mockOsascriptStdout("[]");

    await readNotes();

    expect(mockedExecFile).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-e", expect.any(String), DEFAULT_RECIPES_FOLDER],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("bounds the read with a timeout and a large maxBuffer (guards hangs + big corpora)", async () => {
    mockOsascriptStdout("[]");

    await readNotes();

    const options = mockedExecFile.mock.calls[0][2] as {
      timeout?: number;
      maxBuffer?: number;
    };
    expect(options.timeout).toBeGreaterThan(0);
    // 798 recipe bodies blow past execFile's 1 MB default; needs to be large.
    expect(options.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it("surfaces an osascript timeout as a clear, actionable error", async () => {
    // Node marks a timed-out child with killed=true (+ SIGTERM).
    mockOsascriptFailure("spawn osascript ETIMEDOUT", {
      killed: true,
      signal: "SIGTERM",
    });

    await expect(readNotes()).rejects.toThrow(/timed out/i);
  });

  it("passes a custom folder name through to osascript", async () => {
    mockOsascriptStdout("[]");

    await readNotes({ folderName: "My Recipes" });

    expect(mockedExecFile).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-e", expect.any(String), "My Recipes"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns an empty array when there are no notes", async () => {
    mockOsascriptStdout("[]");

    const notes = await readNotes();

    expect(notes).toEqual([]);
  });

  it("parses a single note into a typed RawNote", async () => {
    mockOsascriptStdout(
      JSON.stringify([
        {
          id: "x-coredata://abc/ICNote/p1",
          title: "Weeknight Chili",
          body: "<div>Ground beef, beans, chili powder.</div>",
          modifiedAt: "2026-01-15T12:00:00.000Z",
        },
      ]),
    );

    const notes = await readNotes();

    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({
      id: "x-coredata://abc/ICNote/p1",
      title: "Weeknight Chili",
      body: "Ground beef, beans, chili powder.",
      modifiedAt: new Date("2026-01-15T12:00:00.000Z"),
    });
    expect(notes[0].modifiedAt).toBeInstanceOf(Date);
  });

  it("parses multiple notes", async () => {
    mockOsascriptStdout(
      JSON.stringify([
        {
          id: "note-1",
          title: "Soup",
          body: "<div>broth</div>",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "note-2",
          title: "Salad",
          body: "<div>greens</div>",
          modifiedAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
    );

    const notes = await readNotes();

    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.id)).toEqual(["note-1", "note-2"]);
  });

  it("preserves special characters (quotes, unicode, embedded newlines) round-tripped through JSON", async () => {
    const trickyBody =
      '<div>2 cups flour "type 00"</div><div>1 tsp salt — crème fraîche, jalapeño 🌶️</div>';
    mockOsascriptStdout(
      JSON.stringify([
        {
          id: "note-1",
          title: 'Grandma\'s "Famous" Bread',
          body: trickyBody,
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    const notes = await readNotes();

    expect(notes[0].title).toBe('Grandma\'s "Famous" Bread');
    expect(notes[0].body).toContain('2 cups flour "type 00"');
    expect(notes[0].body).toContain("crème fraîche, jalapeño 🌶️");
  });

  it("throws a clear error when osascript output is not valid JSON", async () => {
    mockOsascriptStdout("execution error: Notes got an error");

    await expect(readNotes()).rejects.toThrow(/could not parse/i);
  });

  it("throws a clear error when osascript output is valid JSON but not an array", async () => {
    mockOsascriptStdout(JSON.stringify({ not: "an array" }));

    await expect(readNotes()).rejects.toThrow(/expected a JSON array/i);
  });

  it("propagates an error when osascript itself fails (e.g. permission denied)", async () => {
    mockOsascriptFailure("execFile: osascript exited with code 1");

    await expect(readNotes()).rejects.toThrow(/osascript/i);
  });
});

describe("stripHtml", () => {
  it("removes tags and collapses to plain text lines", () => {
    expect(stripHtml("<div>Hello</div><div>World</div>")).toBe("Hello\nWorld");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("<div>Salt &amp; pepper &mdash; to taste</div>")).toBe(
      "Salt & pepper &mdash; to taste",
    );
  });

  it("drops blank lines produced by tag removal", () => {
    expect(stripHtml("<div><br></div><div>Text</div>")).toBe("Text");
  });

  it("returns an empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});

describe("contentHash", () => {
  it("is stable for the same body", () => {
    const a = contentHash({ body: "same body text" });
    const b = contentHash({ body: "same body text" });
    expect(a).toBe(b);
  });

  it("differs for different bodies", () => {
    const a = contentHash({ body: "body one" });
    const b = contentHash({ body: "body two" });
    expect(a).not.toBe(b);
  });

  it("produces a hex string", () => {
    const hash = contentHash({ body: "anything" });
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});
