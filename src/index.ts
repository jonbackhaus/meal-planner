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
import { SlackPoster } from "./slack/slack-poster.js";

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
 * bd meal-planner-bd6.9), used when `profile.postMode === "dry-run"`.
 * Renders the plan via the real `renderPlan` (E5, bj1.2) and logs it clearly
 * labelled DRY-RUN alongside the target channel, rather than calling
 * Slack's `chat.postMessage`. Returns a SYNTHETIC `ts` (an incrementing
 * counter, never `Date.now()`) so `generateForWeek`'s write-before-post
 * bookkeeping has something stable to persist.
 *
 * The real `chat.postMessage`-backed `PostFn` (E5 bj1.3, `SlackPoster`) is
 * wired in `main()` below when `profile.postMode === "post"`.
 */
function buildDryRunPost(
  profile: ProfileSettings,
  logger: Pick<Console, "log"> = console,
): (plan: EnrichedWeekPlan) => Promise<{ ts: string }> {
  let counter = 0;

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
 * Builds the real `chat.postMessage`-backed `PostFn` (E5 bj1.3, SPEC
 * §7/§9.2: v1.0-v2.0 posts OUTBOUND ONLY via the Slack Web API — no Socket
 * Mode, no Bolt). Used when `profile.postMode === "post"`; logs a one-line
 * confirmation per post (no plan dump — that's `SlackPoster`/`renderPlan`'s
 * concern, not this wiring's).
 */
function buildSlackPost(
  profile: ProfileSettings,
  secrets: Secrets,
  logger: Pick<Console, "log"> = console,
): (plan: EnrichedWeekPlan) => Promise<{ ts: string }> {
  const poster = new SlackPoster({
    token: secrets.slackBotToken,
    channelId: profile.channelId,
  });

  return async (plan: EnrichedWeekPlan) => {
    const result = await poster.post(plan);
    logger.log(`[Slack post] channel=${profile.channelId} ts=${result.ts}`);
    return result;
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
  // it at once. `capUsd` (fkg.2) enforces the real ceiling: once a run's
  // cumulative spend exceeds `config.generationDollarCap`, the metered
  // client throws `CostCapExceededError`, which propagates through
  // `buildPlan` into `generateForWeek`'s existing failure/alert path.
  const meter = new CostMeter(config.modelRates[config.model], config.model);
  const llm = meteredLlmClient(createLlmClient(config), meter, {
    capUsd: config.generationDollarCap,
  });
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

  const post =
    profile.postMode === "post"
      ? buildSlackPost(profile, secrets)
      : buildDryRunPost(profile);
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
