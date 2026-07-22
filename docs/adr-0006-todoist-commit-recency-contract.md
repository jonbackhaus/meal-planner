# ADR 0006 — Todoist commit + recency contract (task schema, recipe-id round-trip, task-id persistence, phase ordering)

- **Status:** Accepted (design ratified 2026-07-21; v3.0 implementation deferred just-in-time — this ADR unblocks v3.0 commit scoping and fixes a v2.0/v3.0 phase-ordering hole; no code lands yet)
- **Date:** 2026-07-21
- **Owner:** Backhaus
- **Relates to:** Meal Planner Bot design doc v1.0, §6.3 (recency / semantic dedup), §4 (phase map), §10.1 (completion-signal open question), §10 item 5 (Todoist MCP adopt-vs-build). **Builds on** ADR 0002 (session row / `working_plan` — where task-ids persist), ADR 0003 D4 (the `second_dish` veg path → an extra task) + the already-wired `exclude_ids`, ADR 0004 D5 (prep units → tasks), ADR 0005 (the ISO-date `day` → task due date). **Forward-coupled to** the v3.0 revision/commit ADR (`xm4`) and the still-open completion-signal decision (§10.1).

---

## Context

Recency/dedup (§6.3) declares **Todoist completed tasks the sole source of truth** for "what we've eaten," and the exact-exclusion plumbing (`exclude_ids` in `search.ts`/`vector-store.ts`) is already wired. But three things were never specified, and one is an outright phasing bug:

1. **Phase-ordering hole.** The phase map schedules the recency *read* in **v2.0** but the commit *write* in **v3.0**. Recency's source therefore does not exist when v2.0 would read it — there is nothing to dedup against until the commit has written meal tasks (and, per §10.1, they've been checked off).
2. **Recipe-id round-trip gap.** §6.3 says "resolve recent meals → recipe ids → embeddings" but never says *how* a free-text Todoist task maps back to a `recipe_id` — the step the whole dedup depends on.
3. **No task-id persistence.** Soft-commit re-commit/overwrite must remember the tasks it created, but the ADR 0002 session schema has no place for Todoist task ids.

This ADR resolves all four (the three gaps + the ordering).

---

## Decision

### D1 — Recency/dedup moves from v2.0 to v3.x (it depends on the commit write)

Recency read + semantic dedup + the completion-signal question (§10.1) **relocate to v3.x**, alongside/after the v3.0 commit write. Rationale: you cannot dedup on data that does not exist — Todoist holds no meal history until the commit writes it. This leaves **v2.0 = weather + calendar + day-assignment only**, all Todoist-independent and fully specified (ADR 0003 A1 / 0004 / 0005). The phase map, §6.3, and §10.1 are updated to reflect the move. (Rejected: a manual-task interim in v2.0 — sparse, unreliable, relies on unstated family behavior; and pulling the commit write forward into v2.0 — drags Socket Mode + approval machinery early and breaks "v2.0 writes nothing.")

### D2 — Round-trip: the commit stamps `recipe_id` into the task; recency parses it back deterministically

The v3.0 commit write **embeds the `recipe_id` in each Todoist task's description** as a structured marker — `mp:rid=<id>` — chosen over the title (survives family title edits) and over labels (Todoist labels are global/shared). Recency **parses the marker back to an exact `recipe_id`**, with no semantic guessing on the task→id step. The resolved ids then feed **both** dedup mechanisms already envisioned:

- the **exact-exclusion** path — resolved ids become `exclude_ids` (already wired), hard-dropping a literal repeat;
- the **§6.3 semantic penalty** — the resolved recipes' embeddings (reuse the recipe server's vectors) penalize near-neighbors.

This makes §6.3's "resolve recent meals → recipe ids" **lossless and deterministic**. A task lacking the marker (a hand-created or pre-marker task) simply does not resolve and is skipped — accepted, since post-D1 the commit auto-writes every real meal task; a semantic-title fallback was considered and deferred as unneeded.

### D3 — Task schema (contract; exact strings are v3.0 config)

Per selected meal, the commit creates one Todoist task:

- **project** — a configured Todoist project (e.g. "Meals"); a config value, never hardcoded (mirrors the channel-id / model-config discipline).
- **content (title)** — the recipe title (human-readable).
- **description** — the `mp:rid=<id>` marker (+ optionally a recipe link).
- **due** — the meal's ISO-date `day` (ADR 0005).
- **second dish** — a `second_dish` veg path (ADR 0003 D4; §198 "a second Todoist slot") emits a **second task**, itself carrying its own `mp:rid=<id>` for that recipe.
- **prep units** — placed make-ahead prep (ADR 0004 D5) materializes here as its own task(s), due on the placed `prep_date`, marker referencing the parent meal's recipe.

Exact project name, title template, and marker delimiters are v3.0 implementation/config detail, not fixed here.

### D4 — Task-id persistence lives in `working_plan` JSON, not a new SQL column

Soft-commit re-commit/overwrite must remember what it created. Store a per-meal **`todoist_task_id?`** inside the **`working_plan` JSON** (already a column on the ADR 0002 session row) — **additive and resume-safe, exactly like the `day` field (ADR 0005 D5)**, so **no new SQL column and no schema migration**. Re-commit reads these ids to **update-in-place** rather than duplicating tasks; a meal with no stored id is created fresh. Coordinate the field shape with bd6.13; the lenient resume read (bd6.10) treats it as optional (absent on legacy/pre-commit rows).

### D5 — Deliberately left open (unchanged by this ADR)

- **Completion signal (§10.1)** — who marks meals cooked, or whether recency keys on *scheduled/committed* vs *completed* tasks — rides to v3.x with recency; still an open decision, not resolved here.
- **Todoist MCP adopt-vs-build (§10 item 5)** — still open, but **orthogonal**: the `mp:rid` marker + `working_plan` persistence work regardless of which MCP backs the writes/reads.

---

## Interface sketch

```ts
// D2 — the marker, written at commit, parsed at recency
const MP_RID = /\bmp:rid=([A-Za-z0-9_-]+)\b/;          // in task.description
// commit:  description = `${optionalLink}\nmp:rid=${meal.recipe_id}`
// recency: const rid = task.description.match(MP_RID)?.[1];  // exact id or undefined

// D3 — commit payload per meal (illustrative; exact strings are config)
interface TodoistTaskWrite {
  project_id: string;        // from config (e.g. "Meals")
  content: string;           // recipe title
  description: string;       // contains `mp:rid=<recipe_id>`
  due_date: string;          // meal.day (ISO, ADR 0005); prep tasks use prep_date (ADR 0004)
}

// D4 — additive per-meal field on the stored working_plan (no new SQL column)
interface SelectedMealCommitAdditions {
  todoist_task_id?: string;  // set at commit; drives re-commit update-in-place; resume-safe
}
```

---

## Alternatives considered

- **Keep recency in v2.0 via a manual-task interim** — rejected (D1). Depends on unstated family discipline; sparse early data → weak dedup.
- **Pull the commit write forward into v2.0** — rejected (D1). Commit needs `/mealplan-approved` + Socket Mode (all v3.0); drags the interactive machinery early and breaks the "v2.0 writes nothing" invariant.
- **Pure semantic title→recipe matching for the round-trip** — rejected (D2). Lossy: title drift, family edits, and non-recipe tasks misresolve; §6.3's resolution becomes a guess. We own the write, so an embedded id is free and exact.
- **Embed the id in the task title or a label** — rejected (D2). Titles get edited by the family; labels are global/shared. The description is stable and out of the way.
- **New `todoist_task_ids` SQL column on `session`** (the bead's original proposal) — rejected in favor of the `working_plan` JSON field (D4): per-meal ids belong with the per-meal plan data, and the additive-JSON pattern (like `day`) avoids a migration.

---

## Consequences

**Positive**
- **Honest phasing.** v2.0 no longer reads a source that doesn't exist; each phase depends only on data an earlier phase produced.
- **Lossless dedup.** The embedded id makes task→recipe resolution exact, feeding both the wired `exclude_ids` and the semantic penalty with no guessing.
- **No migration for persistence.** Task ids ride the existing `working_plan` JSON, additive and resume-safe like `day`; re-commit updates in place.
- **MCP-agnostic.** The contract holds whether the Todoist server is adopted or built.

**Tradeoffs / risks**
- **Marker fragility.** A family member deleting the `mp:rid` line from a task description drops that task from recency (fails safe — it just won't dedup on it). Kept unobtrusive to minimize the chance.
- **v2.0 loses cross-week variety.** With recency deferred, v2.0 keeps only within-week variety (as v1.0). Accepted — it was never real in v2.0 anyway (no data); cross-week dedup genuinely arrives with the commit in v3.x.
- **Completion signal still gates recency.** D1 relocates the ordering, but §10.1 (who checks tasks off) must still be resolved before recency actually works in v3.x — tracked, not closed here.

---

## Open items (non-blocking; resolved just-in-time before v3.0 build)

- **Completion signal (§10.1)** — the read semantics for recency (completed vs scheduled tasks; who marks done). Ratify before wiring v3.x recency.
- **Todoist MCP adopt-vs-build (§10 item 5)** — recon maintained community servers vs build; orthogonal to this contract.
- **Exact task strings** — project name, title template, marker delimiters, recipe-link format: v3.0 config/implementation.
- **Prep-task grouping** — whether a meal + its prep task(s) + a `second_dish` link as Todoist sub-tasks or siblings: v3.0 render/commit detail.
