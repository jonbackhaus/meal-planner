import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentHash,
  DEFAULT_RECIPES_FOLDER,
  normalizeNoteBody,
  readNotes,
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
          body: "Ground beef, beans, chili powder.",
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

  it("preserves angle-bracket recipe text (never strips `<...>` spans), only normalizing whitespace", async () => {
    // `note.plaintext()` returns plain text, NOT HTML. A prior stripHtml pass
    // (regexing out `<...>`) silently DELETED everything between a literal `<`
    // and the next `>`, corrupting real recipe text like `simmer <10 min` ...
    // `> 2 cups flour` (bd meal-planner-q95.16). The #20 guard is that this
    // angle-bracket content MUST survive. bd meal-planner-5ww re-added the safe
    // WHITESPACE cleanup that stripHtml also used to do (trim lines, drop
    // blanks) — so the body is no longer byte-for-byte verbatim, but every
    // `<...>` character is still present, untouched.
    const body =
      "  simmer <10 min, keep temp < 300F  \n\nrest, then fold in\n\t> 2 cups flour & a pinch of salt  ";
    mockOsascriptStdout(
      JSON.stringify([
        {
          id: "note-angle",
          title: "Quick Flatbread",
          body,
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    const notes = await readNotes();

    // The `<...>` recipe text survives verbatim (the #20 invariant)...
    expect(notes[0].body).toContain("simmer <10 min, keep temp < 300F");
    expect(notes[0].body).toContain("> 2 cups flour & a pinch of salt");
    // ...while surrounding whitespace is normalized (the 5ww addition).
    expect(notes[0].body).toBe(
      "simmer <10 min, keep temp < 300F\nrest, then fold in\n> 2 cups flour & a pinch of salt",
    );
  });

  it("parses multiple notes", async () => {
    mockOsascriptStdout(
      JSON.stringify([
        {
          id: "note-1",
          title: "Soup",
          body: "broth",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "note-2",
          title: "Salad",
          body: "greens",
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
      '2 cups flour "type 00"\n1 tsp salt — crème fraîche, jalapeño 🌶️';
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

describe("normalizeNoteBody", () => {
  it("trims leading/trailing whitespace from each line", () => {
    expect(normalizeNoteBody("  ground beef  \n\t1 tsp salt \t")).toBe(
      "ground beef\n1 tsp salt",
    );
  });

  it("drops blank/whitespace-only lines", () => {
    expect(normalizeNoteBody("broth\n   \ngreens")).toBe("broth\ngreens");
  });

  it("collapses runs of blank lines", () => {
    expect(normalizeNoteBody("step one\n\n\n\nstep two")).toBe(
      "step one\nstep two",
    );
  });

  it("leaves already-clean text unchanged", () => {
    const clean = "ground beef\nbeans\nchili powder";
    expect(normalizeNoteBody(clean)).toBe(clean);
  });

  it("preserves angle-bracket recipe text, normalizing only surrounding whitespace", () => {
    // The #20 invariant (bd meal-planner-q95.16): NEVER strip `<...>` spans.
    expect(
      normalizeNoteBody("  simmer <10 min  \n\n\n  > 2 cups flour  "),
    ).toBe("simmer <10 min\n> 2 cups flour");
  });

  it("does not decode HTML entities or collapse intra-line whitespace", () => {
    // JXA plaintext has no entities to decode; intra-line runs are out of scope.
    expect(normalizeNoteBody("  salt &amp; pepper   to  taste  ")).toBe(
      "salt &amp; pepper   to  taste",
    );
  });

  it("returns an empty string for all-blank input", () => {
    expect(normalizeNoteBody("\n  \n\t\n")).toBe("");
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
