import { loadConfig } from "./config/config.js";
import { type ProfileSettings, resolveProfile } from "./config/profile.js";
import { CostMeter } from "./cost/cost-meter.js";
import { meteredLlmClient } from "./cost/metered-llm-client.js";
import { runDaemon } from "./daemon/daemon.js";
import { withTimeout } from "./daemon/with-timeout.js";
import { getScaffoldVersion } from "./lib/version.js";
import { createLlmClient } from "./llm/agent-sdk-client.js";
import { composeDaemon } from "./orchestrator/compose.js";
import { resumeQuietly } from "./orchestrator/resume.js";
import { SessionStore } from "./orchestrator/session-store.js";
import { buildPlan } from "./planner/build-plan.js";
import type { EnrichedWeekPlan } from "./planner/enrich.js";
import { TransformersEmbedder } from "./recipe-mcp/embedder.js";
import { getRecipe } from "./recipe-mcp/get-recipe.js";
import { searchRecipes } from "./recipe-mcp/search.js";
import { StructuredStore } from "./recipe-mcp/structured-store.js";
import { VectorStore } from "./recipe-mcp/vector-store.js";
import { loadSecrets, type Secrets } from "./secrets/secrets.js";
import { renderPlan } from "./slack/render.js";

/**
 * Boot secret loading with a timeout (carried over from the secrets review,
 * bd note on meal-planner-7js.6): a hung `op` CLI must not hang boot
 * forever. See `src/daemon/with-timeout.ts`.
 */
const SECRETS_LOAD_TIMEOUT_MS = 15_000;

/**
 * Default household prose handed to the planner (`buildPlan`'s `household`
 * arg) whenever `MP_HOUSEHOLD` isn't set. This is family-specific,
 * env-overridable placeholder text — but the HARD constraint (a vegetarian
 * daughter) must always be present in whatever text the planner sees, dev or
 * prod, so it's baked into this default rather than left to be forgotten in
 * an env file. Override via `MP_HOUSEHOLD` for the real household's full
 * prose (picky eaters, other dietary notes, etc.) once written.
 */
const DEFAULT_HOUSEHOLD =
  "A family of four: two adults and two kids. One daughter is vegetarian " +
  "(hard constraint) — every dinner must be either inherently vegetarian, " +
  "cleanly separable (e.g. hold the meat), or paired with a second " +
  "vegetarian dish made just for her. No other dietary restrictions are " +
  "known yet.";

/**
 * Builds the v1.0 dry-run `post` (ADR 0002/0003's injected `PostFn`,
 * bd meal-planner-bd6.9). Renders the plan via the real `renderPlan` (E5,
 * bj1.2) and logs it clearly labelled DRY-RUN alongside the target channel,
 * rather than calling Slack's `chat.postMessage` — there is no Slack app
 * wired up yet (that's E5 bj1.1/bj1.3). Returns a SYNTHETIC `ts` (an
 * incrementing counter, never `Date.now()`) so `generateForWeek`'s
 * write-before-post bookkeeping has something stable to persist.
 *
 * TODO(E5 bj1.3): once the real Slack app/token exist, swap this for an
 * actual `chat.postMessage` call when `profile.postMode === "post"`. For
 * now every profile dry-runs: if `postMode === "post"` is configured, this
 * logs a warning that real posting isn't wired yet and dry-runs anyway
 * (never silently drops the plan).
 */
function buildDryRunPost(
  profile: ProfileSettings,
  logger: Pick<Console, "log" | "warn"> = console,
): (plan: EnrichedWeekPlan) => Promise<{ ts: string }> {
  let counter = 0;

  if (profile.postMode === "post") {
    logger.warn(
      'buildDryRunPost: profile.postMode is "post", but real Slack ' +
        "posting is not wired up yet (E5 bj1.3) -- dry-running instead.",
    );
  }

  return async (plan: EnrichedWeekPlan) => {
    counter += 1;
    const ts = `dryrun-${counter}`;
    logger.log(
      `[DRY-RUN post] channel=${profile.channelId} ts=${ts}\n${renderPlan(plan)}`,
    );
    return { ts };
  };
}

/**
 * Console-based placeholder for the #agent-alerts notifier (E6, injected
 * `AlertFn`). Never includes a secret — callers (`generateForWeek`/
 * `onStartup`) already only ever pass a week_key + short error/summary text.
 * TODO(E6): swap this for the real #agent-alerts Slack post.
 */
function consoleAlert(
  logger: Pick<Console, "warn"> = console,
): (message: string) => Promise<void> {
  return async (message: string) => {
    logger.warn(`[agent-alert] ${message}`);
  };
}

/**
 * Wires loaded secrets into the process environment for consumers that read
 * credentials from `process.env` rather than being passed `Secrets`
 * directly — specifically, the Claude Agent SDK harness (`src/llm/`) reads
 * its API key from `process.env.ANTHROPIC_API_KEY`. `src/secrets/secrets.ts`
 * explicitly defers this wiring to the daemon bootstrap; this is that
 * wiring. Must run before anything that could invoke the SDK (i.e. before
 * `runDaemon` starts the scheduler / fires `onStartup`).
 *
 * Pure aside from the `env` mutation; NEVER logs a secret value.
 */
export function applySecretsToEnv(
  secrets: Secrets,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.ANTHROPIC_API_KEY = secrets.anthropicApiKey;
}

export async function main(): Promise<void> {
  console.log(`meal-planner daemon starting (version ${getScaffoldVersion()})`);

  const config = loadConfig();
  // Validates dev/prod-sensitive settings (channel ID, SQLite path, etc.) at
  // boot: loud/early failure is preferable to a silently-misconfigured
  // daemon. Its result now drives the dry-run post, SessionStore path, and
  // onTrigger's force behavior below.
  const profile = resolveProfile(config);

  const secrets = await withTimeout(loadSecrets(), {
    timeoutMs: SECRETS_LOAD_TIMEOUT_MS,
    message: `Timed out loading secrets after ${SECRETS_LOAD_TIMEOUT_MS}ms (the \`op\` CLI may be hung; check 1Password service account connectivity)`,
  });

  // Must happen before runDaemon starts onStartup/the scheduler, since either
  // could invoke the Agent SDK harness (see applySecretsToEnv doc comment).
  applySecretsToEnv(secrets);

  // Recipe MCP server's own local index/cache (ADR 0001) -- a SEPARATE
  // sqlite file from the orchestrator's session DB below. Default paths
  // (own recipe DB); no seed fixtures/recipe data wired here (out of scope).
  const vectorStore = new VectorStore();
  const structuredStore = new StructuredStore();
  const embedder = new TransformersEmbedder();
  const storeDeps = { embedder, vectorStore, structuredStore };

  // Token/$ tracking across a run (SPEC §9.3, bd meal-planner-fkg.1): ONE
  // meter, wrapping the real llm so every buildPlan call (selection + a
  // possible repair) reports its usage to it, `reset()` at the start of
  // each generateForWeek run (see composeDaemon -> generateForWeek). Runs
  // are sequential (one generateForWeek at a time), so a single shared
  // instance is correct -- there is never more than one run's calls live in
  // it at once. Only TRACKS + persists here; the $ cap/alert is fkg.2 (next).
  const meter = new CostMeter(config.modelRates[config.model]);
  const llm = meteredLlmClient(createLlmClient(config), meter);
  const search = (
    query: string,
    filters?: Parameters<typeof searchRecipes>[1],
  ) => searchRecipes(query, filters, storeDeps);
  const getRecipeBound = (id: string) =>
    getRecipe(id, { noteStore: vectorStore, structuredStore });

  const household = process.env.MP_HOUSEHOLD ?? DEFAULT_HOUSEHOLD;

  const buildPlanFor = (weekKey: string) =>
    buildPlan({
      weekKey,
      cfg: {
        cookNights: config.cookNights,
        activeMaxMinutes: config.activeMaxMinutes,
        fanoutMultiplier: config.fanoutMultiplier,
        vegFloorK: config.vegFloorK,
        untestedRate: config.untestedRate,
      },
      household,
      deps: { search, llm, getRecipe: getRecipeBound },
    });

  const store = new SessionStore({ path: profile.sqlitePath });

  const post = buildDryRunPost(profile);
  const alert = consoleAlert();

  const { onStartup, onTrigger } = composeDaemon({
    config,
    profile,
    store,
    buildPlan: buildPlanFor,
    post,
    alert,
    resumeQuietly,
    nowDate: () => new Date(),
    nowIso: () => new Date().toISOString(),
    meter,
  });

  const handle = await runDaemon({
    config,
    secrets,
    onStartup,
    onTrigger,
    fireOnStart: process.env.MP_FIRE_ON_START === "1",
  });

  await handle.stopped;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
