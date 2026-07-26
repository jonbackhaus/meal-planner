import { WebClient } from "@slack/web-api";
import { readCalendarEvents } from "./calendar/calendar-reader.js";
import { type Effort, loadConfig, type ModelRate } from "./config/config.js";
import { type ProfileSettings, resolveProfile } from "./config/profile.js";
import { CostMeter } from "./cost/cost-meter.js";
import { meteredLlmClient } from "./cost/metered-llm-client.js";
import { runDaemon } from "./daemon/daemon.js";
import { makeHeartbeat } from "./daemon/heartbeat.js";
import { withTimeout } from "./daemon/with-timeout.js";
import { getScaffoldVersion } from "./lib/version.js";
import { createLlmClient } from "./llm/agent-sdk-client.js";
import type { LlmClient } from "./llm/llm-client.js";
import { retryLlmClient } from "./llm/retry-llm-client.js";
import { makeAlert } from "./ops/alerter.js";
import { appendLog } from "./ops/local-log.js";
import { backupSessionDbAtBoot } from "./orchestrator/boot-backup.js";
import { composeDaemon } from "./orchestrator/compose.js";
import type { AlertFn } from "./orchestrator/generate.js";
import { resumeQuietly } from "./orchestrator/resume.js";
import { createRevisionHandler } from "./orchestrator/revision.js";
import {
  createRevisionCoordinator,
  guardOnRevised,
  type RevisionCoordinator,
  serializeRevisionHandler,
} from "./orchestrator/revision-coordinator.js";
import {
  createRevisionCostGuard,
  type RevisionCostCaps,
} from "./orchestrator/revision-cost-guard.js";
import { createDebouncedRevisionHandler } from "./orchestrator/revision-debounce.js";
import {
  createRevisionPostHandler,
  type RevisionSlackClient,
} from "./orchestrator/revision-post.js";
import { SessionStore } from "./orchestrator/session-store.js";
import { buildPlan } from "./planner/build-plan.js";
import type { EnrichedWeekPlan } from "./planner/enrich.js";
import { seasonForDate } from "./planner/season.js";
import { resolvePrepUnits } from "./planner/select.js";
import type { ValidatePlanConfig } from "./planner/validate.js";
import { TransformersEmbedder } from "./recipe-mcp/embedder.js";
import { getRecipe } from "./recipe-mcp/get-recipe.js";
import { readNotes } from "./recipe-mcp/notes-reader.js";
import type { Recipe } from "./recipe-mcp/schema.js";
import { searchRecipes } from "./recipe-mcp/search.js";
import { StructuredStore } from "./recipe-mcp/structured-store.js";
import type { StaleCount, SyncResult } from "./recipe-mcp/sync.js";
import { countStale, runSync } from "./recipe-mcp/sync-runner.js";
import { VectorStore } from "./recipe-mcp/vector-store.js";
import { loadSecrets, type Secrets } from "./secrets/secrets.js";
import type { RevisionHandler } from "./slack/inbound-router.js";
import { renderPlan } from "./slack/render.js";
import { SlackAlerter } from "./slack/slack-alerter.js";
import { SlackPoster } from "./slack/slack-poster.js";
import type {
  ApprovalHandler,
  ResetPauseHandler,
} from "./slack/slash-commands.js";
import { createTodoistApprovalHandler } from "./todoist-commit/approval-handler.js";
import { readRecentRecipeIds } from "./todoist-commit/recency.js";
import { TodoistClient } from "./todoist-mcp/todoist-client.js";
import { getTemperatureBand } from "./weather/weather.js";

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
 * Slack's `chat.postMessage`. Returns a SYNTHETIC `ts` (never `Date.now()`)
 * so `generateForWeek`'s write-before-post bookkeeping has something stable
 * to persist.
 *
 * The synthetic ts is WEEK-SCOPED (`dryrun-${plan.week_key}`), not a
 * per-process counter (bd meal-planner-bd6.14): a counter reset `dryrun-1` on
 * every daemon reboot, so retained dev rows across reboots collided on
 * `thread_ts=dryrun-1`, breaking the `getByThreadTs` reverse map those rows
 * are retained for. Deriving it from the week gives each week a stable, unique
 * ts. The reverse-map key is itself week-scoped (one session row per
 * `week_key`), so even if two dry-run posts fired for the same week they'd
 * share this ts by design — matching the single retained row for that week.
 *
 * ADR 0005 D4 (bd meal-planner-0v7.7): passes `plan.nightSchedule` (the
 * COMPACT, PII-free render context `buildPlan` attaches, see
 * `planner/enrich.ts`; bd meal-planner-0v7.8) and `resolvePrepUnits(plan)`
 * into `renderPlan` so the dry-run log shows the same capacity/prep
 * annotations the real post would. `plan.nightSchedule` is `undefined` on a
 * v1.0/degraded plan — `renderPlan` already falls back to the unordered
 * render in that case.
 *
 * The real `chat.postMessage`-backed `PostFn` (E5 bj1.3, `SlackPoster`) is
 * wired in `main()` below when `profile.postMode === "post"`.
 */
export function buildDryRunPost(
  profile: ProfileSettings,
  logger: Pick<Console, "log"> = console,
): (plan: EnrichedWeekPlan) => Promise<{ ts: string }> {
  return async (plan: EnrichedWeekPlan) => {
    const ts = `dryrun-${plan.week_key}`;
    const text = renderPlan(plan, {
      nightSchedule: plan.nightSchedule,
      prep: resolvePrepUnits(plan),
    });
    logger.log(`[DRY-RUN post] channel=${profile.channelId} ts=${ts}\n${text}`);
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
 * Builds the real `ApprovalHandler` (C1, bd meal-planner-iu7.2, SPEC §7 /
 * ADR-0006): commits `/mp-approve`'s resolved plan to Todoist (C2/C3)
 * and posts a confirmation reply in the session thread. Assembles C0's
 * `TodoistClient` from `secrets.todoistApiToken` and C5's resolved
 * `profile.todoist` config -- both already built, reused here as-is.
 *
 * Returns `undefined` when `secrets.todoistApiToken` isn't set (Todoist not
 * yet configured for this profile) -- `runDaemon`'s `approvalHandler` option
 * already defaults to a no-op in that case (`slash-commands.ts`), so
 * omitting this wiring is a safe, silent no-op rather than a boot-time
 * error, mirroring how Socket Mode itself is gated on `secrets.slackAppToken`
 * above.
 */
export function buildApprovalHandler(
  profile: ProfileSettings,
  secrets: Secrets,
  sessionStore: Pick<SessionStore, "get" | "update">,
  revisionCoordinator?: Pick<RevisionCoordinator, "supersede">,
): ApprovalHandler | undefined {
  if (!secrets.todoistApiToken) {
    return undefined;
  }
  return createTodoistApprovalHandler({
    sessionStore,
    todoistClient: new TodoistClient({ apiToken: secrets.todoistApiToken }),
    todoistConfig: profile.todoist,
    slack: new WebClient(secrets.slackBotToken),
    channelId: profile.channelId,
    // B4/D4 (bd meal-planner-3e2.5, ADR 0007 D4): the SAME RevisionCoordinator
    // instance the revision chain below is built with, so `/mp-approve`
    // always supersedes an in-flight revision on the same week.
    revisionCoordinator,
  });
}

/**
 * Builds the real `ResetPauseHandler` (bd meal-planner-m49, ADR-0007 D6/D7):
 * the operator-only `/mp-resume` slash command's seam. Calls the LIVE
 * revision cost guard's `resetPause` (`../orchestrator/revision-cost-guard.js`,
 * threaded in from `buildRevisionSystem`'s `resetPause`) for the resolved
 * active week, then posts a brief in-thread confirmation -- mirrors
 * `buildApprovalHandler`'s shape, assembled in `main()` once
 * `buildRevisionSystem`'s `resetPause` exists and injected into `runDaemon`'s
 * `resetPauseHandler` option.
 *
 * `resetPause` itself already no-ops (with a warn log) when the week isn't
 * currently `paused_cost` (`RevisionCostGuard.resetPause`'s own contract) --
 * this wrapper only needs a pre-reset status read to choose which of the two
 * benign confirmation messages to post; it never reimplements the guard's
 * pause/reset state logic.
 */
export function buildResetPauseHandler(
  resetPause: (weekKey: string) => void,
  sessionStore: Pick<SessionStore, "get">,
  slack: RevisionSlackClient,
  channelId: string,
  logger: Pick<Console, "error"> = console,
): ResetPauseHandler {
  return {
    async onResetPause(command) {
      const wasPaused =
        sessionStore.get(command.weekKey)?.status === "paused_cost";

      resetPause(command.weekKey);

      const text = wasPaused
        ? "revision resumed -- cost pause cleared"
        : "nothing to resume -- this thread isn't currently paused for cost";
      try {
        await slack.chat.postMessage({
          channel: channelId,
          text,
          mrkdwn: true,
          thread_ts: command.threadTs,
        });
      } catch (err) {
        logger.error(
          `[reset-pause-handler] failed to post the resume confirmation for week ${command.weekKey}: ${String(err)}`,
        );
      }
    },
  };
}

/**
 * Builds the real recency-read function `buildPlan` consumes (D3, bd
 * meal-planner-v9v.3, ADR-0006, SPEC §6.3): assembles a `TodoistClient` from
 * `secrets.todoistApiToken` exactly like {@link buildApprovalHandler} does,
 * then binds D1's `readRecentRecipeIds` against it, scoped to
 * `profile.todoist.projectId` when configured.
 *
 * Returns `undefined` when `secrets.todoistApiToken` isn't set -- mirroring
 * `buildApprovalHandler`'s gate -- so a pre-v3.x boot (no Todoist token) never
 * even attempts a recency read; `buildPlan`'s `getRecentRecipeIds` is optional
 * for exactly this case. When present, the returned function may still THROW
 * (an expired token, a network failure, a malformed response) -- that is
 * intentional: `buildPlan` itself is what catches it and degrades silently
 * (SPEC §6.3, the load-bearing requirement), not this assembly step.
 */
export function buildRecencyReader(
  profile: ProfileSettings,
  secrets: Secrets,
): (() => Promise<string[]>) | undefined {
  if (!secrets.todoistApiToken) {
    return undefined;
  }
  const client = new TodoistClient({ apiToken: secrets.todoistApiToken });
  return async () => {
    const { recipeIds } = await readRecentRecipeIds(client, {
      ...(profile.todoist.projectId
        ? { projectId: profile.todoist.projectId }
        : {}),
    });
    return recipeIds;
  };
}

/**
 * uo1 (bd meal-planner-uo1): the composed v3.0 revision-loop deps this module
 * assembles for {@link buildRevisionSystem}, pre-narrowed to only what the
 * B1-B5 wrappers actually need -- keeps that function decoupled from the full
 * `Config` shape.
 */
export interface RevisionSystemDeps {
  sessionStore: Pick<SessionStore, "get" | "update">;
  coordinator: RevisionCoordinator;
  /** The revision-effort-capped `LlmClient` (SPEC §9.3) -- the SAME base client B1's mutation call and B2's one-shot repair both use per cycle. */
  llm: LlmClient;
  getRecipe: (id: string) => Promise<Recipe | null>;
  /** The SAME deterministic slot/day/paired-side validation config generation validates against (`../planner/validate.js`). */
  validateConfig: ValidatePlanConfig;
  slack: RevisionSlackClient;
  channelId: string;
  /** The three nested cost-cap guards (B5, ADR-0007 D5/D6/D7, SPEC §9.3). */
  caps: RevisionCostCaps;
  rate: ModelRate;
  alert: AlertFn;
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface RevisionSystem {
  /** The fully-composed `RevisionHandler` for the A4 router seam. */
  revisionHandler: RevisionHandler;
  /** B5's operator-only pause reset (D6), bound to this run's cost guard instance. */
  resetPause: (weekKey: string) => void;
}

/**
 * Composes the v3.0 revision loop (bd meal-planner-uo1, the coordinator-owned
 * integration point every B1-B5 wrapper's doc comment explicitly deferred
 * here): wires the tested, standalone pieces together at the A4 router seam
 * WITHOUT reimplementing any of their logic.
 *
 * Composition order (outermost first), per the wrapper authors' doc comments:
 *
 *   `createDebouncedRevisionHandler` (B3)
 *     ⊃ `serializeRevisionHandler` (B4)
 *       ⊃ `createRevisionCostGuard.wrapRevisionHandler` (B5)
 *         ⊃ a per-cycle `createRevisionHandler` (B1) whose `onRevised` is
 *           `guardOnRevised` (B4) wrapping `createRevisionPostHandler` (B2)
 *
 * Debounce is OUTERMOST so a burst of rapid replies coalesces into ONE
 * downstream call BEFORE it reaches B4's mutex/`under_revision` transition or
 * B5's turn-cap counting -- exactly the rationale `revision-debounce.ts`'s own
 * doc comment gives ("per-message dispatch would burn per-thread turn-cap
 * budget ... and risk two revisions racing the same session row"). Serialize
 * wraps the cost guard, and the cost guard wraps a per-cycle `buildHandler`
 * factory (a fresh per-cycle `llm` per B5's `wrapRevisionHandler` contract),
 * matching `revision-cost-guard.ts`'s own documented recommendation
 * ("serializeRevisionHandler (B4) ⊃ this guard ⊃ buildHandler ⊃ B1/B2").
 */
export function buildRevisionSystem(deps: RevisionSystemDeps): RevisionSystem {
  const buildHandler = (llm: LlmClient): RevisionHandler =>
    createRevisionHandler({
      sessionStore: deps.sessionStore,
      llm,
      logger: deps.logger,
      onRevised: guardOnRevised(
        createRevisionPostHandler({
          getRecipe: deps.getRecipe,
          llm,
          validateConfig: deps.validateConfig,
          slack: deps.slack,
          channelId: deps.channelId,
          logger: deps.logger,
        }),
        {
          sessionStore: deps.sessionStore,
          coordinator: deps.coordinator,
          now: deps.now,
          logger: deps.logger,
        },
      ),
    });

  const costGuard = createRevisionCostGuard({
    sessionStore: deps.sessionStore,
    caps: deps.caps,
    rate: deps.rate,
    alert: deps.alert,
    slack: deps.slack,
    channelId: deps.channelId,
    now: deps.now,
    logger: deps.logger,
  });

  const costGuardedHandler = costGuard.wrapRevisionHandler(
    buildHandler,
    deps.llm,
  );

  const serializedHandler = serializeRevisionHandler(costGuardedHandler, {
    sessionStore: deps.sessionStore,
    coordinator: deps.coordinator,
    now: deps.now,
    logger: deps.logger,
  });

  const revisionHandler = createDebouncedRevisionHandler(serializedHandler, {
    logger: deps.logger,
  });

  return { revisionHandler, resetPause: costGuard.resetPause };
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
 * Time budget for the best-effort ALERT attempt inside {@link makeFatalHandler}
 * (bd meal-planner-bd6.14). A fatal handler must ALWAYS reach its deliberate
 * `exit(1)` — if the Slack alert transport hangs, waiting on it forever would
 * leave a half-dead process alive and re-introduce the very flapping that
 * launchd `KeepAlive` already masks. Bounding the alert guarantees exit.
 */
export const FATAL_ALERT_TIMEOUT_MS = 5_000;

/** Injected deps for {@link makeFatalHandler}. `exit` is injected so tests can assert exit(1) without killing the runner. */
export interface FatalHandlerDeps {
  /** Synchronous durable local-log append (`appendLog` bound to a path/clock). */
  appendLocal: (message: string) => void;
  /** The never-throwing alert composite from {@link buildAlert} (log + best-effort Slack). */
  alert: (message: string) => Promise<void>;
  /** `process.exit`, injected so a test can assert the exit code without terminating the runner. */
  exit: (code: number) => void;
  logger?: Pick<Console, "error">;
  /** Overridable in tests; defaults to {@link FATAL_ALERT_TIMEOUT_MS}. */
  alertTimeoutMs?: number;
}

/**
 * Builds the process-level fatal handler installed in `main()` for both
 * `unhandledRejection` and `uncaughtException` (bd meal-planner-bd6.14).
 * Without it, a stray rejection off the awaited chain crashes silently (only
 * an err.log line) while launchd `KeepAlive` masks the flapping.
 *
 * On a fatal fault it does, in order:
 *   1. A SYNCHRONOUS durable local-log append — happens before any async work,
 *      so the crash is on disk even if the process is in an undefined state or
 *      the alert transport is unreachable.
 *   2. A best-effort ALERT (the never-throwing composite), bounded by
 *      {@link FATAL_ALERT_TIMEOUT_MS} so a hung transport cannot prevent exit.
 *   3. A DELIBERATE `exit(1)` — we do NOT swallow a truly fatal fault; a clean
 *      launchd restart beats a half-dead process limping on.
 *
 * The handler itself never throws: the log append and the alert are each
 * guarded, mirroring the codebase's never-let-alert-throw discipline.
 */
export function makeFatalHandler(
  deps: FatalHandlerDeps,
): (error: unknown) => Promise<void> {
  const {
    appendLocal,
    alert,
    exit,
    logger = console,
    alertTimeoutMs = FATAL_ALERT_TIMEOUT_MS,
  } = deps;

  return async (error: unknown) => {
    const message = `FATAL: unhandled error crashed the daemon; exiting for launchd to restart: ${String(error)}`;

    try {
      appendLocal(message);
    } catch (err) {
      logger.error(`[fatal] local log append failed: ${String(err)}`);
    }

    try {
      await withTimeout(alert(message), {
        timeoutMs: alertTimeoutMs,
        message: "fatal-handler alert timed out",
      });
    } catch (err) {
      logger.error(`[fatal] alert attempt failed: ${String(err)}`);
    }

    exit(1);
  };
}

/**
 * Rough, LABELLED-APPROXIMATE per-recipe extraction cost/time (bd
 * meal-planner-a9e), used ONLY to size the mass-stale-sync ALERT message
 * below — never for cap enforcement (that stays `generationDollarCap` /
 * `CostMeter`). Order-of-magnitude from the go-live mass-invalidation
 * incident this bead was filed from (694 stale recipes, ~$14 / a few hours
 * inline; see `.claude/skills/resync-recipes/` and docs/RUNBOOK.md §6).
 */
const ESTIMATED_COST_PER_RECIPE_USD = 0.02;
const ESTIMATED_SECONDS_PER_RECIPE = 20;

/**
 * Injected deps for {@link makeBuildPlanWithSync}. `runSync`, `countStale`,
 * and `buildPlan` are pre-bound (folder/config already applied); `alert` is
 * the never-throwing composite from {@link buildAlert}.
 *
 * `countStale` and `staleSyncThreshold` are OPTIONAL (bd meal-planner-a9e):
 * omitting `countStale` always runs the inline sync unconditionally, matching
 * this function's pre-a9e behavior (and keeping callers/tests that don't care
 * about the threshold gate unchanged).
 */
export interface BuildPlanWithSyncDeps {
  runSync: () => Promise<SyncResult>;
  buildPlan: (weekKey: string) => Promise<EnrichedWeekPlan>;
  alert: (message: string) => Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
  /** Cheap pre-count of stale notes (no embed/LLM) — see `countStaleNotes` (sync.ts). */
  countStale?: () => Promise<StaleCount>;
  /** Consulted only when `countStale` is provided. Default {@link DEFAULT_STALE_SYNC_THRESHOLD}. */
  staleSyncThreshold?: number;
}

/** Fallback threshold when `staleSyncThreshold` isn't supplied to {@link makeBuildPlanWithSync} — mirrors `config.ts`'s `staleSyncThreshold` default. */
export const DEFAULT_STALE_SYNC_THRESHOLD = 50;

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
 * empty (or too thin to fill the slots), `composePools` yields insufficient
 * pools and `buildPlan`'s pool-sufficiency pre-check (bd meal-planner-8zs.12)
 * throws `InsufficientPoolError` BEFORE any LLM call; `generateForWeek`'s own
 * failure path then marks the week `failed` and alerts, so an empty-index run
 * still fails loudly (and cheaply). Per-note extraction failures are already
 * isolated inside `syncNotes`
 * (ADR 0001) and don't reach here. The `alert` call is additionally guarded so
 * a broken alerter can never sink an otherwise-healthy generation.
 *
 * BEFORE any of the above, a mass-stale-sync budget guard (bd meal-planner-a9e):
 * when `countStale` is supplied, it cheaply pre-counts how many notes the
 * inline sync below would (re-)embed/re-extract — no embed/LLM calls, just
 * hashing. Sync is normally hash-gated and near-free, but a mass
 * hash-invalidation (a note-reader/hash change, or a long Notes outage) can
 * leave hundreds of notes stale; re-processing each SEQUENTIALLY inline
 * (~10-34s LLM call each) would run for hours, tripping `generationDollarCap`
 * and/or blowing past the 45-min trigger watchdog (bd6.11) — FAILING the
 * week. If the stale count exceeds `staleSyncThreshold`, the inline sync is
 * SKIPPED entirely (never started), an actionable alert fires (count,
 * approximate $/time, and the out-of-band `/resync-recipes` escape hatch —
 * RUNBOOK §6), and generation proceeds straight to `buildPlan` against the
 * EXISTING (possibly stale) index — degrade gracefully rather than fail the
 * week. Below the threshold (or when the pre-count itself fails — treated the
 * same as "unknown," not a reason to add a new failure mode), the normal
 * inline sync below runs exactly as before.
 */
export function makeBuildPlanWithSync(
  deps: BuildPlanWithSyncDeps,
): (weekKey: string) => Promise<EnrichedWeekPlan> {
  const {
    runSync: doSync,
    buildPlan,
    alert,
    logger = console,
    countStale,
    staleSyncThreshold = DEFAULT_STALE_SYNC_THRESHOLD,
  } = deps;

  return async (weekKey: string) => {
    if (countStale) {
      let stale: StaleCount | undefined;
      try {
        stale = await countStale();
      } catch (e) {
        logger.warn(
          `stale-recipe pre-count failed before generating week ${weekKey}; proceeding with the normal inline sync attempt: ${String(e)}`,
        );
      }

      if (stale !== undefined && stale.stale > staleSyncThreshold) {
        const estCostUsd = stale.stale * ESTIMATED_COST_PER_RECIPE_USD;
        const estMinutes = Math.ceil(
          (stale.stale * ESTIMATED_SECONDS_PER_RECIPE) / 60,
        );
        const message =
          `recipe sync would need to re-process ${stale.stale}/${stale.total} recipes ` +
          `before generating week ${weekKey} (exceeds staleSyncThreshold=${staleSyncThreshold}) ` +
          `— approx $${estCostUsd.toFixed(2)} / ~${estMinutes} min if run inline, which would ` +
          `risk the generation $ cap and/or the trigger watchdog. SKIPPING inline sync and ` +
          `proceeding to generate this week's plan against the EXISTING (possibly stale) index. ` +
          `Run the out-of-band full re-sync to backfill: the /resync-recipes skill, or ` +
          `MP_GENERATION_DOLLAR_CAP=20 pnpm sync (see docs/RUNBOOK.md §6).`;
        logger.warn(message);
        try {
          await alert(message);
        } catch (alertErr) {
          logger.warn(
            `alert during mass-stale-sync skip also failed for week ${weekKey}: ${String(alertErr)}`,
          );
        }
        return buildPlan(weekKey);
      }
    }

    try {
      const r = await doSync();
      logger.log(
        `[sync] total=${r.total} processed=${r.processed} skipped=${r.skipped} extractionFailures=${r.extractionFailures} removed=${r.removed}`,
      );
      // A NON-throwing suspicious read (0 notes while the index holds recipes,
      // q95.14) is the denied/failed Notes-read fingerprint — macOS Automation
      // or Full Disk Access revoked (a fresh machine, a new binary path, or an
      // OS upgrade resetting TCC), or the recipe folder renamed. It is only a
      // console.warn inside syncNotes, which is invisible on the daemon; surface
      // it LOUDLY to #agent-alerts + the local log (fkg.7). We still PROCEED to
      // plan against the existing index (proceed + alert, matching the whole-
      // sync-failure policy below and q95.14's deliberate non-destructive skip).
      // Message is secret-free (counts + reason only, never a note body/title).
      if (r.suspiciousEmptyRead) {
        const message = `recipe sync read 0 notes from Apple Notes while the recipe index is non-empty before generating week ${weekKey}: suspected DENIED or failed Notes read (macOS Automation / Full Disk Access revoked, or the recipe folder was renamed) — NOT a mass delete. Skipped stale-recipe reconciliation and proceeding against the existing index. Re-verify TCC permissions for the daemon's node binary (see docs/RUNBOOK.md).`;
        logger.warn(message);
        try {
          await alert(message);
        } catch (alertErr) {
          logger.warn(
            `alert during suspicious-empty-read handling also failed for week ${weekKey}: ${String(alertErr)}`,
          );
        }
      }
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

/**
 * B5 operator-only pause reset (bd meal-planner-3e2.6/uo1, ADR-0007 D6): set
 * by `main()` once the v3.0 revision system is composed (see
 * {@link buildRevisionSystem}). No admin command surface (Slack slash
 * command, CLI) exists yet to bind this to -- that scope was explicitly left
 * to this boot-assembly task -- so this module-level export is the minimal
 * REACHABLE binding: an operator attached to the running process (e.g. a
 * `node --inspect` REPL, or a future admin command that imports this module)
 * can call `resetRevisionPause(weekKey)` directly to clear a `paused_cost`
 * thread. Stays `undefined` until `main()` runs (or when the app token is
 * absent, so the v3.0 revision loop was never composed).
 */
export let resetRevisionPause: ((weekKey: string) => void) | undefined;

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
  // Bounded retry-before-fail for a transient per-call stall (bd
  // meal-planner-k31, qjk follow-up). MUST wrap the OUTSIDE of
  // meteredLlmClient (see retryLlmClient's doc comment) so every retried
  // attempt -- not just the final one -- passes through the SAME cost-cap
  // gate and has its usage recorded individually; a retry can never spend
  // past generationDollarCap.
  const llm = retryLlmClient(
    meteredLlmClient(createLlmClient(config), meter, {
      capUsd: config.generationDollarCap,
    }),
    { maxRetries: config.llmCallMaxRetries },
  );
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

  // Process-level safety net (bd meal-planner-bd6.14): a stray rejection off
  // the awaited chain would otherwise crash silently while launchd KeepAlive
  // masks the flapping. Log durably + best-effort alert, then deliberately
  // exit(1) for a clean restart. Uses the same local-log path buildAlert
  // resolves internally (MP_LOG_PATH || DEFAULT_LOG_PATH).
  const fatalLogPath = process.env.MP_LOG_PATH || DEFAULT_LOG_PATH;
  const fatalHandler = makeFatalHandler({
    appendLocal: (message: string) =>
      appendLog(fatalLogPath, message, () => new Date()),
    alert,
    exit: (code: number) => process.exit(code),
  });
  process.on("unhandledRejection", (reason: unknown) => {
    void fatalHandler(reason);
  });
  process.on("uncaughtException", (err: unknown) => {
    void fatalHandler(err);
  });

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
        // Hard ceiling on paired side dishes per week (bd meal-planner-8zs.8).
        maxPairedSides: config.maxPairedSides,
        // v1.0 tag-based seasonality (bd meal-planner-8zs.9): derive the
        // current season from the wall clock in the configured zone. Read once
        // per real generation (buildPlanFor only runs past the idempotency
        // gate). main() is the clock-owning composition root — cf. nowDate
        // below. Flows to both the hard search filter and the soft prompt bias.
        season: seasonForDate(new Date(), config.timezone),
        // ADR-0004 D4/D6: fed to getWeekNightSchedule to derive slots from the
        // week's NightSchedule (degrades to the static cookNights count when
        // calendar.enabled is false or the live read fails).
        timezone: config.timezone,
        calendar: config.calendar,
        // ADR-0005 D3 (bd meal-planner-kro): threaded into
        // selectValidatedPlan's ValidatePlanConfig.quickActiveMax so the
        // QUICK-night capacity-fit day rule actually fires in production.
        quickActiveMax: config.quickActiveMax,
        // ADR-0003 A1 (bd bgb): household coords for the Open-Meteo
        // temperature_band fetch; unset lat/lon = weather skipped entirely.
        weather: config.weather,
      },
      household,
      deps: {
        search,
        llm,
        getRecipe: getRecipeBound,
        readEvents: readCalendarEvents,
        alert,
        getTemperatureBand,
        // D3 (bd meal-planner-v9v.3, ADR-0006, SPEC §6.3): `undefined` until
        // MP_TODOIST_API_TOKEN is configured (pre-v3.x boot), matching
        // `approvalHandler`'s own gate -- see `buildRecencyReader`'s doc.
        getRecentRecipeIds: buildRecencyReader(profile, secrets),
        getEmbedding: (id: string) => vectorStore.getEmbedding(id),
      },
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
    // Cheap pre-count (no embed/LLM) consulted BEFORE the inline sync above
    // (bd meal-planner-a9e) so a mass hash-invalidation is detected and
    // alerted on rather than run for hours inline.
    countStale: () =>
      countStale(
        { readNotes, vectorStore, structuredStore },
        { folderName: recipesFolder },
      ),
    staleSyncThreshold: config.staleSyncThreshold,
    buildPlan: rawBuildPlan,
    alert,
  });

  // Back up the session DB BEFORE constructing SessionStore (whose
  // constructor runs the migration runner). Rolling boot copy is best-effort;
  // a mandatory pre-migration copy is taken only when a real migration is
  // pending (bd6.13, boot-backup.ts). Uses the same injected-clock pattern as
  // nowIso below.
  await backupSessionDbAtBoot({
    sessionDbPath: profile.sqlitePath,
    nowIso: () => new Date().toISOString(),
  });

  const store = new SessionStore({ path: profile.sqlitePath });

  // B4 (bd meal-planner-3e2.5, ADR 0007 D4): ONE RevisionCoordinator
  // instance, shared between the composed revision chain below and the
  // approval handler, so `/mp-approve` always supersedes an
  // in-flight revision on the same week.
  const revisionCoordinator = createRevisionCoordinator();

  // C1 (bd meal-planner-iu7.2): the real /mp-approve commit handler,
  // wired into the slash-command router below via runDaemon's
  // approvalHandler option. `undefined` (a safe no-op) until
  // MP_TODOIST_API_TOKEN is configured.
  const approvalHandler = buildApprovalHandler(
    profile,
    secrets,
    store,
    revisionCoordinator,
  );

  // v3.0 revision loop (bd meal-planner-uo1, composing B1-B5): its own
  // `createLlmClient` instance, capped to `medium`/`low` effort (SPEC §9.3)
  // regardless of the generation `config.effort` -- deliberately NOT wrapped
  // in `meteredLlmClient`/`retryLlmClient`/`generationDollarCap` the way the
  // generation `llm` above is; B5's cost guard (below) is the revision
  // loop's own budget enforcement (ADR 0007 D5).
  const revisionEffort: Effort =
    config.effort === "high" || config.effort === "xhigh"
      ? "medium"
      : config.effort;
  // Shared across the revision-post reply, the cost guard's "paused for
  // cost" note, and the inbound router's expired-thread redirect -- all
  // three post plain thread replies with the same bot token.
  const revisionSlack = new WebClient(secrets.slackBotToken);
  const revisionSystem = buildRevisionSystem({
    sessionStore: store,
    coordinator: revisionCoordinator,
    llm: createLlmClient({ ...config, effort: revisionEffort }),
    getRecipe: getRecipeBound,
    // Mirrors `rawBuildPlan`'s `selectValidatedPlan` config above -- a
    // revision never adds/removes meals (see `buildRevisionPrompt`'s RULES),
    // so the expected slot counts are the SAME static `cookNights` shape
    // generation's own static/degraded fallback resolves to (ADR-0004 D6).
    validateConfig: {
      slots: config.cookNights,
      maxPairedSides: config.maxPairedSides,
      quickActiveMax: config.quickActiveMax,
      calendarEnabled: config.calendar.enabled,
    },
    slack: revisionSlack,
    channelId: profile.channelId,
    caps: {
      cycleTokenCap: config.revisionCycleTokenCap,
      threadTurnCap: config.revisionThreadTurnCap,
      threadDollarCap: config.revisionThreadDollarCap,
    },
    rate: config.modelRates[config.model],
    alert,
  });
  const revisionHandler = revisionSystem.revisionHandler;
  // B5 operator reset (ADR-0007 D6) -- see `resetRevisionPause`'s own doc
  // comment above for why this is the minimal reachable binding rather than
  // a built admin command surface.
  resetRevisionPause = revisionSystem.resetPause;

  // bd meal-planner-m49 (ADR-0007 D6): the real `/mp-resume` operator
  // command, wired into the slash-command router below via runDaemon's
  // resetPauseHandler option. Reuses the SAME revisionSlack client + channel
  // the revision chain posts its own confirmations/notes into.
  const resetPauseHandler = buildResetPauseHandler(
    revisionSystem.resetPause,
    store,
    revisionSlack,
    profile.channelId,
  );

  const post =
    profile.postMode === "post"
      ? buildSlackPost(profile, secrets)
      : buildDryRunPost(profile);

  // External dead-man switch (bd meal-planner-fkg.8, SPEC §9.4): a never-
  // throwing best-effort heartbeat pinged from onTrigger on a genuine run
  // (success -> base URL; caught failure -> `<url>/fail`). Disabled when
  // MP_HEALTHCHECK_URL is unset (makeHeartbeat(undefined) -> no-ops), so the
  // daemon behaves exactly as before until the external check is configured.
  const heartbeat = makeHeartbeat(config.healthcheckUrl);

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
    heartbeat,
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
    // Lets runDaemon attach the inbound event router (bd meal-planner-4u4.4)
    // to the Socket Mode connection once it opens, with the composed v3.0
    // revision chain (bd meal-planner-uo1) wired in above.
    sessionStore: store,
    revisionHandler,
    approvalHandler,
    resetPauseHandler,
    // A5 (bd meal-planner-4u4.5): lets the router post the one-time
    // expired-thread redirect reply for real, using the same Slack client +
    // channel the revision chain above posts into.
    redirect: { slack: revisionSlack, channelId: profile.channelId },
  });

  await handle.stopped;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
