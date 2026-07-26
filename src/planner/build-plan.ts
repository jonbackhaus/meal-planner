import type {
  CalendarEvent,
  CalendarReaderOptions,
} from "../calendar/calendar-reader.js";
import { toNightCapacitySchedule } from "../calendar/night-schedule.js";
import { getWeekNightSchedule } from "../calendar/week-night-schedule.js";
import type { CalendarConfig, WeatherConfig } from "../config/config.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { Recipe, RecipeCandidate } from "../recipe-mcp/schema.js";
import type { TemperatureBand } from "../weather/weather.js";
import { deriveSlots } from "./derive-slots.js";
import { type EnrichedWeekPlan, enrichPlan } from "./enrich.js";
import { buildPlannerInput } from "./input.js";
import { placePrepUnits } from "./place-prep.js";
import {
  type ComposePoolsDeps,
  composePools,
  type PoolCompositionConfig,
  type Pools,
} from "./pools.js";
import { applyRecencyDedup } from "./recency-dedup.js";
import { assertPoolsSufficient, selectValidatedPlan } from "./validate.js";

/**
 * The planner's public entry point (ADR 0002 `buildPlan(wk)`) — the single
 * function E3's `generateForWeek` calls. Chains the whole planner pipeline:
 * `composePools` -> `buildPlannerInput` -> `selectValidatedPlan` ->
 * `enrichPlan`. Building the orchestrator/state-machine/`generateForWeek`
 * ITSELF is out of scope here (E3) — this is only what it calls.
 */

/**
 * v1.0's default semantic seed SET (ADR 0003 / bd meal-planner-l7x, resolved in
 * 8zs.6): a category-seeded multi-query, NOT a single generic seed. Live
 * measurement showed one bland seed under-recalls — its nearest neighbours are
 * a narrow, low-signal cluster (only ~2 rated dinners, 0 rated-veg, of its top
 * 48) — so `composePools` retrieves a coherent cluster per seed and merges them
 * (per-seed capped for fairness). One seed is explicitly vegetarian to guarantee
 * rated-veg coverage for the every-night vegetarian constraint. Seed wording is
 * tunable (part of 8zs.6). Callers may override per-run via `cfg.seeds`.
 */
export const DEFAULT_SEEDS: string[] = [
  "vegetarian family dinner",
  "chicken dinner",
  "beef or pork main dish",
  "fish or seafood dinner",
  "pasta, noodle, or grain bowl dinner",
  "curry, stir-fry, or braise",
];

/**
 * The planner-relevant `Config` subset `buildPlan` needs: everything
 * `composePools` needs (`cookNights` — the ADR-0004 D6 static-fallback slot
 * counts, and `composePools`'s own `active_max` gate — `activeMaxMinutes`,
 * `fanoutMultiplier`, `vegFloorK`, `untestedRate`, optional `season`), plus
 * `timezone` + `calendar` (ADR-0004 D4/D6 — fed to `getWeekNightSchedule` to
 * derive `slots`, replacing the old static `cookNights`-as-slots read), plus
 * an optional `seeds` override (see `DEFAULT_SEEDS` above), plus
 * `quickActiveMax` (ADR-0004 D4; threaded into `selectValidatedPlan`'s
 * `ValidatePlanConfig` — ADR-0005 D3 rule 3, "capacity fit" — bd
 * meal-planner-kro).
 */
export type BuildPlanConfig = PoolCompositionConfig & {
  seeds?: string[];
  timezone: string;
  calendar: CalendarConfig;
  quickActiveMax: number;
  /** Household coordinates for the Open-Meteo `temperature_band` fetch (ADR-0003 A1). Unset lat/lon = weather skipped, seasonal-only. */
  weather: WeatherConfig;
};

export interface BuildPlanDeps {
  /** A bound `search(query, filters)` callback — `search_recipes` with its own deps applied. */
  search: ComposePoolsDeps["search"];
  llm: LlmClient;
  /** A bound `getRecipe(id)` callback — `get_recipe` with its own deps applied. */
  getRecipe: (id: string) => Promise<Recipe | null>;
  /**
   * Bound calendar-event reader (ADR-0004 D1) — `readCalendarEvents` in
   * production; tests inject a fake so `buildPlan` never touches a live
   * EventKit read. Fed to `getWeekNightSchedule` (ADR-0004 D4/D6).
   */
  readEvents: (options: CalendarReaderOptions) => Promise<CalendarEvent[]>;
  /**
   * The never-throwing `#agent-alerts` composite (same one wired through
   * `src/index.ts`'s `buildAlert`) — `getWeekNightSchedule` fires it exactly
   * once on the ADR-0004 D6 degrade path.
   */
  alert: (message: string) => Promise<void>;
  /** Injectable for tests; defaults to `console` inside `getWeekNightSchedule`. */
  logger?: Pick<Console, "warn" | "error">;
  /**
   * Bound Open-Meteo fetch (ADR-0003 A1, bd `bgb`) — production wiring binds
   * `getTemperatureBand` from `src/weather/weather.ts`; tests inject a stub so
   * `buildPlan` never makes a live fetch. Degrades to `null` (seasonal-only)
   * on ANY failure internally — SILENT: unlike `alert` above, no alert is
   * ever fired for a weather miss (weather is advisory, ADR-0003 A1; this is
   * not the calendar's alert-once degrade, ADR-0004 D6).
   */
  getTemperatureBand: (args: {
    weekKey: string;
    timezone: string;
    latitude: number;
    longitude: number;
  }) => Promise<TemperatureBand | null>;
  /**
   * Recency read (bd meal-planner-v9v.3, ADR-0006, SPEC §6.3) — resolves the
   * recent (Todoist-completed) recipe ids to dedup against. Optional: absent
   * (v2.0-style boot, no Todoist token configured) means "recency not wired
   * this run" and `buildPlan` behaves exactly as before (no dedup). Bound in
   * production from `readRecentRecipeIds` + an assembled `TodoistClient` (see
   * `src/index.ts`'s `buildRecencyReader`, mirroring `buildApprovalHandler`'s
   * client assembly); tests inject a plain fake so no real Todoist is needed.
   *
   * DEGRADE SILENTLY (SPEC §6.3, the load-bearing requirement): `buildPlan`
   * itself catches a throw from this (missing/expired token, network/timeout,
   * a malformed response) and proceeds with an EMPTY recent set — recency
   * must never fail or block the weekly generation.
   */
  getRecentRecipeIds?: () => Promise<string[]>;
  /**
   * Embedding lookup for the §6.3 semantic penalty (`recency-dedup.ts`'s
   * `RecencyDedupDeps.getEmbedding`) — production binds `VectorStore.getEmbedding`.
   * Only consulted when `getRecentRecipeIds` resolves a non-empty recent set;
   * omitting it (while `getRecentRecipeIds` is present) simply skips the
   * semantic-penalty reorder — exact `exclude_ids` exclusion still applies.
   */
  getEmbedding?: (recipeId: string) => number[] | null;
}

export interface BuildPlanArgs {
  weekKey: string;
  cfg: BuildPlanConfig;
  /**
   * Caller-supplied household prose (vegetarian daughter, picky-youngest,
   * etc.) — sourced from config/env by the orchestrator, not this module.
   * See `PlannerInput.household`'s doc in `input.ts`.
   */
  household: string;
  deps: BuildPlanDeps;
}

/**
 * Runs the full planner pipeline for one week:
 * 1. `composePools(seedQuery, cfg, { search })` — code-composed candidate pools.
 * 2. `getWeekNightSchedule(...)` + `deriveSlots(...)` — the week's `NightSchedule`
 *    (real read, or the ADR-0004 D6 static fallback) and the slot counts derived
 *    from it (ADR-0004 D4; replaces the old static `cfg.cookNights`-as-slots read).
 * 3. `buildPlannerInput(...)` — assembles the typed selection input from those SAME pools
 *    AND that SAME `NightSchedule` (ADR-0005 D1: selection and day-assignment co-reason
 *    in the one selection call, so the model sees the very schedule `slots` was derived from).
 * 4. `selectValidatedPlan(input, pools, cfg, { llm })` — one selection call, validated
 *    against those SAME pools, with the one bounded repair retry (8zs.4).
 * 5. `placePrepUnits(plan.meals, schedule)` — deterministic prep-unit placement
 *    (ADR-0004 D5, bd meal-planner-468.2) off that SAME `schedule`; attached as
 *    `plan.prep` BEFORE enrich.
 * 6. `enrichPlan(plan, { getRecipe })` — attaches the full `Recipe` to every chosen meal (8zs.5).
 * 7. Attaches a COMPACT, PII-free projection of the SAME `NightSchedule` from
 *    step 2 onto the enriched plan as `nightSchedule` (ADR 0005 D4, bd
 *    meal-planner-0v7.7; compacted in bd meal-planner-0v7.8 via
 *    `toNightCapacitySchedule` — date/weekday/capacity only, `blocking_events`
 *    event titles dropped) — render context for `renderPlan`'s capacity
 *    annotations. Threaded this way (an optional field on the returned
 *    `EnrichedWeekPlan`, see enrich.ts) rather than widening
 *    `BuildPlanFn`/`PostFn` (`orchestrator/generate.ts`), so it rides the SAME
 *    object `generateForWeek` already carries through `buildPlan -> post ->
 *    working_plan` without touching that contract — meaning `working_plan`
 *    never contains raw calendar event titles.
 *
 * The SAME `pools` value from step 1 is passed into BOTH step 3 (selection input)
 * and step 4 (validation) — a plan that references an id outside those pools
 * fails validation (and, after the bounded repair, throws `PlanValidationError`)
 * rather than silently passing.
 */
export async function buildPlan(
  args: BuildPlanArgs,
): Promise<EnrichedWeekPlan> {
  const { weekKey, cfg, household, deps } = args;
  const seeds = cfg.seeds ?? DEFAULT_SEEDS;

  // Recency read (bd meal-planner-v9v.3, ADR-0006, SPEC §6.3) — BEFORE pool
  // composition, so recent recipes are excluded at retrieval, not filtered
  // after the fact. `deps.getRecentRecipeIds` is optional (pre-v3.x boot, no
  // Todoist token) AND degrades silently on ANY failure: SPEC §6.3 requires
  // recency to NEVER fail or block the week, so a throw here (expired token,
  // network/timeout, malformed response) is caught, logged, and treated
  // exactly like "no recent ids" rather than propagating.
  let recentRecipeIds: string[] = [];
  if (deps.getRecentRecipeIds) {
    try {
      recentRecipeIds = await deps.getRecentRecipeIds();
    } catch (e) {
      (deps.logger ?? console).warn(
        `recency read failed before generating week ${weekKey}; proceeding with no dedup: ${String(e)}`,
      );
    }
  }

  // Exact exclusion (ADR-0006 D2): fold the resolved recent ids into every
  // search call's `exclude_ids` (already wired, `search.ts`/`vector-store.ts`)
  // via a thin wrapper around `deps.search` — a no-op when there are none.
  const searchDeps: ComposePoolsDeps["search"] =
    recentRecipeIds.length === 0
      ? deps.search
      : (query, filters) =>
          deps.search(query, {
            ...filters,
            exclude_ids: [...(filters?.exclude_ids ?? []), ...recentRecipeIds],
          });

  let pools = await composePools(seeds, cfg, { search: searchDeps });

  // Semantic penalty (ADR-0006 D2, SPEC §6.3): re-rank each pool by closeness
  // to the recently-eaten recipes' embeddings (soft bias, exact repeats are
  // already hard-excluded above). Skipped when there's nothing to penalize
  // against, or no embedding lookup was supplied.
  if (recentRecipeIds.length > 0 && deps.getEmbedding) {
    pools = rerankPoolsByRecency(pools, recentRecipeIds, deps.getEmbedding);
  }

  // ADR-0004 D4: slots are DERIVED from the week's NightSchedule, not static
  // config — non-NONE weeknights -> constrained, non-NONE weekend nights ->
  // relaxed. `getWeekNightSchedule` itself degrades to the static v1.0
  // `cfg.cookNights` count (all-FULL, sized exactly to those counts) when
  // `cfg.calendar.enabled` is false or the live read fails (ADR-0004 D6), so
  // `deriveSlots` reproduces the old static behavior unchanged in that case.
  const schedule = await getWeekNightSchedule({
    weekKey,
    config: {
      timezone: cfg.timezone,
      calendar: cfg.calendar,
      cookNights: cfg.cookNights,
    },
    readEvents: deps.readEvents,
    alert: deps.alert,
    logger: deps.logger,
  });
  const slots = deriveSlots(schedule);

  // Pool-sufficiency pre-check (bd meal-planner-8zs.12): fail deterministically
  // BEFORE any (paid) LLM call when the composed pools can't satisfy the slot
  // counts — an empty/thin index, a tag wipe, or an over-selective filter combo
  // would otherwise burn the selection AND repair calls and then throw a
  // misleading PlanValidationError. `InsufficientPoolError` propagates to
  // `generateForWeek`'s failed+alert path with an actionable, secret-free message.
  assertPoolsSufficient(pools, slots);

  // ADR-0003 A1 (bd bgb): week-level temperature_band, fetched only when the
  // household location is configured. Missing lat/lon is treated the same as
  // any other degrade — proceed seasonal-only, no error, no alert — since
  // `deps.getTemperatureBand` itself already silently maps a fetch failure to
  // `null` (see its doc above).
  const temperatureBand =
    cfg.weather.latitude !== undefined && cfg.weather.longitude !== undefined
      ? await deps.getTemperatureBand({
          weekKey,
          timezone: cfg.timezone,
          latitude: cfg.weather.latitude,
          longitude: cfg.weather.longitude,
        })
      : null;

  const input = buildPlannerInput({
    weekKey,
    slots,
    pools,
    nightSchedule: schedule,
    household,
    currentSeason: cfg.season,
    temperatureBand: temperatureBand ?? undefined,
    maxPairedSides: cfg.maxPairedSides,
  });

  const plan = await selectValidatedPlan(
    input,
    pools,
    {
      slots,
      maxPairedSides: cfg.maxPairedSides,
      // ADR-0005 D3 (bd meal-planner-kro): activate the day rules that were
      // implemented-but-dormant in 0v7.3. `calendarEnabled` mirrors
      // `cfg.calendar.enabled` exactly — including the ADR-0004 D6 degraded
      // fallback case, where `enabled` is still `true` but
      // `getWeekNightSchedule` internally substitutes a static schedule (see
      // `ValidatePlanConfig.calendarEnabled`'s doc: the non-null gate is keyed
      // on "real schedule available", which the fallback still provides).
      // When `cfg.calendar.enabled` is false, this stays false, so a null
      // `day` on the degraded/disabled path remains lenient.
      calendarEnabled: cfg.calendar.enabled,
      quickActiveMax: cfg.quickActiveMax,
    },
    { llm: deps.llm },
  );

  // ADR-0004 D5 (bd meal-planner-468.2): deterministic prep-unit placement —
  // for each validated do-ahead meal, place its PrepUnit onto an earlier
  // suitable night off the SAME `schedule` slots was derived from. Attached
  // BEFORE enrich so `enrichPlan`'s existing `plan.prep` passthrough (see
  // enrich.ts) carries it onto the returned `EnrichedWeekPlan` unchanged.
  const planWithPrep = { ...plan, prep: placePrepUnits(plan.meals, schedule) };

  const enriched = await enrichPlan(planWithPrep, {
    getRecipe: deps.getRecipe,
  });
  // ADR 0005 D4 (bd meal-planner-0v7.7), compacted in bd meal-planner-0v7.8:
  // carry a COMPACT, PII-free projection (date/weekday/capacity, no
  // blocking_events) of the SAME NightSchedule the selection call reasoned
  // over onto the returned plan as render context — see enrich.ts's
  // `EnrichedWeekPlan.nightSchedule` doc for why this rides the plan object
  // rather than a separate return value.
  return { ...enriched, nightSchedule: toNightCapacitySchedule(schedule) };
}

/**
 * Applies `recency-dedup.ts`'s `applyRecencyDedup` to each pool independently
 * (bd meal-planner-v9v.3, ADR-0006 D2, SPEC §6.3) — the ranking penalty is
 * per-pool, and `Pools.sides` is optional, so each is handled on its own.
 * Recent ids should already be absent from every pool (excluded at search
 * time, see `searchDeps` above), so `excludeIds` filtering here is a
 * defense-in-depth no-op; the real effect is the ascending-penalty reorder
 * (least recent-like first).
 */
function rerankPoolsByRecency(
  pools: Pools,
  recentRecipeIds: string[],
  getEmbedding: (recipeId: string) => number[] | null,
): Pools {
  const rerank = (candidates: RecipeCandidate[]) =>
    applyRecencyDedup(recentRecipeIds, candidates, { getEmbedding }).ranked.map(
      (r) => r.candidate,
    );

  return {
    weeknight: rerank(pools.weeknight),
    weekend: rerank(pools.weekend),
    sides: pools.sides ? rerank(pools.sides) : pools.sides,
  };
}
