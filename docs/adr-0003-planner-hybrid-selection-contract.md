# ADR 0003 — Planner: hybrid selection contract (prompt, output schema, validation)

- **Status:** Accepted (mechanism fixed; prompt wording + thresholds refined during implementation)
- **Date:** 2026-07-09
- **Owner:** Backhaus
- **Relates to:** Meal Planner Bot design doc v1.0, §6 (planning logic), §6.2 (signals by mechanism), §6.4 (fan-out); sibling ADRs 0001 (recipe interface — what the planner reads), 0002 (state machine — `buildPlan` is called by `generateForWeek`)

---

## Context

The planner is a **hybrid** (design §6.0): deterministic hard filters run *before* the LLM sees a candidate, then the LLM reasons over the survivors. ADR 0001 specified the retrieval side — `search_recipes` applies the hard predicates (`active_max`, inherent-veg) and returns lightweight candidates carrying the soft-signal metadata. This ADR specifies everything *after* retrieval: how the pooled candidates and the §6.2 by-mechanism signals get marshalled into the LLM call, what the selection **output** looks like, and how the hard constraints are **verified in code** rather than trusted to the model.

The governing principle: **the LLM decides; the code guarantees.** Hard constraints live in code both at retrieval (ADR 0001) *and* at post-selection validation (here). The LLM's judgment covers variety, quality, seasonality, and separability reasoning — the things that genuinely need reasoning — over a candidate set the code has already made safe.

---

## Decision

### D1 — Orchestrator owns retrieval + pool composition; the LLM does selection only

The orchestrator composes the pools deterministically (slot counts, `active_max`, veg-floor top-up, untested injection — all code-side policy, not LLM judgment) and hands the **cheap-tier candidates** to a **single LLM selection call**. No agentic search loop in v1.0: retrieval policy is deterministic, so letting the LLM drive `search_recipes` iteratively would only add cost and non-determinism. `get_recipe` is called by the orchestrator *after* selection, for the ~5–6 chosen.

### D2 — Signals enter the LLM by mechanism (per §6.2)

- **Structured soft signals** (time, quality, season, `veg_status`) ride as **explicit fields** on each candidate — the LLM sees them as data, not prose.
- **Parameters** (cook-night counts) and **weighting guidance** are prompt instructions.
- **Untested injection** is **retrieval-level**: the orchestrator seeds the pool with untested candidates at a configured rate and tells the planner it *may* pick at most one.
- **Picky-youngest / kid-friendliness** is **prose** in the household-context block; the LLM infers from titles + world knowledge (§5.3 pattern: no tag until inference proves unreliable).

### D3 — Structured output, stored as `working_plan`; the Slack draft is *rendered* from it

The planner emits a **`WeekPlan` JSON** (structured output), which *is* the `working_plan` persisted in the ADR 0002 session row. A **separate deterministic render step** turns it into Slack markdown. Selection ≠ presentation: the LLM never writes the post directly, so revision (v3.0) and grocery (v4.0) operate on structured data, not scraped prose.

### D4 — Per-meal veg path is part of the output and discharges the hard veg constraint

Every selected meal records **how** the per-night vegetarian guarantee is met: `inherent` / `separable` (+ how) / `second_dish` (+ the second recipe). This makes the hard constraint auditable in the draft and gives v3.0/v4.0 the signal they need (a `second_dish` means an extra Todoist slot / extra grocery ingredients). **Two-phase** (see Consequences): provisional at selection from `veg_status` + title/world-knowledge; refined post-`get_recipe` (using `alternatives`) when it actually matters.

### D5 — Deterministic post-validation with one bounded repair retry

The LLM's selection is **validated in code** before it's rendered or stored: correct counts, every `recipe_id` a real member of its pool, a veg path present and consistent with `veg_status`, no repeated recipe within the week. On failure, **one** re-prompt with the specific violations; if it still fails, alert and fail the run (ADR 0002's `catch`). Hard constraints are verified, not trusted — and the single retry keeps the run inside the §9.3 cost cap.

---

## Interface sketch

### Planner input (assembled by the orchestrator)

```ts
interface PlannerInput {
  week_key: string;
  slots: { constrained: number; relaxed: number };   // e.g. {constrained: 4, relaxed: 2}
  pools: {
    weeknight: RecipeCandidate[];   // active_max-filtered (ADR 0001)
    weekend:   RecipeCandidate[];   // relaxed filter
    // veg floor already guaranteed by composition (ADR 0001, orchestrator step 3)
  };
  household: string;                // PROSE: vegetarian daughter (HARD); picky youngest
                                    // likes/dislikes; smaller appetites; cook 5–6 nights
  current_season?: string;          // for the seasonality soft signal (v1.0 tag-based)
  untested_present: boolean;        // did retrieval inject untested candidates this week?
}
```

### Selection output (`WeekPlan` — this IS `working_plan` in ADR 0002)

```ts
type VegPath =
  | { kind: "inherent" }                                          // requires veg_status == "vegetarian"
  | { kind: "separable"; note: string }                           // "hold the chicken; she has pasta + sauce"
  | { kind: "second_dish"; recipe_id: string; title: string };    // rare fallback → extra Todoist/grocery

interface SelectedMeal {
  slot_type: "constrained" | "relaxed";
  recipe_id: string;              // MUST be a member of the matching pool
  title: string;
  day: null;                      // v1.0 ALWAYS null — day assignment is v2.0 (design §6.1)
  veg: VegPath;                   // how the per-night veg constraint is satisfied
  flags: string[];                // e.g. ["do-ahead"], ["untested"] — surfaced in the draft
  rationale: string;              // short: why picked (variety / quality / season)
}

interface WeekPlan {
  week_key: string;
  meals: SelectedMeal[];          // length == slots.constrained + slots.relaxed
  summary?: string;               // optional planner commentary for the draft
}
```

### Prompt skeleton (sections, not final wording)

```
1. TASK — select a week of family dinners from the candidate pools below.
2. HOUSEHOLD — prose context. The vegetarian daughter is a HARD, every-night
   constraint. Picky youngest: likes {…}, dislikes {…}. Smaller appetites.
3. SLOTS — select exactly {constrained} weeknight + {relaxed} weekend meals,
   tagged by slot_type. Do NOT assign days.
4. CANDIDATES — weeknight pool [{id,title,time,quality,season_tags,veg_status}…]
                 weekend  pool [ … ]
5. RULES
   HARD  — every meal veg-satisfiable; STATE the path. If a meat dish is not
           cleanly separable, add a second_dish (a vegetarian recipe_id from a pool).
           No recipe repeated within the week.
   SOFT  — bias to higher quality; respect current season; penalize heavy total
           time on constrained slots; maximize within-week variety
           (protein / cuisine / technique).
   POOL  — you MAY include ≤1 untested "try this?" if present; flag do-aheads.
6. OUTPUT — emit a WeekPlan JSON object and nothing else.
```

### Pipeline (this is ADR 0002's `buildPlan(wk)`)

```ts
function buildPlan(wk): WeekPlan {
  // 1. Deterministic retrieval + pool composition (ADR 0001)
  const weeknight = search_recipes(seed, { active_max: 60, season: cfg.season,
                                           limit: cfg.slots.constrained * 4 });
  const weekend   = search_recipes(seed, { season: cfg.season,
                                           limit: cfg.slots.relaxed * 4 });
  ensureVegFloor(weeknight, cfg.vegFloorK);            // top-up via veg_status:"vegetarian"
  ensureVegFloor(weekend,   cfg.vegFloorK);
  maybeInjectUntested(weeknight, weekend, cfg.untestedRate);   // retrieval-level (D2)

  // 2. Single LLM selection over cheap-tier candidates → structured WeekPlan (D1, D3)
  let plan = llmSelect(buildPrompt(wk, { weeknight, weekend }, cfg));

  // 3. Deterministic validation; ONE bounded repair retry (D5)
  let errs = validate(plan, { weeknight, weekend }, cfg);
  if (errs.length) {
    plan = llmSelect(buildRepairPrompt(plan, errs));  // single retry with explicit violations
    errs = validate(plan, { weeknight, weekend }, cfg);
    if (errs.length) throw new PlanValidationError(errs);   // → ADR 0002 catch → alert + fail run
  }

  // 4. Enrich chosen (OPTIONAL in v1.0: source links; load-bearing in v4.0: ingredients)
  for (const m of plan.meals) enrich(m, get_recipe(m.recipe_id));
  return plan;
}
```

### What `validate()` checks

- **Counts:** `constrained`/`relaxed` tallies match `slots` (or fall in the configured 5–6 range).
- **Membership:** every `recipe_id` (incl. `second_dish`) is a real candidate in the matching pool — guards against hallucinated ids.
- **Veg consistency:** every meal has a `veg` path; `inherent` requires `veg_status == "vegetarian"`; `second_dish.recipe_id` must be `veg_status == "vegetarian"`. (`separable` is *not* verifiable at v1.0 selection time — see Consequences.)
- **No duplicates:** no recipe repeated across meals or as a second dish.
- **Flag sanity:** `untested` flagged only where `quality == "untested"`, and at most one.

---

## Alternatives considered

- **Agentic retrieval (LLM drives `search_recipes` in a loop)** — rejected for v1.0. Retrieval policy is deterministic (counts, `active_max`, veg floor); an agent loop adds cost and non-determinism for no selection-quality gain. Revisit if recency/weather (v2.0) make query formation genuinely reasoning-heavy.
- **Free-form prose plan (LLM writes the Slack post directly)** — rejected. Leaves nothing structured for v3.0 revision / v4.0 grocery to consume; forces scraping. D3 separates selection from rendering.
- **Trust the LLM on hard constraints (no validation)** — rejected. The whole point of the hybrid is deterministic guarantees; an unvalidated LLM can miscount or mislabel a meat dish as vegetarian. D5 verifies.
- **Unbounded repair loop** — rejected. One retry caps cost (§9.3) and latency; a persistent failure is a real signal worth an alert, not silent retrying.
- **Full-recipe (get_recipe) selection** — rejected. Bloats the selection context; cheap-tier metadata carries every signal selection needs (ADR 0001 D2).

---

## Consequences

**Positive**
- **Hard guarantees are code-side at both ends** — retrieval filters (ADR 0001) and post-selection validation (D5) — so the draft can't silently violate the veg constraint or the counts.
- **Structured `WeekPlan`** flows straight into ADR 0002's `working_plan` and forward into v3.0 revision / v4.0 grocery with no reformatting.
- **Cheap selection:** one call + at most one repair over lightweight candidates keeps generation at cents and inside the §9.3 cap.
- **Auditable veg reasoning:** the per-meal `veg` path shows the family exactly how the vegetarian is covered, and flags second dishes early.

**Tradeoffs / risks**
- **`separable` is unverifiable at v1.0 selection time.** The cheap-tier candidate carries `veg_status` but **not** the `alternatives` field (that's in `get_recipe`). So a `separable` claim is accepted on the model's word in v1.0, surfaced for human review, and only rigorously checked post-`get_recipe` when it matters (v4.0 grocery, where a wrong separability call changes the list). The veg floor makes this safe: enough *inherent*-veg candidates exist that the planner is never forced onto a shaky separability call. `inherent` and `second_dish` *are* verified against `veg_status`.
- **Seed query is thin in v1.0.** Without recency (v2.0 `exclude_ids`) or weather framing, the semantic `query` is a generic diversity seed; variety leans on a generous pool + the LLM's cross-slot reasoning. If pools come back homogeneous, add category/cuisine-seeded multi-queries (a tuning knob, not a redesign).
- **Validation is only as good as its rules.** Anything not encoded (e.g., subtle variety) stays the LLM's judgment; validation guarantees the *hard* set only.

---

## Open items (non-blocking for v1.0)

- **`vegFloorK`, `untestedRate`, total-time penalty weighting** — concrete values tuned during the plan-quality validation pass.
- **Seed-query strategy** — single generic seed vs. category-seeded multi-query for pool diversity; pick if v1.0 pools look homogeneous.
- **Post-`get_recipe` separability confirmation pass** — formalize when it lands (leaning v4.0, where it changes the grocery list); until then, provisional + human-reviewed (design §5.3).
- **Repair-prompt content** — how much of the violation detail to feed back; keep minimal to bound tokens.
