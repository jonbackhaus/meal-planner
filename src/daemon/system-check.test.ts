import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSystemSleepDisabled,
  parseSleepDisabled,
} from "./system-check.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function mockPmset(stdout: string) {
  mockedExecFile.mockImplementation(((
    _file: string,
    _args: readonly string[],
    callback: ExecFileCallback,
  ) => {
    callback(null, stdout, "");
    return undefined;
  }) as unknown as typeof execFile);
}

function mockPmsetFailure(message: string) {
  mockedExecFile.mockImplementation(((
    _file: string,
    _args: readonly string[],
    callback: ExecFileCallback,
  ) => {
    callback(new Error(message), "", message);
    return undefined;
  }) as unknown as typeof execFile);
}

const SLEEP_DISABLED_OUTPUT = `System-wide power settings:
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatemode         3
 powernap              1
 disksleep             10
 sleep                 0
 ttyskeepawake         1
 displaysleep          10
 womp                  1
`;

const SLEEP_ENABLED_OUTPUT = `System-wide power settings:
Currently in use:
 standby              1
 disksleep             10
 sleep                 10
 displaysleep          10
`;

afterEach(() => {
  mockedExecFile.mockReset();
});

describe("parseSleepDisabled", () => {
  it("returns true when the sleep line is 0", () => {
    expect(parseSleepDisabled(SLEEP_DISABLED_OUTPUT)).toBe(true);
  });

  it("returns false when the sleep line is a positive number", () => {
    expect(parseSleepDisabled(SLEEP_ENABLED_OUTPUT)).toBe(false);
  });

  it("does not confuse a 'disksleep' line with the 'sleep' line", () => {
    const output = " disksleep             0\n sleep                 5\n";
    expect(parseSleepDisabled(output)).toBe(false);
  });

  it("returns false when no sleep line is present", () => {
    expect(parseSleepDisabled("nothing relevant here")).toBe(false);
  });

  it("returns true when the sleep line has a trailing annotation (e.g. caffeinate)", () => {
    // Observed real macOS output: pmset appends "(sleep prevented by ...)"
    // after the value when something is currently holding a sleep
    // assertion, even though the underlying setting is still sleep=0.
    const output = " sleep                0 (sleep prevented by caffeinate)\n";
    expect(parseSleepDisabled(output)).toBe(true);
  });
});

describe("checkSystemSleepDisabled", () => {
  it("reports disabled: true and the raw output when pmset reports sleep 0", async () => {
    mockPmset(SLEEP_DISABLED_OUTPUT);

    const result = await checkSystemSleepDisabled();

    expect(result.disabled).toBe(true);
    expect(result.raw).toBe(SLEEP_DISABLED_OUTPUT);
    expect(mockedExecFile).toHaveBeenCalledWith(
      "pmset",
      ["-g"],
      expect.any(Function),
    );
  });

  it("reports disabled: false when pmset reports a positive sleep value", async () => {
    mockPmset(SLEEP_ENABLED_OUTPUT);

    const result = await checkSystemSleepDisabled();

    expect(result.disabled).toBe(false);
    expect(result.raw).toBe(SLEEP_ENABLED_OUTPUT);
  });

  it("never throws: reports disabled: false with no raw output when pmset itself fails", async () => {
    mockPmsetFailure("execFile: pmset ENOENT");

    const result = await checkSystemSleepDisabled();

    expect(result.disabled).toBe(false);
    expect(result.raw).toBeUndefined();
  });
});
