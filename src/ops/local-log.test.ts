import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLog } from "./local-log.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("appendLog", () => {
  it("appends a single timestamped line, creating the file", () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-local-log-"));
    const path = join(dir, "alerts.log");

    appendLog(
      path,
      "generation failed for 2026-W29",
      () => new Date("2026-01-01T00:00:00.000Z"),
    );

    const contents = readFileSync(path, "utf8");
    expect(contents).toBe(
      "2026-01-01T00:00:00.000Z\tgeneration failed for 2026-W29\n",
    );
  });

  it("appends subsequent calls rather than overwriting", () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-local-log-"));
    const path = join(dir, "alerts.log");

    appendLog(path, "first", () => new Date("2026-01-01T00:00:00.000Z"));
    appendLog(path, "second", () => new Date("2026-01-01T00:00:01.000Z"));

    const contents = readFileSync(path, "utf8");
    expect(contents).toBe(
      "2026-01-01T00:00:00.000Z\tfirst\n" +
        "2026-01-01T00:00:01.000Z\tsecond\n",
    );
  });

  it("creates intermediate directories that don't exist yet", () => {
    dir = mkdtempSync(join(tmpdir(), "meal-planner-local-log-"));
    const path = join(dir, "nested", "deeper", "alerts.log");

    appendLog(path, "hello", () => new Date("2026-01-01T00:00:00.000Z"));

    const contents = readFileSync(path, "utf8");
    expect(contents).toBe("2026-01-01T00:00:00.000Z\thello\n");
  });
});
