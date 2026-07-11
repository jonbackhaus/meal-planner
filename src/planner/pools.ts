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
 * Over-fetch factor for the best-effort untested-injection overfetch query
 * (step 4), mirroring the spirit of `search.ts`'s `OVER_FETCH_FACTOR`: since
 * `searchRecipes` has no quality/untested filter, the only way to surface
 * `quality === "untested"` candidates is to ask for a broader result set
 * over the SAME eligibility filters and see what naturally turns up.
 */
const UNTESTED_OVERFETCH_MULTIPLIER = 3;

/**
 * Composes the weeknight + weekend candidate pools per ADR 0001/0003:
 *
 * 1. Weeknight pool: `search(seedQuery, { active_max, season?, limit:
 *    constrained * fanout })`.
 * 2. Weekend pool: same, WITHOUT `active_max` (do-aheads etc. stay eligible).
 * 3. Veg floor: if a pool has fewer than `vegFloorK` `veg_status:
 *    "vegetarian"` candidates, top it up with a `veg_status: "vegetarian"`
 *    query over the SAME pool filters (weeknight keeps `active_max`) and
 *    merge, deduping by `id`.
 * 4. Untested injection (best-effort, retrieval-level — ADR 0003 D2): ensure
 *    the pool holds up to `ceil(untestedRate * poolSize)` `quality ===
 *    "untested"` candidates by over-fetching a broader result set over the
 *    same filters and retaining whatever untested candidates surface, up to
 *    the target. If none surface, this is a no-op — see the module doc.
 *
 * All merges dedupe by `id`, preserving existing-pool order first, then
 * newly-added candidates in the order they were returned.
 */
export async function composePools(
  seedQuery: string,
  cfg: PoolCompositionConfig,
  deps: ComposePoolsDeps,
): Promise<Pools> {
  const { search } = deps;

  const weeknightFilters: SearchFilters = {
    active_max: cfg.activeMaxMinutes,
    ...(cfg.season !== undefined ? { season: cfg.season } : {}),
    limit: cfg.cookNights.constrained * cfg.fanoutMultiplier,
  };
  const weekendFilters: SearchFilters = {
    ...(cfg.season !== undefined ? { season: cfg.season } : {}),
    limit: cfg.cookNights.relaxed * cfg.fanoutMultiplier,
  };

  // Sequential (not Promise.all): keeps per-pool call ordering simple and
  // easy to reason about/test; this runs once per plan cycle, not on a hot
  // path, so the (small) latency cost of not parallelizing is a non-issue.
  const weeknight = await composePool(seedQuery, weeknightFilters, cfg, search);
  const weekend = await composePool(seedQuery, weekendFilters, cfg, search);

  return { weeknight, weekend };
}

async function composePool(
  seedQuery: string,
  baseFilters: SearchFilters,
  cfg: PoolCompositionConfig,
  search: ComposePoolsDeps["search"],
): Promise<RecipeCandidate[]> {
  const basePool = await search(seedQuery, baseFilters);
  const withVegFloor = await ensureVegFloor(
    seedQuery,
    basePool,
    baseFilters,
    cfg.vegFloorK,
    search,
  );
  return injectUntested(
    seedQuery,
    withVegFloor,
    baseFilters,
    cfg.untestedRate,
    search,
  );
}

/**
 * Step 3: veg-floor top-up, merged and deduped by `id`, capped at the actual
 * deficit (`vegFloorK - vegCount`) via `mergeDeduped`'s `maxAdd` — mirroring
 * `injectUntested`'s capping below. The top-up query's `limit` is
 * intentionally left at the full pool size (unbounded search result), but
 * only as many NEW candidates as still needed to reach the floor are merged
 * in, so the pool doesn't balloon past its intended
 * `constrained/relaxed * fanoutMultiplier` size.
 *
 * LIMITATION (documented, not fixed here): this is single-shot best-effort,
 * like `injectUntested` — a top-up may still leave the pool below
 * `vegFloorK` (e.g. a small corpus, or the top-up re-surfacing ids already in
 * the pool instead of new ones).
 */
async function ensureVegFloor(
  seedQuery: string,
  pool: RecipeCandidate[],
  baseFilters: SearchFilters,
  vegFloorK: number,
  search: ComposePoolsDeps["search"],
): Promise<RecipeCandidate[]> {
  const vegCount = pool.filter((c) => c.veg_status === "vegetarian").length;
  if (vegCount >= vegFloorK) {
    return pool;
  }

  const topUp = await search(seedQuery, {
    ...baseFilters,
    veg_status: "vegetarian",
  });
  return mergeDeduped(pool, topUp, vegFloorK - vegCount);
}

/**
 * Step 4: best-effort untested injection (ADR 0003 D2). `searchRecipes` has
 * no quality/untested filter (and this task does NOT modify it — see the
 * module doc), so this over-fetches a broader set over the SAME eligibility
 * filters and keeps whatever `quality === "untested"` candidates surface, up
 * to the target count. If the target is already met, or nothing untested
 * surfaces in the broader fetch, this is a no-op.
 *
 * LIMITATION (documented, not fixed here): because there's no dedicated
 * retrieval-level filter for untested/quality, this can under-deliver (or
 * even fail to find any untested candidates at all) on a pool/corpus where
 * none happen to rank within the overfetch window — a possible follow-up is
 * a `quality`/untested filter on `search_recipes` itself.
 */
async function injectUntested(
  seedQuery: string,
  pool: RecipeCandidate[],
  baseFilters: SearchFilters,
  untestedRate: number,
  search: ComposePoolsDeps["search"],
): Promise<RecipeCandidate[]> {
  const targetCount = Math.ceil(untestedRate * pool.length);
  if (targetCount === 0) {
    return pool;
  }

  const alreadyPresent = pool.filter((c) => c.quality === "untested").length;
  const needed = targetCount - alreadyPresent;
  if (needed <= 0) {
    return pool;
  }

  const overfetched = await search(seedQuery, {
    ...baseFilters,
    limit: pool.length * UNTESTED_OVERFETCH_MULTIPLIER,
  });
  const untestedFound = overfetched.filter((c) => c.quality === "untested");
  return mergeDeduped(pool, untestedFound, needed);
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
