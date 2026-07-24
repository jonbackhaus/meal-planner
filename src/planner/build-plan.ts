import type {
  CalendarEvent,
  CalendarReaderOptions,
} from "../calendar/calendar-reader.js";
import { getWeekNightSchedule } from "../calendar/week-night-schedule.js";
import type { CalendarConfig } from "../config/config.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { Recipe } from "../recipe-mcp/schema.js";
import { deriveSlots } from "./derive-slots.js";
import { type EnrichedWeekPlan, enrichPlan } from "./enrich.js";
import { buildPlannerInput } from "./input.js";
import {
  type ComposePoolsDeps,
  composePools,
  type PoolCompositionConfig,
} from "./pools.js";
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
 * 5. `enrichPlan(plan, { getRecipe })` — attaches the full `Recipe` to every chosen meal (8zs.5).
 * 6. Attaches the SAME `NightSchedule` from step 2 onto the enriched plan as
 *    `nightSchedule` (ADR 0005 D4, bd meal-planner-0v7.7) — render context for
 *    `renderPlan`'s capacity annotations. Threaded this way (an optional field
 *    on the returned `EnrichedWeekPlan`, see enrich.ts) rather than widening
 *    `BuildPlanFn`/`PostFn` (`orchestrator/generate.ts`), so it rides the SAME
 *    object `generateForWeek` already carries through `buildPlan -> post ->
 *    working_plan` without touching that contract.
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

  const pools = await composePools(seeds, cfg, { search: deps.search });

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

  const input = buildPlannerInput({
    weekKey,
    slots,
    pools,
    nightSchedule: schedule,
    household,
    currentSeason: cfg.season,
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

  const enriched = await enrichPlan(plan, { getRecipe: deps.getRecipe });
  // ADR 0005 D4 (bd meal-planner-0v7.7): carry the SAME NightSchedule the
  // selection call reasoned over onto the returned plan as render context —
  // see enrich.ts's `EnrichedWeekPlan.nightSchedule` doc for why this rides
  // the plan object rather than a separate return value.
  return { ...enriched, nightSchedule: schedule };
}
