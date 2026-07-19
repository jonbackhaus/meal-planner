import { loadConfig } from "./config/config.js";
import { CostMeter } from "./cost/cost-meter.js";
import { meteredLlmClient } from "./cost/metered-llm-client.js";
import { withTimeout } from "./daemon/with-timeout.js";
import { applySecretsToEnv } from "./index.js";
import { createLlmClient } from "./llm/agent-sdk-client.js";
import { TransformersEmbedder } from "./recipe-mcp/embedder.js";
import { readNotes } from "./recipe-mcp/notes-reader.js";
import { StructuredStore } from "./recipe-mcp/structured-store.js";
import type { SyncResult } from "./recipe-mcp/sync.js";
import { runSync } from "./recipe-mcp/sync-runner.js";
import { VectorStore } from "./recipe-mcp/vector-store.js";
import { loadSecrets } from "./secrets/secrets.js";

/**
 * Standalone `pnpm sync` command (bd meal-planner-q95.8): runs ONE recipe-sync
 * pass over Apple Notes into the same local index (`VectorStore` /
 * `StructuredStore`) the daemon reads, then exits. Populates the corpus on a
 * fresh machine and does manual refreshes WITHOUT firing a plan or posting to
 * Slack. The daemon also auto-syncs before each real generation (see
 * `makeBuildPlanWithSync` in `index.ts`); this is the operator-driven path.
 */

/** Same 15s boot secret-load timeout as the daemon: a hung `op` CLI must fail loudly, not hang. */
const SECRETS_LOAD_TIMEOUT_MS = 15_000;

/**
 * The testable core: given a bound `runSync` (and optionally the cost meter it
 * feeds), run the sync, print the `SyncResult` summary and — when a meter is
 * present — the run's token/$ spend, and return the result. The boot wrapper
 * (`main`) constructs the real collaborators and owns `process.exit`.
 */
export interface SyncCliDeps {
  runSync: () => Promise<SyncResult>;
  meter?: Pick<CostMeter, "totals">;
  logger?: Pick<Console, "log" | "error">;
}

export async function runSyncCli(deps: SyncCliDeps): Promise<SyncResult> {
  const { runSync: doSync, meter, logger = console } = deps;

  const r = await doSync();
  logger.log(
    `[sync] total=${r.total} processed=${r.processed} skipped=${r.skipped} extractionFailures=${r.extractionFailures} removed=${r.removed}`,
  );

  if (meter) {
    const t = meter.totals();
    logger.log(
      `[sync] spend: tokens=${t.inputTokens + t.outputTokens} (in=${t.inputTokens} out=${t.outputTokens}) $${t.costUsd.toFixed(4)}`,
    );
  }

  return r;
}

async function main(): Promise<void> {
  const config = loadConfig();

  const secrets = await withTimeout(loadSecrets(), {
    timeoutMs: SECRETS_LOAD_TIMEOUT_MS,
    message: `Timed out loading secrets after ${SECRETS_LOAD_TIMEOUT_MS}ms (the \`op\` CLI may be hung; check 1Password service account connectivity)`,
  });
  applySecretsToEnv(secrets);

  const vectorStore = new VectorStore();
  const structuredStore = new StructuredStore();
  const embedder = new TransformersEmbedder();

  // Same metered, cost-capped llm the daemon uses: extraction spend is tracked
  // and capped by config.generationDollarCap (extraction is hash-gated -> ~$0
  // in steady state).
  const meter = new CostMeter(config.modelRates[config.model], config.model);
  const llm = meteredLlmClient(createLlmClient(config), meter, {
    capUsd: config.generationDollarCap,
  });

  const folderName = process.env.MP_RECIPES_FOLDER || undefined;

  await runSyncCli({
    runSync: () =>
      runSync(
        { readNotes, embedder, vectorStore, structuredStore, llm },
        { folderName },
      ),
    meter,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
