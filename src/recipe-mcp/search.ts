import type { Embedder } from "./embedder.js";
import type { ExtractedFields } from "./extraction.js";
import type { Minutes, RecipeCandidate, VegStatus } from "./schema.js";
import type { StructuredStore } from "./structured-store.js";
import { type TagMetadata, tagMetadata } from "./tag-metadata.js";
import type { SearchResult, VectorStore } from "./vector-store.js";

/**
 * Cheap-tier `search_recipes` retrieval (ADR 0001 D2/D3, bd meal-planner-q95.4).
 *
 * Per ADR 0003 D1, v1.0's orchestrator calls this DETERMINISTICALLY (no
 * agentic LLM loop around it) — it is a directly-callable async function,
 * not an MCP stdio server. That wrapper, if ever needed, is a separate,
 * later concern.
 *
 * Pipeline: embed the query -> vector-search for similarity-ranked
 * candidates -> load each candidate's cached structured fields -> apply
 * deterministic filter predicates over those fields -> assemble lightweight
 * `RecipeCandidate`s (NO ingredient block — that's `get_recipe`, q95.5).
 */

export interface SearchFilters {
  /** HARD weeknight gate, fail-closed — see `passesActiveMax` below. */
  active_max?: Minutes;
  /** Keep only candidates whose veg_status equals this (e.g. to top up the veg floor). */
  veg_status?: VegStatus;
  /** Keep only candidates whose season_tags include this. */
  season?: string;
  /** Include-any: keep candidates whose effort_tags intersect this list (see note below). */
  effort?: string[];
  /** HARD course gate: drop candidates that aren't standalone dinners (#side/#dessert/#breakfast/#appetizer). */
  main_dinner_only?: boolean;
  /** v2.0 recency dedup — wired now, passed through to the vector store. */
  exclude_ids?: string[];
  /** How many candidates to return. Default: DEFAULT_LIMIT. */
  limit?: number;
}

export interface SearchRecipesDeps {
  embedder: Embedder;
  vectorStore: VectorStore;
  structuredStore: StructuredStore;
}

/**
 * Confidence floor below which a candidate's `time.active` is treated as
 * unreliable enough to fail the (fail-closed) `active_max` gate. The exact
 * value is the still-open, data-dependent decision `meal-planner-b7n`, to be
 * finalized during the q95.6 corpus validation pass against real extraction
 * confidence distributions — 0.5 is a reasonable interim default, not a
 * validated one.
 */
export const CONFIDENCE_THRESHOLD = 0.5;

const DEFAULT_LIMIT = 10;

/**
 * Filters run AFTER vector search (they're over structured fields, not
 * embeddings), so we over-fetch from the vector store to still have enough
 * candidates left to reach `limit` post-filter. A flat multiplicative factor
 * is a simple v1.0 heuristic — it can still under-fill when the underlying
 * store is small or the filters are very selective (e.g. a tiny corpus with
 * few vegetarian recipes); that's an accepted v1.0 limitation, not an error:
 * callers just get fewer than `limit` candidates back.
 */
const OVER_FETCH_FACTOR = 3;

export async function searchRecipes(
  query: string,
  filters: SearchFilters | undefined,
  deps: SearchRecipesDeps,
): Promise<RecipeCandidate[]> {
  const limit = filters?.limit ?? DEFAULT_LIMIT;
  const fetchLimit = limit * OVER_FETCH_FACTOR;

  const queryVector = await deps.embedder.embed(query);
  const hits = deps.vectorStore.search(queryVector, {
    limit: fetchLimit,
    exclude_ids: filters?.exclude_ids,
  });

  const candidates: RecipeCandidate[] = [];
  for (const hit of hits) {
    if (candidates.length >= limit) {
      break;
    }
    const record = deps.structuredStore.getStructured(hit.id);
    const fields = record?.fields ?? null;
    // Tags are authoritative for course/quality/season/effort/veg (SPEC §5.2);
    // merged over the LLM extraction here at projection time.
    const tm = tagMetadata(record?.tags ?? []);

    if (!passesFilters(fields, tm, filters)) {
      continue;
    }

    candidates.push(assembleCandidate(hit, fields, tm));
  }

  return candidates;
}

/**
 * Deterministic filter predicates over a candidate's cached structured
 * fields (never over the vector-search score itself).
 *
 * A candidate with NO structured record yet (`fields === null`: unextracted,
 * or a needs_review record with no successful extraction) fails every
 * *provided* filter — including the non-active_max ones, since e.g.
 * `fields?.veg_status` on a null record can never equal a requested
 * `veg_status`. Per ADR 0001's missing-data default, that only excludes it
 * from a FILTERED (weeknight) query; an unfiltered (weekend) query has no
 * predicates to fail, so it passes through untouched.
 */
function passesFilters(
  fields: ExtractedFields | null,
  tm: TagMetadata,
  filters: SearchFilters | undefined,
): boolean {
  if (!filters) {
    return true;
  }

  // Course gate is tag-driven (a side dish with a failed/absent extraction is
  // still excluded — its is_side is known from tags, not the body).
  if (filters.main_dinner_only && !tm.main_dinner_eligible) {
    return false;
  }

  if (!passesActiveMax(fields, filters.active_max)) {
    return false;
  }

  // Effective values apply the tag overrides (SPEC §5.2 authority), so a filter
  // matches on the same merged metadata the assembled candidate will carry.
  const effectiveVeg = tm.veg_from_tags ?? fields?.veg_status;
  const effectiveSeasons =
    tm.season_tags.length > 0 ? tm.season_tags : (fields?.season_tags ?? []);
  const effectiveEffort =
    tm.effort_tags.length > 0 ? tm.effort_tags : (fields?.effort_tags ?? []);

  if (filters.veg_status !== undefined && effectiveVeg !== filters.veg_status) {
    return false;
  }

  if (
    filters.season !== undefined &&
    !effectiveSeasons.includes(filters.season)
  ) {
    return false;
  }

  if (filters.effort !== undefined && filters.effort.length > 0) {
    const hasOverlap = filters.effort.some((tag) =>
      effectiveEffort.includes(tag),
    );
    if (!hasOverlap) {
      return false;
    }
  }

  return true;
}

/**
 * HARD, FAIL-CLOSED gate (ADR 0001 §6.2 missing-data default): a candidate
 * is weeknight-eligible only when it has a non-null `time.active` at or
 * below `active_max` AND that estimate's confidence clears
 * `CONFIDENCE_THRESHOLD`. A null active time, OR a low-confidence one (even
 * if the number itself looks fast), FAILS the predicate rather than being
 * treated as "unknown, so allow it" — the whole point of the gate is to
 * never surface a recipe as weeknight-safe on a guess.
 */
function passesActiveMax(
  fields: ExtractedFields | null,
  activeMax: Minutes | undefined,
): boolean {
  if (activeMax === undefined) {
    return true;
  }
  const time = fields?.time;
  if (!time || time.active == null) {
    return false;
  }
  if (time.confidence < CONFIDENCE_THRESHOLD) {
    return false;
  }
  return time.active <= activeMax;
}

/**
 * Assembles the lightweight `RecipeCandidate` (no ingredients) from a
 * vector hit + its structured fields. A candidate with no structured record
 * (only reachable here via an unfiltered query, since `passesFilters` above
 * drops it from any filtered one) gets schema-conformant defaults: an
 * all-null/zero-confidence `time`, empty tag lists, and `veg_status:
 * "unknown"`.
 */
function assembleCandidate(
  hit: SearchResult,
  fields: ExtractedFields | null,
  tm: TagMetadata,
): RecipeCandidate {
  // Tag overrides win over the LLM extraction (SPEC §5.2); the extraction
  // supplies the fallback where the user left a category untagged, plus the
  // body-derived time. `is_side` / `main_dinner_eligible` / `tags` come solely
  // from the tags and are set even when extraction is missing.
  const tagFields = {
    tags: tm.tags,
    is_side: tm.is_side,
    main_dinner_eligible: tm.main_dinner_eligible,
  };

  if (!fields) {
    return {
      id: hit.id,
      title: hit.title,
      time: { active: null, total: null, prep: null, confidence: 0 },
      effort_tags: tm.effort_tags,
      season_tags: tm.season_tags,
      quality: tm.quality,
      veg_status: tm.veg_from_tags ?? "unknown",
      ...tagFields,
    };
  }
  return {
    id: hit.id,
    title: hit.title,
    time: fields.time,
    effort_tags:
      tm.effort_tags.length > 0 ? tm.effort_tags : fields.effort_tags,
    season_tags:
      tm.season_tags.length > 0 ? tm.season_tags : fields.season_tags,
    quality: tm.quality ?? fields.quality,
    veg_status: tm.veg_from_tags ?? fields.veg_status,
    ...tagFields,
  };
}
