import type { Config } from "../config/config.js";
import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import type { SearchFilters } from "../recipe-mcp/search.js";

/**
 * Deterministic candidate-pool composition (ADR 0001 "How the orchestrator
 * uses it", ADR 0003 D1, SPEC §6.4).
 *
 * "The code guarantees, the LLM decides": this module composes the
 * weeknight + weekend candidate pools with code-side policy — slot counts,
 * `active_max`, veg-floor top-up, best-effort untested injection — entirely
 * BEFORE any LLM sees a candidate. No agentic search loop in v1.0: `search`
 * is called a bounded, deterministic number of times per pool.
 *
 * This module never invokes an LLM. It depends only on an injected `search`
 * callback (see `ComposePoolsDeps`) — never on `searchRecipes`'s own deps
 * (embedder/vector store/structured store) — so tests can supply a fake
 * `search` with canned `RecipeCandidate[]` and no real embeddings.
 */

export interface Pools {
  weeknight: RecipeCandidate[];
  weekend: RecipeCandidate[];
}

/**
 * The slice of `Config` this module needs. `season` isn't yet a field on
 * `Config` (no current-season signal is wired up), so it's modeled here as
 * an optional extra rather than picked from `Config` — callers may pass it
 * once that signal exists without this module's contract changing.
 */
export type PoolCompositionConfig = Pick<
  Config,
  | "cookNights"
  | "activeMaxMinutes"
  | "fanoutMultiplier"
  | "vegFloorK"
  | "untestedRate"
> & {
  season?: string;
};

export interface ComposePoolsDeps {
  /**
   * A bound `search(query, filters)` callback — i.e. `searchRecipes` with
   * its own deps (embedder, vector store, structured store) already
   * partially applied. Injecting the bound callback (rather than
   * `searchRecipes` + its deps) keeps this module from needing to know
   * about embeddings/storage at all, and lets tests pass a plain fake.
   */
  search: (
    query: string,
    filters?: SearchFilters,
  ) => Promise<RecipeCandidate[]>;
}

/**
 * Over-fetch factor for the untested-injection query (step 4): the injection
 * asks for a broader result set (`poolSize * this`) over the untested-filtered
 * search so enough distinct `quality === "untested"` candidates survive dedup
 * to reach the target count.
 */
const UNTESTED_OVERFETCH_MULTIPLIER = 3;

/**
 * Composes the weeknight + weekend candidate pools per ADR 0001/0003, using
 * quality-aware retrieval (bd meal-planner-8zs.6):
 *
 * 1. Weeknight pool: for each seed, `search(seed, { active_max, season?,
 *    quality: "rated", limit: constrained * fanout })` — only RATED (3/4/5-star)
 *    recipes form the known-good base; each seed's results are merged+deduped,
 *    per-seed capped so no one seed dominates.
 * 2. Weekend pool: same, WITHOUT `active_max` (do-aheads etc. stay eligible).
 * 3. Veg floor: if a pool has fewer than `vegFloorK` `veg_status:
 *    "vegetarian"` candidates, top it up with a rated `veg_status:
 *    "vegetarian"` query over the SAME pool filters (weeknight keeps
 *    `active_max`) and merge, deduping by `id`.
 * 4. Untested injection (ADR 0003 D2): re-inject up to `ceil(untestedRate *
 *    poolSize)` `quality === "untested"` candidates via a `quality: "untested"`
 *    search (NOT the rated base filter) so the pool holds a CONTROLLED
 *    discovery fraction rather than being dominated by untested recipes.
 *
 * All merges dedupe by `id`, preserving existing-pool order first, then
 * newly-added candidates in the order they were returned.
 */
export async function composePools(
  seeds: string[],
  cfg: PoolCompositionConfig,
  deps: ComposePoolsDeps,
): Promise<Pools> {
  const { search } = deps;

  // Dinners only: side dishes / desserts / breakfasts / appetizers (by their
  // NoteStore course tags) are never valid standalone weeknight/weekend meals.
  const weeknightFilters: SearchFilters = {
    active_max: cfg.activeMaxMinutes,
    main_dinner_only: true,
    ...(cfg.season !== undefined ? { season: cfg.season } : {}),
    limit: cfg.cookNights.constrained * cfg.fanoutMultiplier,
  };
  const weekendFilters: SearchFilters = {
    main_dinner_only: true,
    ...(cfg.season !== undefined ? { season: cfg.season } : {}),
    limit: cfg.cookNights.relaxed * cfg.fanoutMultiplier,
  };

  // Sequential (not Promise.all): keeps per-pool call ordering simple and
  // easy to reason about/test; this runs once per plan cycle, not on a hot
  // path, so the (small) latency cost of not parallelizing is a non-issue.
  const weeknight = await composePool(seeds, weeknightFilters, cfg, search);
  const weekend = await composePool(seeds, weekendFilters, cfg, search);

  return { weeknight, weekend };
}

async function composePool(
  seeds: string[],
  baseFilters: SearchFilters,
  cfg: PoolCompositionConfig,
  search: ComposePoolsDeps["search"],
): Promise<RecipeCandidate[]> {
  // Multi-seed retrieval (bd meal-planner-8zs.6 Stage 2 / l7x): a single generic
  // seed under-recalls (its nearest neighbours are a narrow, low-signal cluster),
  // so the base pool is built from a SET of category seeds. Each seed contributes
  // up to `perSeedCap` NEW candidates (round-robin fairness so no one seed
  // dominates), merged+deduped up to the pool's target size.
  //
  // Quality-aware (Stage 1): the base + veg-floor pull only RATED (3/4/5-star)
  // recipes — the "known-good" set — so the pool isn't dominated by untested
  // candidates that merely rank near a seed. `untestedRate` then re-injects a
  // CONTROLLED fraction of untested recipes for discovery (see injectUntested,
  // which deliberately does NOT carry the rated filter).
  const targetSize = baseFilters.limit ?? 0;
  const perSeedCap = Math.max(
    1,
    Math.ceil(targetSize / Math.max(1, seeds.length)),
  );
  const ratedFilters: SearchFilters = { ...baseFilters, quality: "rated" };

  let basePool: RecipeCandidate[] = [];
  for (const seed of seeds) {
    if (basePool.length >= targetSize) {
      break;
    }
    const hits = await search(seed, ratedFilters);
    const room = Math.min(perSeedCap, targetSize - basePool.length);
    basePool = mergeDeduped(basePool, hits, room);
  }

  const withVegFloor = await ensureVegFloor(
    seeds,
    basePool,
    ratedFilters,
    cfg.vegFloorK,
    search,
  );
  return injectUntested(
    seeds,
    withVegFloor,
    baseFilters,
    cfg.untestedRate,
    search,
  );
}

/**
 * Step 3: veg-floor top-up, iterating the seed set until the pool holds
 * `vegFloorK` rated vegetarian candidates. Each seed runs a rated
 * `veg_status: "vegetarian"` search; only as many NEW candidates as still
 * needed to reach the floor are merged in (deduped by `id`), so the pool
 * doesn't balloon past its intended size. With multi-seed retrieval the base
 * often already meets the floor (a vegetarian seed surfaces rated-veg), making
 * this a fallback.
 *
 * LIMITATION (documented, not fixed here): still best-effort — if the seeds'
 * rated-veg results are exhausted before the floor is reached (a small corpus,
 * or re-surfacing ids already in the pool), the pool may remain below
 * `vegFloorK`.
 */
async function ensureVegFloor(
  seeds: string[],
  pool: RecipeCandidate[],
  baseFilters: SearchFilters,
  vegFloorK: number,
  search: ComposePoolsDeps["search"],
): Promise<RecipeCandidate[]> {
  let result = pool;
  const vegCount = () =>
    result.filter((c) => c.veg_status === "vegetarian").length;

  for (const seed of seeds) {
    if (vegCount() >= vegFloorK) {
      break;
    }
    const topUp = await search(seed, {
      ...baseFilters,
      veg_status: "vegetarian",
    });
    result = mergeDeduped(result, topUp, vegFloorK - vegCount());
  }
  return result;
}

/**
 * Step 4: controlled untested injection (ADR 0003 D2). Iterates the seed set,
 * running a `quality: "untested"` search over the SAME eligibility filters
 * (active_max, season, main_dinner_only — but NOT the rated base filter, or it
 * could never surface untested) and merging up to `ceil(untestedRate *
 * poolSize)` new untested candidates. Stops once the target is met; a no-op if
 * `untestedRate` is 0 or the seeds hold no matching untested recipes.
 */
async function injectUntested(
  seeds: string[],
  pool: RecipeCandidate[],
  baseFilters: SearchFilters,
  untestedRate: number,
  search: ComposePoolsDeps["search"],
): Promise<RecipeCandidate[]> {
  const targetCount = Math.ceil(untestedRate * pool.length);
  if (targetCount === 0) {
    return pool;
  }

  let result = pool;
  const untestedCount = () =>
    result.filter((c) => c.quality === "untested").length;

  for (const seed of seeds) {
    const needed = targetCount - untestedCount();
    if (needed <= 0) {
      break;
    }
    const overfetched = await search(seed, {
      ...baseFilters,
      quality: "untested",
      limit: pool.length * UNTESTED_OVERFETCH_MULTIPLIER,
    });
    const untestedFound = overfetched.filter((c) => c.quality === "untested");
    result = mergeDeduped(result, untestedFound, needed);
  }
  return result;
}

/**
 * Merges `toAdd` into `existing`, deduping by `id` (an id already present in
 * `existing` is never re-added). Existing candidates keep their order first;
 * new candidates are appended in the order they were returned. `maxAdd`
 * (when given) caps how many NEW (non-duplicate) candidates are accepted —
 * used by untested injection to stop once the target count is reached.
 */
function mergeDeduped(
  existing: RecipeCandidate[],
  toAdd: RecipeCandidate[],
  maxAdd = Number.POSITIVE_INFINITY,
): RecipeCandidate[] {
  const seen = new Set(existing.map((c) => c.id));
  const merged = [...existing];
  let added = 0;

  for (const candidate of toAdd) {
    if (added >= maxAdd) {
      break;
    }
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    merged.push(candidate);
    added += 1;
  }

  return merged;
}
