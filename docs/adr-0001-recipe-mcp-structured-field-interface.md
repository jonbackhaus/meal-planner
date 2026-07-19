# ADR 0001 — Recipe MCP server: structured-field interface for planning

- **Status:** Accepted (interface sketch; field-level details may be refined during implementation)
- **Date:** 2026-07-09
- **Owner:** Backhaus
- **Relates to:** Meal Planner Bot design doc v1.0, §5 (recipe server), §6 (planning logic), §10 (open questions)

---

## Context

The v1.0 planner is a **hybrid** (design §6.0): deterministic hard filters run *before* the LLM sees any candidate, then the LLM reasons over the survivors. That split only works if the constraints the planner needs are available as **structured fields**, not free text:

- The **weeknight gate** is a hard numeric predicate (`active time < 60 min`). Semantic search can't enforce it — embeddings encode similarity, not magnitude, so there's no auditable "<60" guarantee (design §5, §6.2).
- The **vegetarian floor** needs a reliable "is this inherently vegetarian?" signal per candidate, computable at retrieval time (design §6.2, §6.4).
- **Grocery aggregation** (v4.0) needs a structured ingredient block, and retrofitting one later means re-reading every note (design §5.1).

The recipe MCP server already owns the local vector index. This ADR extends it with a **structured-field layer** populated by an **ingest-time extraction pass**, exposed through a **two-tier tool interface**. The server is the single owner of index freshness and the structured cache; the orchestrator is a pure consumer.

The times and (most) ingredients already exist in the notes as free text — the decision here is *where* and *how* to turn them into structured fields, and *what contract* the orchestrator sees.

---

## Decision

### D1 — A structured-field layer, populated at ingest, not per plan-run

A single **LLM-based extraction pass** normalizes each note's **body** into the structured fields that live only there — `{time, ingredients, veg_status}` — and caches them beside the vector. It runs **at sync time, gated on a content hash** (plus an extractor version — see below), so only changed notes are re-extracted. It is **not** on the per-plan-run hot path (negligible cost, zero per-run latency) and does **not** hook Apple Notes change events (Notes has none clean).

> **Ratified (beads q95.11 / q95.12, commits 583142c / 587c383):** **hashtags are the authoritative source** for `effort` / `season` / `quality` / `course` (e.g. `#side`) / `veg`, read from NoteStore. The extraction pass was **slimmed** accordingly (`EXTRACTOR_VERSION` 1 → 2) to produce **only** the body-derived fields: the `{prep, active, total}` times, the frozen ingredient block, and a `veg_status` **fallback** (a `#vegetarian`/`#vegan` tag positively overrides it; absence of a tag never implies meat). Quality/season/effort/course come from tags, not the LLM.

### D2 — Two-tier tool interface

`search_recipes` returns lightweight candidates (id/title/planning metadata, **no ingredient block**) to keep planner fan-out context small; `get_recipe` returns the full note incl. the ingredient block, called only for the ~5–6 chosen recipes.

### D3 — Hard constraints are filter predicates; soft signals ride in candidate metadata; separability is planner-side

Hard constraints (`active_max`, inherent-veg) are **deterministic predicates** on `search_recipes`. Soft signals (times, quality, season) are returned **in the candidate metadata** so the LLM can reason over survivors without a full fetch. **Separability is not in this interface** — it is inferred by the planner at reasoning time from the `alternatives` field + world knowledge (design §5.3).

### D4 — Freeze the ingredient capture schema now (v1.0), consumed in v4.0

Capture ≠ aggregation: v1.0 losslessly *captures*; v4.0 *reconciles*. The `raw` line is always retained as the lossless fallback. Three fields (`alternatives`, `optional`, `prep`) also feed v1.0 planning, so this is not purely v4.0 speculation.

---

## Interface sketch

### Shared value types

```ts
type Minutes = number;

type Quantity =
  | { kind: "scalar"; value: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "none" };                    // "to taste" — no number

// "vegetarian" = deterministically no meat/fish in the ingredient list.
// Separability of a contains_meat recipe is NOT recorded here; the planner
// infers it (D3). The retrieval veg floor is built from "vegetarian" only.
type VegStatus = "vegetarian" | "contains_meat" | "unknown";

type Quality = 3 | 4 | 5 | "untested";

interface TimeFields {
  active: Minutes | null;                // hands-on; null if unparseable
  total:  Minutes | null;
  prep:   Minutes | null;
  confidence: number;                    // 0..1, from the extraction pass
}

interface Ingredient {
  raw: string;                           // original line, ALWAYS (lossless)
  name: string;                          // "garlic"
  prep?: string;                         // "minced" — kept separate from name
  quantity: Quantity;                    // nullable + range-capable
  unit?: string | null;                  // open string; null for "3 eggs"
  optional: boolean;                     // "capers (optional)"
  alternatives?: string[];               // one-of: ["butter","olive oil"]
  group?: string;                        // "for the sauce"
  // package_size?: {...}                // OPEN (§5.1) — default: leave in `raw`
  confidence: number;                    // 0..1
  needs_review: boolean;
}
```

### Tier 1 — `search_recipes` (cheap; fan-out)

```ts
interface SearchFilters {
  active_max?: Minutes;   // HARD weeknight gate. A candidate whose time.active
                          // is null OR time.confidence < THRESHOLD FAILS this
                          // predicate (fail-closed → §6.2 missing-data default).
  veg_status?: VegStatus; // e.g. "vegetarian" to top up the veg floor
  season?: string;        // season-tag predicate (v1.0 seasonality)
  effort?: string[];      // include/exclude effort tags ("quick","do-ahead")
  exclude_ids?: string[]; // v2.0 recency dedup
  limit?: number;         // pool sizing (fan-out, §6.4)
}

interface RecipeCandidate {
  id: string;
  title: string;
  time: TimeFields;                      // soft signals available without a fetch
  effort_tags: string[];                 // ["quick"] | ["do-ahead"] | ...
  season_tags: string[];
  quality?: Quality;
  veg_status: VegStatus;
  // NO ingredients here — that's get_recipe only.
}

// Semantics: vector search over `query`, then deterministic filter predicates
// over the cached structured fields. Returns lightweight candidates only.
function search_recipes(
  query: string,
  filters?: SearchFilters
): RecipeCandidate[];
```

### Tier 2 — `get_recipe` (full; chosen only)

```ts
interface Recipe extends RecipeCandidate {
  ingredients: Ingredient[];             // the frozen schema (D4)
  body?: string;                         // steps / note body (or a reference)
  source_note_id: string;                // Apple Notes back-reference
}

function get_recipe(id: string): Recipe;
```

### Internal — the extraction pass (NOT an MCP tool)

```
sync():
  for each note:
    h = contentHash(note.body)
    if cache[note.id]?.hash == h AND cache[note.id]?.extractor_version == V:
        skip                    # unchanged AND same extractor → reuse cache
    else:
        rec = extract(note)     # single LLM pass → {time, ingredients,
                                #   veg_status, effort_tags, season_tags, quality}
        cache[note.id] = { hash: h, extractor_version: V, ...rec }
  # vector index refresh proceeds as today
```

The cache is keyed by `note.id` and gated on **both** the content hash **and** an `extractor_version` — so re-tuning the extraction prompt/model forces a clean re-extract without a manual purge. Tools read only from this cache; they never trigger extraction on the hot path.

---

## How the orchestrator uses it (v1.0)

1. **Weeknight pool:** `search_recipes(q, { active_max: 60, limit: constrainedSlots * 4 })`.
2. **Weekend pool:** `search_recipes(q, { limit: relaxedSlots * 4 })` (no `active_max`; do-aheads etc. remain eligible).
3. **Veg floor:** if either pool has fewer than K `veg_status:"vegetarian"` candidates, top it up with `search_recipes(q, { veg_status: "vegetarian", ... })`. The tool needs no bespoke floor param — the floor is composed by the orchestrator (§6.4).
4. Planner (LLM) selects the slot-typed set from the pooled candidates with cross-slot variety reasoning; separability inferred where a meat dish is chosen for a veg night.
5. `get_recipe(id)` for the ~5–6 chosen (ingredient block reserved for the draft / future grocery use).

---

## Alternatives considered

- **Semantic search for the time gate** — rejected. No magnitude guarantee; can't audit "<60".
- **Per-plan-run extraction** — rejected. Pays LLM extraction cost + latency on every run; the data doesn't change between runs.
- **Regex extraction** — rejected as the default. Brittle on human formats ("an hour and a half", "20–25 min", "overnight"). LLM pass is robust and, being ingest-time + hash-gated, effectively free.
- **Single-tier tool** (always return full recipes) — rejected. Bloats fan-out context; the ingredient block is only needed for the handful of chosen recipes.
- **Tag separability at ingest** — deferred, not rejected. Infer first (D3); add a `veg_separable` field only if inference proves unreliable (design §5.3).

---

## Consequences

**Positive**
- Deterministic, auditable hard filters; the weeknight gate is a real predicate, not a vibe.
- Cheap fan-out: candidate metadata carries every soft signal the planner needs, so `get_recipe` is reserved for the ~6 chosen.
- One ingest pass, two payoffs: the v1.0 time filter and the v4.0 grocery block come from the same extraction.
- Server owns index + cache freshness; the orchestrator stays a thin consumer.

**Tradeoffs / risks**
- **Extraction accuracy is a dependency.** Quality on the real corpus is only knowable by running the pass and eyeballing `confidence`/`needs_review`. This is a build-time validation, not a design unknown.
- **The veg floor guarantees only *inherent* vegetarian candidates.** Separable meat dishes are discovered later by the planner, so the retrieval floor is deliberately conservative (guarantees a veg path even if zero meat dishes turn out separable).
- **Fail-closed on missing time data.** A null/low-confidence `active` fails `active_max`, so such recipes never land on a weeknight — but they remain retrievable for weekend pools. Conservative on busy nights; nothing is lost.
- **Schema frozen early.** Some fields (esp. the full ingredient block) aren't consumed until v4.0, a small speculative investment justified by the retrofit cost of re-reading every note.

---

## Open items (non-blocking for v1.0)

- **`package_size`** capture ("1 can (14 oz)", "2 (400 g) tins") — structure it or leave to `raw` for v4.0 to parse. Default to `raw` if undecided at build time (design §5.1 / §10.6).
- **`confidence` threshold** for the `active_max` fail-closed rule — **RATIFIED at `0.5`** (bead b7n, commit 6b1d73d; `CONFIDENCE_THRESHOLD` in `src/recipe-mcp/search.ts`). The q95.6 corpus validation (764/764 extracted, 0 `needs_review`) showed `time.confidence` tracks how explicitly a note stated its time; unreliable estimates cluster at conf ≤ 0.2, so 0.5 sits just above the danger cluster at a natural distribution break (keeps 547 weeknight-eligible recipes).
- **`veg_separable` field** — add later only if planner separability inference proves unreliable (design §5.3).
- **`exclude_ids` / recency** — the `exclude_ids` filter is defined now but only exercised in v2.0 dedup.
