/**
 * Recency dedup mechanism (bd meal-planner-v9v.2, ADR-0006 D2, SPEC §6.3):
 * given the recency-resolved recent `recipe_id`s (bd meal-planner-v9v.1's
 * `readRecentRecipeIds`) and a candidate pool, produces BOTH dedup effects
 * §6.3 calls for —
 *
 *  - **exact exclusion** — the recent ids verbatim, ready to pass straight
 *    into the ALREADY-WIRED `SearchFilters.exclude_ids` (`search.ts` /
 *    `vector-store.ts`) so a literal repeat is hard-dropped at retrieval;
 *  - **semantic penalty** — reusing the recipe server's existing embeddings
 *    (`VectorStore.getEmbedding`, no re-implemented vector search), each
 *    surviving candidate is penalized by its cosine-similarity closeness to
 *    the NEAREST recent recipe, scaled by a bounded, parameterized strength
 *    knob — a soft ranking signal, mirroring how quality/season/weather ride
 *    as soft signals elsewhere in the planner (ADR 0003 D2).
 *
 * This is the MECHANISM only — a pure, injectable-embedding-lookup unit with
 * no Todoist/vector-store construction of its own (mirrors `recency.ts`'s
 * injectable-client convention). It does not call `readRecentRecipeIds` and
 * is not wired into pool composition or the weekly generation entrypoint —
 * that's bd meal-planner-v9v.3.
 */

/** Minimal candidate shape this module needs: just an `id` to key exclusion/penalty on. */
export interface DedupCandidate {
  id: string;
}

/** Injectable embedding lookup, narrowed from `VectorStore.getEmbedding` (tests supply a plain fake — no real sqlite-vec needed). */
export interface RecencyDedupDeps {
  getEmbedding: (recipeId: string) => number[] | null;
}

/**
 * Default semantic-penalty strength (0..1): how much of a near-recent
 * candidate's cosine similarity converts into ranking penalty. Not yet
 * config-driven — no caller consumes this module (v3.x wiring is bd
 * meal-planner-v9v.3), so a fixed, conservative default avoids adding config
 * plumbing ahead of a consumer; callers may override via
 * {@link RecencyDedupOptions.penaltyStrength}. Kept well under 1.0 — this is
 * a SOFT bias against near-neighbors of recently-eaten recipes, not a second
 * hard filter (exact repeats are already hard-dropped via `excludeIds`).
 */
export const DEFAULT_RECENCY_PENALTY_STRENGTH = 0.3;

export interface RecencyDedupOptions {
  /**
   * Scales cosine-similarity-to-nearest-recent-recipe into a penalty.
   * Clamped to [0, 1]; 0 disables the semantic penalty entirely (exact
   * exclusion still applies). Default {@link DEFAULT_RECENCY_PENALTY_STRENGTH}.
   */
  penaltyStrength?: number;
}

/** One candidate with its computed recency penalty attached. */
export interface RankedCandidate<T extends DedupCandidate> {
  candidate: T;
  /**
   * 0 (unrelated to anything recently eaten, or embedding unavailable) to 1
   * (near-identical to a recent recipe, at `penaltyStrength` 1.0).
   */
  penalty: number;
}

export interface RecencyDedupResult<T extends DedupCandidate> {
  /** Deduped recent recipe ids, verbatim — feed directly into `SearchFilters.exclude_ids`. */
  excludeIds: string[];
  /**
   * Candidates NOT in `excludeIds` (an exact repeat is hard-dropped, never
   * merely penalized), sorted ascending by `penalty` (least recent-like
   * first) — ties keep the input pool's relative order (stable sort).
   */
  ranked: RankedCandidate<T>[];
}

/** Clamps a number into [0, 1]. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Cosine similarity between two equal-length vectors. Computed from first
 * principles (not assumed pre-normalized) so this stays correct regardless
 * of the embedder's normalization guarantee. Returns 0 for a degenerate
 * (zero-length or all-zero) vector rather than NaN/Infinity.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Applies the §6.3 recency dedup mechanism to a candidate pool.
 *
 * - `recentRecipeIds` empty → pure no-op: `excludeIds` is `[]`, `ranked`
 *   returns every candidate with `penalty: 0` in original order.
 * - A recent id (or a candidate) with no resolvable embedding (never
 *   indexed, or deleted from the vector store since) is skipped for the
 *   PENALTY computation only — it never blocks exact exclusion, and a
 *   candidate whose own embedding is unavailable simply gets `penalty: 0`
 *   (fails open: no data to penalize on, not treated as maximally similar).
 */
export function applyRecencyDedup<T extends DedupCandidate>(
  recentRecipeIds: string[],
  candidates: T[],
  deps: RecencyDedupDeps,
  options: RecencyDedupOptions = {},
): RecencyDedupResult<T> {
  const excludeIds = [...new Set(recentRecipeIds)];
  const excludeSet = new Set(excludeIds);
  const penaltyStrength = clamp01(
    options.penaltyStrength ?? DEFAULT_RECENCY_PENALTY_STRENGTH,
  );

  const eligible = candidates.filter((c) => !excludeSet.has(c.id));

  if (excludeIds.length === 0 || penaltyStrength === 0) {
    return {
      excludeIds,
      ranked: eligible.map((candidate) => ({ candidate, penalty: 0 })),
    };
  }

  const recentEmbeddings = excludeIds
    .map((id) => deps.getEmbedding(id))
    .filter((v): v is number[] => v !== null);

  const scored: RankedCandidate<T>[] = eligible.map((candidate) => {
    const embedding = deps.getEmbedding(candidate.id);
    if (embedding === null || recentEmbeddings.length === 0) {
      return { candidate, penalty: 0 };
    }
    const maxSimilarity = Math.max(
      ...recentEmbeddings.map((recent) => cosineSimilarity(embedding, recent)),
    );
    // Cosine similarity can be negative for dissimilar vectors; clamp to
    // [0, 1] before scaling so a "very dissimilar" candidate never gets a
    // negative penalty (i.e. a ranking BONUS) out of this mechanism.
    return { candidate, penalty: clamp01(maxSimilarity) * penaltyStrength };
  });

  // Stable ascending sort by penalty (Array#sort is stable per spec), so
  // ties preserve the input pool's original relative order.
  return {
    excludeIds,
    ranked: [...scored].sort((a, b) => a.penalty - b.penalty),
  };
}
