import { execFile as execFileCallback } from "node:child_process";

/**
 * Ops helper (SPEC §9.4): checks whether the host's system `sleep` setting
 * is disabled via `pmset -g`. The in-process weekly Scheduler depends on the
 * machine staying awake — there is no launchd calendar job to "catch" a
 * missed trigger caused by the Mac sleeping through it. On boot the daemon
 * calls this and WARNs (logs, does not throw) if sleep is enabled; this
 * module never throws on its own, so a boot-time WARN can never crash boot.
 */

/** Result of a `pmset -g` sleep-setting check. */
export interface SystemSleepStatus {
  /** Whether system sleep is disabled (pmset -g reports a "sleep" value of 0). */
  disabled: boolean;
  /** Raw stdout from `pmset -g`, for diagnostics/logging. Undefined if the check itself could not run (e.g. `pmset` missing, non-macOS host). */
  raw?: string;
}

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function execFile(
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      file,
      args as string[],
      ((error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }) as ExecFileCallback,
    );
  });
}

// Note: real `pmset -g` output can append an annotation after the numeric
// value, e.g. `sleep                0 (sleep prevented by caffeinate)` — the
// pattern deliberately does NOT anchor at end-of-line so that annotated
// lines still parse correctly.
const SLEEP_LINE_PATTERN = /^\s*sleep\s+(\d+)/m;

/**
 * Parses `pmset -g` output for the top-level "sleep" setting line and
 * returns whether its value is 0 (disabled). Returns false (i.e. "not
 * confirmed disabled") if no matching line is found.
 */
export function parseSleepDisabled(pmsetOutput: string): boolean {
  const match = SLEEP_LINE_PATTERN.exec(pmsetOutput);
  if (!match) {
    return false;
  }
  return Number(match[1]) === 0;
}

/**
 * Runs `pmset -g` and reports whether system sleep is disabled. Never
 * throws: if the command itself fails to run (missing binary, non-macOS
 * host, permissions, etc.), resolves with `{ disabled: false, raw: undefined
 * }` so callers can WARN rather than crash boot.
 */
export async function checkSystemSleepDisabled(): Promise<SystemSleepStatus> {
  try {
    const { stdout } = await execFile("pmset", ["-g"]);
    return { disabled: parseSleepDisabled(stdout), raw: stdout };
  } catch {
    return { disabled: false, raw: undefined };
  }
}
