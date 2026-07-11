import { loadConfig } from "./config/config.js";
import { resolveProfile } from "./config/profile.js";
import { runDaemon } from "./daemon/daemon.js";
import { withTimeout } from "./daemon/with-timeout.js";
import { getScaffoldVersion } from "./lib/version.js";
import { loadSecrets } from "./secrets/secrets.js";

/**
 * Boot secret loading with a timeout (carried over from the secrets review,
 * bd note on meal-planner-7js.6): a hung `op` CLI must not hang boot
 * forever. See `src/daemon/with-timeout.ts`.
 */
const SECRETS_LOAD_TIMEOUT_MS = 15_000;

/**
 * Placeholder startup hook. E3 (ADR 0002) supplies the real startup
 * catch-up decision logic (checking whether this week's plan is missing
 * and needs to be generated after a reboot near the trigger). This module
 * must not implement that logic itself — see task brief scope boundary.
 */
async function placeholderOnStartup(): Promise<void> {
  console.log(
    "onStartup: no-op placeholder (E3/ADR 0002 supplies startup catch-up logic)",
  );
}

/**
 * Placeholder trigger hook. E3 (ADR 0002) supplies the real
 * `generateForWeek` plan-generation call. This module must not implement
 * that logic itself — see task brief scope boundary.
 */
async function placeholderOnTrigger(): Promise<void> {
  console.log(
    "onTrigger: no-op placeholder (E3/ADR 0002 supplies generateForWeek)",
  );
}

export async function main(): Promise<void> {
  console.log(`meal-planner daemon starting (version ${getScaffoldVersion()})`);

  const config = loadConfig();
  // Validates dev/prod-sensitive settings (channel ID, SQLite path, etc.) at
  // boot even though they are not yet consumed here; loud/early failure is
  // preferable to a silently-misconfigured daemon (E3 wires these in).
  resolveProfile(config);

  const secrets = await withTimeout(loadSecrets(), {
    timeoutMs: SECRETS_LOAD_TIMEOUT_MS,
    message: `Timed out loading secrets after ${SECRETS_LOAD_TIMEOUT_MS}ms (the \`op\` CLI may be hung; check 1Password service account connectivity)`,
  });

  const handle = await runDaemon({
    config,
    secrets,
    onStartup: placeholderOnStartup,
    onTrigger: placeholderOnTrigger,
  });

  await handle.stopped;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
