/**
 * External dead-man switch (bd meal-planner-fkg.8, SPEC §9.4). The daemon's
 * own alert channel lives INSIDE the process that might die, so nothing
 * external notices a total outage (crash, wedged host, launchd not
 * relaunching). This is a healthchecks.io-style ping: on each SUCCESSFUL
 * weekly trigger the daemon pings a check URL, and the external service
 * alerts if a ping is ever MISSED. RATIFIED to ALSO ping the `<url>/fail`
 * sub-path on a caught generation failure (defense-in-depth: external
 * visibility of a failed-but-alive run, independent of the internal alert).
 *
 * Best-effort by contract: a heartbeat must NEVER be able to break or delay a
 * real run. Every operation swallows its own errors (network failure, non-2xx,
 * timeout) after a short, redacted log line -- it never throws or rejects. The
 * check URL is a mild shared secret (its path is effectively a token), so the
 * full URL is NEVER logged; only a redacted reason is.
 *
 * Clock policy mirrors the rest of the codebase: no `Date.now()`/`new Date()`
 * is read here. The only timer is an `AbortController` deadline (a duration,
 * not a wall-clock value), which is allowed.
 */

/** The two dead-man operations, injected into the daemon composition root. */
export interface Heartbeat {
  /** Ping the base URL -- "the weekly trigger fired and the host is alive". */
  success(): Promise<void>;
  /** POST the `<url>/fail` sub-path -- "a generation run was caught failing". */
  fail(): Promise<void>;
}

export interface MakeHeartbeatOptions {
  /** Abort deadline for a single ping, ms. Default 10s. */
  timeoutMs?: number;
  /**
   * Sink for the (redacted, secret-free) failure line. Defaults to
   * `console.warn`. Injected so tests can assert on it without capturing
   * stdout, matching the Scheduler's `{ warn }` logger convention.
   */
  logger?: { warn: (message: string) => void };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Builds a redacted, secret-free reason for a failed ping. Deliberately does
 * NOT surface `error.message` -- a fetch/DNS failure message can embed the
 * check URL (a shared secret). An abort maps to a timeout note; any other
 * Error is reported by its class name only (`TypeError`, etc.).
 */
function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return `timeout after ${timeoutMs}ms`;
    }
    return error.name;
  }
  return "unknown error";
}

/**
 * Strips a single trailing slash so `<url>/fail` never doubles up (the base
 * URL may or may not carry one).
 */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Constructs a {@link Heartbeat}. When `url` is undefined or empty the feature
 * is DISABLED: both operations are immediate no-ops that make no network call.
 * Otherwise each operation POSTs (with an `AbortController` timeout) and
 * swallows every error after a redacted `warn` line -- it never throws.
 */
export function makeHeartbeat(
  url: string | undefined,
  opts: MakeHeartbeatOptions = {},
): Heartbeat {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn =
    opts.logger?.warn ?? ((message: string) => console.warn(message));
  const base = url === undefined || url === "" ? undefined : url;

  async function ping(target: string, label: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(target, { method: "POST", signal: controller.signal });
    } catch (error) {
      warn(
        `healthcheck ${label} ping failed: ${describeError(error, timeoutMs)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async success(): Promise<void> {
      if (base === undefined) {
        return;
      }
      await ping(base, "success");
    },
    async fail(): Promise<void> {
      if (base === undefined) {
        return;
      }
      await ping(`${stripTrailingSlash(base)}/fail`, "fail");
    },
  };
}
