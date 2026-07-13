/**
 * The composite `#agent-alerts` notifier (SPEC §9.4, E6). This is what
 * `main()` binds to the orchestrator's `AlertFn` (`generate.ts`'s
 * `alert: (message: string) => Promise<void>`), which is called from
 * `generateForWeek`'s/`onStartup`'s catch/alert paths -- so `makeAlert`'s
 * returned function must NEVER THROW: an alert failure must not mask the
 * original error or crash the daemon.
 *
 * Two independent side effects are attempted every call:
 *   1. `appendLocal(message)` -- the durable local log on disk, ALWAYS.
 *   2. `slackAlert(message)`, if provided (post mode only; omitted entirely
 *      in dry-run so no #agent-alerts post happens).
 * Each is wrapped in its own try/catch: a Slack failure must not stop (or
 * undo) the local log write, and vice-versa -- they are attempted
 * independently, and any failure is only ever logged (`logger.error`),
 * never re-thrown.
 */

export interface MakeAlertDeps {
  /** Durable local log append (`appendLog` bound to a path/clock) -- synchronous, may throw. */
  appendLocal: (message: string) => void;
  /** The real Slack alerts post (`SlackAlerter.alert`), OMITTED in dry-run. */
  slackAlert?: (message: string) => Promise<void>;
  /** Injectable for tests; defaults to `console`. */
  logger?: Pick<Console, "warn" | "error">;
}

export function makeAlert(
  deps: MakeAlertDeps,
): (message: string) => Promise<void> {
  const { appendLocal, slackAlert, logger = console } = deps;

  return async (message: string) => {
    logger.warn(`[agent-alert] ${message}`);

    try {
      appendLocal(message);
    } catch (err) {
      logger.error(`[agent-alert] local log append failed: ${String(err)}`);
    }

    if (slackAlert) {
      try {
        await slackAlert(message);
      } catch (err) {
        logger.error(`[agent-alert] Slack post failed: ${String(err)}`);
      }
    }
  };
}
