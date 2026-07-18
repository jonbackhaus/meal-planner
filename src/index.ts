import { loadConfig } from "./config/config.js";
import { type ProfileSettings, resolveProfile } from "./config/profile.js";
import { CostMeter } from "./cost/cost-meter.js";
import { meteredLlmClient } from "./cost/metered-llm-client.js";
import { runDaemon } from "./daemon/daemon.js";
import { withTimeout } from "./daemon/with-timeout.js";
import { getScaffoldVersion } from "./lib/version.js";
import { createLlmClient } from "./llm/agent-sdk-client.js";
import { makeAlert } from "./ops/alerter.js";
import { appendLog } from "./ops/local-log.js";
import { composeDaemon } from "./orchestrator/compose.js";
import { resumeQuietly } from "./orchestrator/resume.js";
import { SessionStore } from "./orchestrator/session-store.js";
import { buildPlan } from "./planner/build-plan.js";
import type { EnrichedWeekPlan } from "./planner/enrich.js";
import { seasonForDate } from "./planner/season.js";
import { TransformersEmbedder } from "./recipe-mcp/embedder.js";
import { getRecipe } from "./recipe-mcp/get-recipe.js";
import { readNotes } from "./recipe-mcp/notes-reader.js";
import { searchRecipes } from "./recipe-mcp/search.js";
import { StructuredStore } from "./recipe-mcp/structured-store.js";
import type { SyncResult } from "./recipe-mcp/sync.js";
import { runSync } from "./recipe-mcp/sync-runner.js";
import { VectorStore } from "./recipe-mcp/vector-store.js";
import { loadSecrets, type Secrets } from "./secrets/secrets.js";
import { renderPlan } from "./slack/render.js";
import { SlackAlerter } from "./slack/slack-alerter.js";
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
 * Default path for the durable local alert log (`src/ops/local-log.ts`) when
 * `MP_LOG_PATH` isn't set. Relative to the process's cwd, matching this
 * repo's other default on-disk paths (`ProfileSettings.sqlitePath` etc.).
 */
export const DEFAULT_LOG_PATH = "./data/meal-planner.log";

/**
 * Builds the real `#agent-alerts` notifier (E6, injected `AlertFn`; SPEC
 * §9.4: alerts-only — no heartbeat, no "skipping this week" messages, fires
 * only on real anomalies). Replaces the old console-only placeholder with:
 *
 *   1. A durable local log on disk (`appendLog`, ALWAYS) at `MP_LOG_PATH`
 *      (default `DEFAULT_LOG_PATH`) — a complete record even if Slack is
 *      unreachable.
 *   2. A post to `#agent-alerts` via `SlackAlerter`, ONLY when
 *      `profile.postMode === "post"` — dry-run never touches Slack. The
 *      alerts channel ID comes from `MP_ALERTS_CHANNEL_ID`, a SEPARATE env
 *      var from the meal-plan `profile.channelId` (`#agent-alerts` is a
 *      different channel entirely). If `MP_ALERTS_CHANNEL_ID` is unset while
 *      `postMode === "post"`, this warns and falls back to local-log-only —
 *      it must NOT crash boot over a missing alerts channel (the actual
 *      channel creation is a runtime/ops step, not this code's concern).
 *
 * The returned function is `makeAlert`'s composite (`src/ops/alerter.ts`):
 * it never throws, and attempts the local log and the Slack post
 * independently, so a failure in either never masks the original error that
 * triggered the alert or crashes the daemon.
 */
export function buildAlert(
  profile: ProfileSettings,
  secrets: Secrets,
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "warn" | "error"> = console,
): (message: string) => Promise<void> {
  const logPath = env.MP_LOG_PATH || DEFAULT_LOG_PATH;
  const appendLocal = (message: string) =>
    appendLog(logPath, message, () => new Date());

  let slackAlert: ((message: string) => Promise<void>) | undefined;
  if (profile.postMode === "post") {
    const alertsChannelId = env.MP_ALERTS_CHANNEL_ID;
    if (!alertsChannelId) {
      logger.warn(
        "[agent-alert] MP_ALERTS_CHANNEL_ID is not set; falling back to " +
          "local-log-only alerts (no #agent-alerts Slack post will be sent)",
      );
    } else {
      const alerter = new SlackAlerter({
        token: secrets.slackBotToken,
        channelId: alertsChannelId,
      });
      slackAlert = (message: string) => alerter.alert(message);
    }
  }

  return makeAlert({ appendLocal, slackAlert, logger });
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

/**
 * Injected deps for {@link makeBuildPlanWithSync}. `runSync` and `buildPlan`
 * are pre-bound (folder/config already applied); `alert` is the never-throwing
 * composite from {@link buildAlert}.
 */
export interface BuildPlanWithSyncDeps {
  runSync: () => Promise<SyncResult>;
  buildPlan: (weekKey: string) => Promise<EnrichedWeekPlan>;
  alert: (message: string) => Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
}

/**
 * Wraps the planner's `buildPlan(weekKey)` with a recipe-sync pass that runs
 * FIRST (bd meal-planner-q95.8): the daemon's `buildPlanFor` closure is only
 * ever called from inside `generateForWeek` — after the idempotency gate has
 * passed and the `generating` row is written — so sync runs exactly once per
 * REAL generation (a double-fire / restart that hits the gate never syncs).
 *
 * Failure policy (ratified): **proceed + alert**. A whole-sync failure (Notes
 * not authorized, embedder model download fails, etc.) is logged and posted to
 * `#agent-alerts`, but generation CONTINUES against the existing (possibly
 * stale) index — a slightly stale plan beats skipping the week. If the index is
 * empty, `composePools` yields empty pools and `generateForWeek`'s own failure
 * path marks the week `failed` and alerts, so an empty-index run still fails
 * loudly. Per-note extraction failures are already isolated inside `syncNotes`
 * (ADR 0001) and don't reach here. The `alert` call is additionally guarded so
 * a broken alerter can never sink an otherwise-healthy generation.
 */
export function makeBuildPlanWithSync(
  deps: BuildPlanWithSyncDeps,
): (weekKey: string) => Promise<EnrichedWeekPlan> {
  const { runSync: doSync, buildPlan, alert, logger = console } = deps;

  return async (weekKey: string) => {
    try {
      const r = await doSync();
      logger.log(
        `[sync] total=${r.total} processed=${r.processed} skipped=${r.skipped} extractionFailures=${r.extractionFailures}`,
      );
    } catch (e) {
      const message = `recipe sync failed before generating week ${weekKey}: ${String(e)}`;
      logger.warn(message);
      try {
        await alert(message);
      } catch (alertErr) {
        logger.warn(
          `alert during recipe-sync-failure handling also failed for week ${weekKey}: ${String(alertErr)}`,
        );
      }
      // Proceed: plan against the existing (possibly stale) index.
    }
    return buildPlan(weekKey);
  };
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

  // Built before buildPlanFor so the recipe-sync-failure path can post to
  // #agent-alerts (proceed + alert; see makeBuildPlanWithSync).
  const alert = buildAlert(profile, secrets);

  // Recipe folder to sync from (notes-reader scopes to a single Notes folder);
  // empty/unset falls back to notes-reader's DEFAULT_RECIPES_FOLDER.
  const recipesFolder = process.env.MP_RECIPES_FOLDER || undefined;

  const rawBuildPlan = (weekKey: string) =>
    buildPlan({
      weekKey,
      cfg: {
        cookNights: config.cookNights,
        activeMaxMinutes: config.activeMaxMinutes,
        fanoutMultiplier: config.fanoutMultiplier,
        vegFloorK: config.vegFloorK,
        untestedRate: config.untestedRate,
        // v1.0 tag-based seasonality (bd meal-planner-8zs.9): derive the
        // current season from the wall clock in the configured zone. Read once
        // per real generation (buildPlanFor only runs past the idempotency
        // gate). main() is the clock-owning composition root — cf. nowDate
        // below. Flows to both the hard search filter and the soft prompt bias.
        season: seasonForDate(new Date(), config.timezone),
      },
      household,
      deps: { search, llm, getRecipe: getRecipeBound },
    });

  // Sync recipes from Apple Notes BEFORE selecting (SPEC weekly flow; bd
  // meal-planner-q95.8). Runs once per real generation (buildPlanFor is only
  // called past generateForWeek's idempotency gate). Uses the SAME metered,
  // cost-capped llm the planner uses, so extraction spend counts against the
  // run's $ cap (extraction is hash-gated -> ~$0 steady state).
  const buildPlanFor = makeBuildPlanWithSync({
    runSync: () =>
      runSync(
        { readNotes, embedder, vectorStore, structuredStore, llm },
        { folderName: recipesFolder },
      ),
    buildPlan: rawBuildPlan,
    alert,
  });

  const store = new SessionStore({ path: profile.sqlitePath });

  const post =
    profile.postMode === "post"
      ? buildSlackPost(profile, secrets)
      : buildDryRunPost(profile);

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
    // Reuses the same never-throwing composite the orchestrator alerts through,
    // so the Scheduler's trigger watchdog surfaces a hung run to #agent-alerts
    // + the local log (bd meal-planner-bd6.11).
    alert,
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
