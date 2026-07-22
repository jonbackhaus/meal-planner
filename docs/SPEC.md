# Meal Planner Bot — Design Document

**Status:** v1.0 — ready for implementation (supersedes Draft v0.1)
**Owner:** Backhaus
**Last revised:** 2026-07-09

> **Version labels.** This *document's* revision is **v1.0** (see the changelog in §0). Separately, **v1.0–v4.0** in the phasing sections are *software delivery phases*. Where confusion is possible, phases are written "Phase 1 (v1.0)" etc.

**Scope:** A local, always-on service that drafts a weekly meal plan for the Backhaus family, posts it to Slack for review, commits the approved plan to Todoist, and (later) builds a grocery list in AnyList.

---

## 0. Changelog — Draft v0.1 → v1.0

Ten ambiguities were resolved through a structured review. Summary (details live in the sections cited):

1. **Trigger / sleep (§3.2, §8, §9.4).** Target machine is a MacBook Pro that never sleeps (Ethernet, external power). Dropped the "wakes early Sunday" framing. Trigger is an **in-process scheduler** in the resident daemon; `launchd` only boot-launches + `KeepAlive`s the daemon. Added a **startup catch-up** check so a reboot/crash straddling the trigger posts late rather than skipping silently.
2. **Trigger mechanism either/or (§3.2).** Collapsed to the in-process scheduler; no separate calendar job, no daemon-signaling IPC.
3. **Duplicate-post guard (§8).** Added a `generating` pre-post status and a **week-keyed idempotency guard**; one check covers restart catch-up, timer double-fire, and manual re-runs.
4. **Dev/test story (§7, §9).** Added a `#dev-meal-plan` channel and a **dev/prod profile switch** (channel ID + SQLite path + force-regenerate + post/dry-run).
5. **Time filter vs. vector search (§5, §6.2).** The weeknight time gate is a **structured metadata predicate**, not semantic search. Times are extracted by an **ingest-time pass** (same pass that builds the structured ingredient block).
6. **Ingredient-schema expressiveness (§5.1).** Froze a capture schema (raw + name/prep/quantity/unit/optional/alternatives/group/confidence). One item still open: package-size (§10).
7. **Day assignment / calendar (§4, §6.1).** Day assignment is **deferred to Phase 2 (v2.0)** and is *enabled by* the calendar; v1.0 emits an unordered, slot-typed set.
8. **Planner mechanism (§6).** Pinned as a **hybrid**: deterministic hard-filter pre-pass + LLM reasoning over the survivors. Signals recategorized by mechanism; "portion" relocated to v4.0 scaling; "picky youngest" reclassified as a prompt-level reasoning input.
9. **Active-week / lifecycle (§8).** "Active week" is a **computed, clock-derived** property; added terminal `expired` and `failed` states.
10. **Minors (§3.2, §5, §6, §9).** Language = **Node/TypeScript**; model = **`claude-sonnet-5`, medium effort**, as config; caps expressed in **dollars** with defined turn/run semantics; fan-out **pooled by slot-type**; Socket Mode is a **v3.0** addition (v1.0 posts via the Web API only).

---

## 1. Summary

The Meal Planner Bot runs each Sunday morning, syncs recipes from Apple Notes, and drafts a weekly meal plan balancing complexity, cuisine, seasonality, familiarity, and household preferences against the week's constraints. It posts the draft to the `#meal-plan` channel in the "Backhaushold" Slack workspace. In v1.0 the plan is an unordered, slot-typed set of meals (day assignment arrives in v2.0 with the calendar). The family reviews and revises the draft in-thread (v3.0); once approved, the plan commits to Todoist. A later phase builds and commits a normalized grocery list to AnyList.

The system runs as a persistent local service on a Mac (not on Anthropic's cloud), because its core data source — a custom Apple Notes MCP server with a local vector database — is local-only and cannot be reached by cloud-hosted schedulers.

---

## 2. Goals and non-goals

### Goals
- Produce a varied, constraint-aware weekly plan with minimal human effort.
- Keep a human in the loop: nothing commits without explicit approval.
- Cook 5–6 nights per week total (constrained weeknights + relaxed weekend nights).
- Stay in the Claude ecosystem where it fits; branch out only where there are feature gaps.

### Non-goals (for now)
- No always-on channel monitoring beyond the active weekly thread.
- No automatic Todoist task *completion* (humans check off meals as cooked).
- No nutrition/calorie optimization.
- No multi-household or multi-workspace support.

---

## 3. Architecture

### 3.1 Deployment model

A persistent local service on the family Mac, managed by `launchd` (boot-launch + `KeepAlive`), running from day one even though inbound interactivity isn't used until v3.0. This is a deliberate choice: **build the target architecture upfront to avoid a rewrite when the revision loop lands.** v1.0 is therefore "the full daemon running a display-only workflow," not a simple cron that grows up later.

Precise meaning of "full service running" in v1.0: the **persistent daemon + in-process scheduler + SQLite state machine + startup-recovery machinery** are all present. The **Socket Mode connection is *not* open in v1.0** — v1.0 only *posts* (outbound Web API), and there is nothing inbound to receive until v3.0 (see §7, §9.2).

**Target machine:** a MacBook Pro on the desk, on Ethernet and external power, configured never to sleep. This makes the in-process scheduler reliable (no wake coordination needed) — but see §9.4 for the standing-assumption caveat and the startup catch-up that makes it safe.

**Why local, not Claude Code Routines / Cowork cloud:** the recipe source is a local-only Apple Notes MCP server with a local vector DB. Cloud-hosted schedulers can't reach it. Cowork scheduled tasks *could* run locally but only fire while the desktop app is open and are built around a polling session model, not an event-driven listener — a poor fit for live thread revision.

### 3.2 Components

- **Orchestrator (the service):** a long-running **Node/TypeScript** process. (Chosen over Python for ecosystem consistency with the household's other Node apps, native fit with the v3.0 event-driven websocket listener, and because all ML/embeddings work lives inside the recipe MCP server — the orchestrator is glue, not a data-science workload. Python was a close, viable alternative.) Drives the LLM via the **Claude Agent SDK** (chosen over the raw Messages API because it supports local MCP servers over stdio natively; the raw API's `mcp_servers` parameter expects remote HTTP/SSE endpoints, which would force us to expose local servers unnecessarily). The TS Agent SDK, MCP, Slack Bolt, and SQLite bindings are all first-class.
- **Weekly trigger:** an **in-process scheduler** inside the resident daemon fires plan generation at the Sunday slot. `launchd` owns only boot-launch + `KeepAlive`. There is **no** separate `launchd` calendar job and **no** daemon-signaling IPC. On startup the daemon runs a **catch-up check** (§8) so a reboot/crash near the trigger still produces the plan.
- **Slack interface:**
  - v1.0–v2.0: **outbound only**, via the Slack Web API (`chat.postMessage`). No websocket, no public endpoint.
  - v3.0+: a **Socket Mode** connection (persistent outbound websocket from our side — no public endpoint, no tunnel) handles inbound thread replies and slash commands.
- **MCP servers (all local, over stdio):**
  - *Recipe server* — custom Apple Notes MCP + harness (owned by us). Semantic search over a local vector DB, **plus** a cached structured-field store (times + ingredients) produced by the ingest-time extraction pass (§5).
  - *Todoist server* — adopt an existing community MCP if one is maintained; otherwise build. (v3.0)
  - *AnyList server* — adopt or build. (v4.0)
- **Local state store:** SQLite (see §8).
- **Weather:** Open-Meteo public API, no key. (v2.0)
- **Calendar:** family calendar read (source TBD — §10). Cloud read, fine from the local daemon. Enables day assignment + schedule-awareness. (v2.0)

### 3.3 Data flow (target state, v4.0)

```
launchd ──(boot-launch + KeepAlive)──► Orchestrator daemon (always resident)
                                          │
              in-process scheduler ───────┤  (Sunday slot; + startup catch-up)
                                          │
                      ├─ sync recipes ◄──stdio──► Recipe MCP (Apple Notes + vector DB
                      │                            + cached structured times/ingredients)
                      │        └─ ingest extraction pass runs here, hash-gated (§5)
                      ├─ fetch weather ◄────────► Open-Meteo                     (v2.0)
                      ├─ read calendar ◄────────► Family calendar                (v2.0)
                      ├─ read recency ◄──stdio──► Todoist MCP                    (v3.x, ADR 0006)
                      │
                      ├─ generate plan (Agent SDK / Claude)
                      │     v1.0: unordered slot-typed SET (no day assignment)
                      │     v2.0: calendar assigns meals → named days
                      ├─ post draft ──(Web API)──► Slack #meal-plan (thread)
                      │
                      ├─ revise ◄── thread replies (Socket Mode)                (v3.0)
                      ├─ /mealplan-approved ──► commit to Todoist MCP           (v3.0)
                      │
                      ├─ fetch recipes+ingredients ◄─► Recipe MCP               (v4.0)
                      ├─ normalize + aggregate ─► draft grocery list            (v4.0)
                      ├─ post draft ──(Web API)──► Slack #grocery-list          (v4.0)
                      ├─ revise ◄── thread replies                             (v4.0)
                      └─ /grocerylist-approved ─► commit to AnyList MCP         (v4.0)
```

---

## 4. Phased delivery

| Phase | Delivers | Notes |
|-------|----------|-------|
| **v1.0 (MVP)** | Sync recipes (+ ingest extraction) → tag/time-based plan as an **unordered slot-typed set** → post draft to `#meal-plan`. Writes nothing anywhere. | Seasonality from recipe *tags* (not live weather). Within-week variety only — no cross-week dedup. **No day assignment.** Full daemon + in-process scheduler + SQLite state machine + idempotency + startup catch-up present; Socket Mode **not** open. dev/prod profile in place. |
| **v2.0** | Live weather (Open-Meteo), **calendar integration** (schedule-awareness, **day assignment**, calendar-derived cook-night count, do-ahead prep timing). | Calendar work is more than "read events" — it classifies events by effect on cooking capacity, per **ADR 0004** (source = local Calendar.app/EventKit; per-calendar `cook`/`logistics` roles; FULL/QUICK/NONE per-night capacity; derived cook-night count; full prep placement; degrade-to-static on no calendar). Weather = ADR 0003 A1. **No Todoist dependency** (recency moved to v3.x, ADR 0006). |
| **v3.0** | Socket Mode listener opens. Live thread revision + `/mealplan-approved` → **commit to Todoist**, then **Todoist recency read → semantic dedup** (ADR 0006 — the read depends on the commit write). | In-code turn/token caps become load-bearing. App-level token added here. Gated on *who-may-approve* (§10.2) and the *completion-signal* decision (§10.1). Commit stamps `mp:rid=<recipe_id>` per task for the lossless recency round-trip; task-ids persist in `working_plan` (ADR 0006). |
| **v4.0** | Recipe/ingredient fetch → normalize + aggregate → draft to `#grocery-list` → revision → `/grocerylist-approved` → AnyList. | Depends on the structured-ingredient block (built in v1.0, §5). Aggregation edge cases in §10. |

---

## 5. Recipe server (Apple Notes MCP + harness)

We own both the MCP server and the harness around it, so we design the interface to fit the orchestrator rather than reverse-engineering it.

### 5.1 Tool interface (two-tier)

- **`search_recipes(query, filters)`** — returns lightweight candidates: `{id, title, key metadata}`. `query` carries the *semantic* intent; `filters` carries *structured predicates* (e.g. `active_max`, veg-satisfiable, season). The hard weeknight time gate is a **filter**, never part of the semantic query (§6.2). Cheap; keeps planner context small during fan-out.
- **`get_recipe(id)`** — returns the full note including a **structured ingredient block**. Called only for the ~5–6 chosen recipes.

**Ingredient schema (per ingredient).** Governing principle: **capture is not aggregation** — v1.0 losslessly *captures* what the note contains; v4.0 *reconciles* it (§10.6). Escape hatch: always keep the raw line, so anything unparsed is recoverable without re-reading Apple Notes. Fields:

- `raw` — the original ingredient line, always (lossless fallback).
- `name` — the core ingredient ("garlic").
- `prep` — prep descriptor ("minced", "finely diced"), kept *separate* from `name` (this is what makes the v4.0 "2 cloves garlic" vs "1 tbsp minced garlic" reconciliation tractable).
- `quantity` — **nullable** (for "to taste"); may be a **range** `{min, max}` ("2–3 cloves"), not only a scalar.
- `unit` — open string, **nullable** (countable items like "3 eggs" have none).
- `optional` — boolean ("capers (optional)").
- `alternatives` — a one-of set ("butter or olive oil"; "chicken or vegetable stock"). *Pays off in v1.0:* a vegetarian "or" is often the separability path (§6.2).
- `group` — optional sub-recipe label ("for the sauce").
- `confidence` / `needs_review` — from the extraction pass (§5.4).

**Built in v1.0, consumed in v4.0.** Cheap to add now, annoying to retrofit; turns grocery aggregation from a per-recipe LLM extraction pass into a near-deterministic operation. Three of these fields (`alternatives`, `optional`, `prep`) also feed v1.0 planning, so this is not purely speculative v4.0 investment.

> **TODO (§10):** count-with-package-size ("1 can (14 oz)", "2 (400 g) tins") — structure it (`quantity: 1, unit: can, package_size: {qty: 14, unit: oz}`) or leave to `raw` for v4.0 to parse. Non-blocking; default to `raw` if undecided at build time.

### 5.2 Recipe metadata (tags + extracted numbers)

Existing, fairly-accurate, human-maintained tags:
- **Season** — used for seasonality signal (makes v1.0 seasonality work without weather).
- **Effort** — `quick` (<30 min), `do-ahead` (>90 min or needs advance logistics), etc.
- **Quality** — `untested` (never made), `3/4/5-star` (good / great / exceptional).

Most notes *also* contain prep/active/total time in the body text. These numbers — not the tags — back the hard weeknight filter, via the extraction pass (§5.4). Note that `effort=do-ahead` and a low active-time number are **orthogonal**: active time is hands-on work; `do-ahead` is cross-day logistics (overnight marinade, day-before dough). Both are kept (§6.2).

### 5.3 Separability (deferred)

"Can the protein be cleanly removed for the vegetarian?" is **not** modeled as metadata for now. The planner infers it (aided by the `alternatives` field) and mistakes are corrected in the revision thread (v3.0). Revisit adding a `veg-separable` tag later if inference proves unreliable. *(The same "infer now, tag later only if unreliable" pattern governs picky-eater inference — §6.2.)*

### 5.4 Ingest-time extraction pass (built in v1.0)

A single normalization pass produces both the structured ingredient block (§5.1) and the `{prep, active, total}` time fields, with a confidence marker. LLM-based (preferred over regex, given messy human formats: "20–25 min", "an hour and a half", "overnight rest").

- **Runs once per note on change, not per plan run** → negligible cost, zero per-run latency.
- **Triggered at sync time, gated on a content hash** — re-extract only notes whose hash changed. *Not* via Apple Notes create/modify hooks (Notes has no clean change events).
- **Owned by the recipe server/harness**, which owns the vector index and the cached structured-field store. (This resolves "who owns sync" — it's the recipe server, at sync.)

This is where the previously-ambiguous "where does the structured block come from" is answered: here.

---

## 6. Planning logic

### 6.0 Planner mechanism (hybrid)

The planner is a **hybrid**, not a hand-rolled scoring function and not pure free-form LLM selection:

1. **Hard filters run first, deterministically**, as `search_recipes` structured predicates — *before* the LLM sees any candidate. (This is why the time data had to be extracted into structured fields, §5.4.)
2. **Everything else is an LLM reasoning input** over the surviving candidates: structured signals are passed *explicitly* as features; unstructured ones are passed as prose. The LLM selects the set with variety/quality/seasonality reasoning.

### 6.1 Slot model

Nights are **typed** by effort, not assigned to named days (day assignment is v2.0, §4):
- **Constrained (weeknight)** — hard filter: active prep time < 60 min. ~3–4 slots.
- **Relaxed (weekend)** — loose time constraints; candidate "big-cook / smoker" slots. ~2 slots.
- Total: **5–6 cooking nights/week.**

v1.0 emits an **unordered set tagged by slot-type** (N constrained + M relaxed), *not* pinned to Monday/Tuesday. The *selection mix* is v1.0; the *day mapping* is v2.0 (calendar-driven), specified in **ADR 0005**: the single selection call assigns each meal an **ISO-date `day`** by placing it onto ADR 0004's `NightSchedule`, `validate()` gains day rules (valid-night, slot↔weekday, capacity-fit, distinct days, prep-before-serve), and the render becomes day-ordered. The only build-ahead for this is a **nullable `day` field** in the plan/session schema, so v2.0 assignment and v3.0 commit are purely additive (ADR 0005 D5 is its first, additive schema evolution).

### 6.2 Constraints and signals (grouped by mechanism)

**Hard filters** (deterministic, structured, applied at retrieval):
- **Active time** — `active_max: 60` on constrained slots. Implemented as a **metadata predicate**, never via semantic search (embeddings encode similarity, not magnitude, and give no auditable "<60" guarantee).
- **Vegetarian-satisfiable (every night)** — each night must guarantee a complete meal for the vegetarian daughter, satisfied one of three ways:
  1. recipe is inherently vegetarian;
  2. recipe is *separable* (meat is a removable component — the `alternatives` field is a strong signal here);
  3. a genuine second vegetarian dish (rare fallback). Only case 3 emits a second item → a second Todoist slot / extra grocery ingredients.
  Retrieval must **guarantee a floor of veg-satisfiable candidates** per slot-type pool (§6.4), or the planner can be stuck with an all-meat pool on a night it must satisfy this constraint.

**Structured soft signals** (have a tag or number; passed to the LLM explicitly):
- **Total time / prep burden** — soft penalty (a recipe within active-time limits is still less attractive on a busy night if total prep is heavy). Now a real number thanks to §5.4. Do-aheads are **eligible-but-flagged** on weeknights rather than scheduled for prep (prep-time scheduling is v2.0+ calendar territory).
- **Quality** — soft ranking bias toward higher stars.
- **Seasonality** — from season tags in v1.0; live weather layered in v2.0 (don't double-count season vs. weather).

**Candidate-pool / sampling rules** (retrieval-level, parameterized — not "signals"):
- **Untested-recipe injection** — deliberately surface an `untested` recipe as a "try this?" candidate at a parameterized rate.

**Prompt-level reasoning inputs** (no structured data; LLM infers from titles/metadata + world knowledge):
- **Picky youngest / kid-friendliness** — no tag. Follows the §5.3 pattern: infer now, add a lightweight tag later only if inference proves unreliable. Optional cheap lever: a concrete prompt line of known-loved/disliked items.

**Parameters:**
- **Cook-nights count** — a parameter (static "3–4 weeknights + ~2 weekend" in v1.0; **needed now** because the planner must pick *how many* meals to select). v2.0 swaps the static count for a calendar-derived one.

**Relocated out of the planner:**
- **Portion / serving size** — *not a selection signal.* "Recipes scale / smaller appetites" is a quantity concern (how much to cook/buy), which belongs to v4.0 household-scaling (§10.6). Struck from selection logic.

**Missing-data default (hard-filter safety):** if a note has neither a parseable active time nor a `#quick`/`#do-ahead` tag (or extraction is low-confidence), treat it as **not weeknight-eligible** but surface it for the weekend relaxed slots — conservative on busy nights, nothing lost. Catchable by eye in v1.0 (display-only); formally correctable in-thread only at v3.0.

### 6.3 Recency / semantic dedup (v3.x — moved from v2.0 per ADR 0006)

**Phase note (ADR 0006 D1):** recency reads Todoist completed tasks, which only exist once the v3.0 commit *writes* them — so recency + dedup + the completion-signal question (§10.1) live in **v3.x**, not v2.0. v2.0 has no Todoist dependency.

- **Todoist completed tasks = sole source of truth** for "what we've eaten." No relational mirror; no ETL/sync job.
- **Round-trip is deterministic (ADR 0006 D2):** the commit stamps `mp:rid=<recipe_id>` into each task's description; recency parses it back to an exact `recipe_id` — no semantic guessing on the task→id step. Resolved ids feed **both** the exact-exclusion path (`exclude_ids`, already wired in `search.ts`/`vector-store.ts`) **and** the semantic penalty below.
- **Dedup is semantic, resolved on-the-fly:** resolved recipe ids → embeddings (reuse the recipe server's existing vectors), then penalize candidates semantically close to what's recently been on the table.
- Only build a persistent recency cache if on-the-fly resolution later proves expensive per run. Deferred with a real trigger.

### 6.4 Fan-out sizing

Retrieve candidates **pooled by slot-type**, not locked 1:1 to slots and not per named day:
- A **weeknight-eligible pool** (active-time filtered), sized ~ *(constrained slot count × 4)*.
- A **weekend-eligible pool** (relaxed filter), sized ~ *(relaxed slot count × 4)*.

~18–30 lightweight candidates total. Because the cheap search tier returns only id/title/metadata, tokens are a non-constraint; **variety headroom** is the real limit, so favor the top of the 3–5× range. The planner selects from the pools with **cross-slot variety reasoning** (per-slot independent retrieval would blind each slot to the others and wreck within-week variety, §6.3). Each pool must satisfy the veg floor (§6.2).

### 6.5 Weather (v2.0)

Open-Meteo (no key). **Resolved in bead `bgb` → ADR 0003 A1 (amendment):**

- **Temperature band (light-vs-hearty)** — **IMPLEMENTED** as a **week-level** soft signal `PlannerInput.temperature_band` (`cold`/`mild`/`hot`), horizon = the plan-week dates. Feeds the single selection call (which also does day assignment, ADR 0005). Degrades to absent (seasonal-only) on any Open-Meteo failure — silent, no alert, never fails the week.
- ~~Precipitation flag (suppress grill/outdoor if rain)~~ — **DID NOT IMPLEMENT (cut from scope, not deferred).** No structured outdoor/grill signal on recipes to act on; forecast-rain uncertain; hard-enforcement impossible without new extraction — disproportionate for a soft nudge. See ADR 0003 A1.
- **Season** — stays **tag-sourced** (§5.2, `current_season`/`season_tags`); the temperature band only *refines* it, with an explicit prompt instruction to **avoid double-counting**. Weather adds no separate season signal.

---

## 7. Slack UX

- **Workspace:** "Backhaushold" (existing). **New Slack app** (created for this project).
- **Channels:** `#meal-plan` (plans), `#grocery-list` (v4.0), `#agent-alerts` (ops), **`#dev-meal-plan`** (test output).
- **dev/prod profile:** a single `--profile dev|prod` switch (or env var) bundles the settings that must move together: target channel **ID** (explicit ID, never a name-lookup that could resolve to prod), SQLite path (a **separate file** for dev so dev runs never collide with prod session rows), force-regenerate default (**on** in dev, to bypass the §8 idempotency guard for repeat test runs), and post-vs-dry-run. Same workspace / app / bot token, so isolation is only as strong as the channel-ID config. (A separate dev workspace would harden this but is more setup than warranted.)
- **Posting mechanism:** v1.0–v2.0 posts via the Web API (`chat.postMessage`); no websocket is open. Inbound handling (thread replies, slash commands) requires Socket Mode, which opens in v3.0 (§9.2).
- **Thread-per-week:** the weekly kickoff post is a new top-level message in `#meal-plan`; all revision and approval happen as replies in *that* thread. The orchestrator persists the thread's parent `ts` for the week (§8).
- **"Active week" (defined):** the session row whose `week_key` equals the current plan-week (a **computed, clock-derived** property, not a stored flag — §8). This is what "the current week's thread" and "the single active thread" mean. It is robust across any number of skipped weeks with no maintenance.
- **Listener scope (v3.0):** react **only** to replies whose thread maps to the active week; ignore stray channel messages and prior weeks' threads.
- **Multi-person feedback:** "the family" is plural. The bot folds *all* in-thread messages into revision context and reasons over possibly-conflicting input rather than assuming a single instruction.
- **Approval commands:** `/mealplan-approved` (v3.0), `/grocerylist-approved` (v4.0).
  - Slash commands are workspace-wide; the handler resolves them to the **active** thread. Because an expired week is by definition not active, a stale week **cannot** be accidentally approved.
  - Slack requires ack < 3 s: **ack immediately, do the commit async, post confirmation as a follow-up thread message.**
  - **Soft-commit:** re-issuing an approval re-commits/overwrites. The week is not hard-locked after commit.
  - *(Dev note: slash commands are workspace-wide and are **not** channel-isolated the way posts are — revisit dev-testing of approvals when v3.0 lands.)*
- **Skip on silence:** if the draft goes unanswered, nothing commits and the draft simply expires when the week rolls over (§8). Absence of an approval *is* the skip — no timeout logic. Silent. A skipped week writes nothing to Todoist, so it never counts toward recency/dedup.

> **TODO (§10):** who may issue `/mealplan-approved`? (Anyone in the workspace, or gated?)

---

## 8. State, persistence, recovery

**SQLite** on the local disk — right-sized, zero-daemon, transactional, single inspectable file.

**Idempotency key:** the **plan-week identifier** (`week_key` — the trigger Sunday's date, or ISO year-week, in the pinned timezone). All plan generation gates on "does a session row exist for this `week_key`?" — one check covers restart catch-up, timer double-fire, and manual/test re-runs. *(This requires the week-boundary timezone to be pinned in config.)*

Per-week session state (row keyed by `week_key`):
- Thread parent `ts` (load-bearing: lost `ts` = deaf bot even though the Slack message still exists).
- Plan status (state machine below).
- The working plan itself (so a restart resumes revision rather than regenerating). Includes a **nullable `day` field** per meal (unused in v1.0; populated by v2.0 calendar assignment).
- Per-thread turn count and token spend (for the caps in §9.3).

**State machine:**
```
generating → suggested → under-revision → committed   (happy path)
generating → failed                                    (crash mid-flight)
suggested / under-revision → expired                   (week rolled over, no commit)
```
- Insert the row at `generating` **before** posting to Slack; update to `suggested` + `thread_ts` + `working_plan` **after** the post returns a `ts`. This ordering is what makes a mid-flight crash detectable (a Slack side effect can't be transactional with the local write).
- `expired` is set by **piggybacking on generation**: the next Sunday run marks the prior current-week row `expired` if it never committed. No timer/cron. (Activeness is computed, so this is for a clean record + explicit skip signal, not for correctness.)
- `failed` is set after alerting on a stale `generating` row (below), so repeated same-week crash-restarts don't re-alert.

**Startup catch-up (three cases):** on daemon start, compute the current `week_key`; then:
- A row in a **live** status (`suggested`/`under-revision`/`committed`) for the week → skip generation.
- **No row** and past the trigger time → generate now.
- A stale **`generating`** row → a prior attempt died mid-flight and may or may not have posted. **Do not auto-repost.** Fire one `#agent-alerts` message ("generation for week W was interrupted; check `#meal-plan`, re-run manually if needed"), set the row to `failed`, and stop. (Accepts a rare manual re-run to guarantee no duplicates.)

**Do not clean up old rows.** They are the historical record and let the v3.0 listener recognize a late reply to an old thread (map old `ts` → past `week_key`). SQLite is tiny. *(v3.0 UX choice, not decided: a late reply to an expired thread can be ignored (strict) or met with a one-time redirect ("that plan expired; this week's is here"). Leaning redirect. Either way: retain rows.)* An optional prune of `committed`/`expired` older than N months is a deferred someday-nicety.

**Crash recovery — resume quietly:** on restart, reload the working plan and thread `ts` from SQLite and keep listening (v3.0). Say nothing in-thread. An unhandled crash still trips an alert (§9); "resume quietly" governs only the *recovery*, not the failure that caused it.

**Consistency check:** a skipped week (`suggested → expired`) writes nothing to Todoist, so recency (which reads Todoist, not SQLite — §6.3) never sees it; `expired` never touches dedup.

---

## 9. Secrets, auth, cost control

### 9.1 Secrets
- **Primary:** 1Password service account — daemon fetches secrets programmatically at startup.
  - **v1.0 needs only:** the Slack **bot token** (`xoxb-…`) and the **Anthropic API key**.
  - The Slack **app-level token** (`xapp-…`) is a **v3.0 addition** (Socket Mode); do not front-load it.
  - Narrows the boot-time root-secret problem to one service-account token, with audit + rotation.
  - *Boot caveat:* a `launchd` daemon can't do an interactive unlock at boot; the service-account token must be readable at startup (this moves, not eliminates, the root-secret problem).
- **Fallback:** `chmod 600` env file, owned by the user, outside any repo.

> **TODO (§10):** confirm `op` CLI / 1Password supports service accounts, or fold that setup into the build.

### 9.2 Slack app
- v1.0: bot token scopes: `chat:write`. No Socket Mode enabled yet.
- v3.0: enable Socket Mode → app-level token; add channel history scopes (`channels:history` / `groups:history` per channel type) and `commands`; register slash commands in app config. **Slash commands and thread events both arrive over the socket** — because this design has no public endpoint, the socket is the only inbound path.
- v4.0: `/grocerylist-approved` (socket already open).

### 9.3 Anthropic API + cost control
- **Model:** `claude-sonnet-5` at **medium effort**, as **per-context config** (not hardcoded). Anthropic's cost-performance curves put Sonnet 5 at its best value at medium effort and below; Opus 4.8 wins per-dollar only at high/xhigh. Because v1.0 generation runs ~once/week (cost is cents regardless), generation effort can be raised (or the model swapped to Opus 4.8) freely for quality; keep v3.0 revision at medium/low to bound the loop.
  - **Code gotchas (Sonnet 5):** manual thinking `budget_tokens` is rejected (400) — use the `effort` parameter; non-default `temperature`/`top_p`/`top_k` are rejected (400) — remove them; the new tokenizer maps the same text to ~1.0–1.35× more tokens (bake into cap sizing).
- **Metered per-token usage, not subscription** — the subscription cap does *not* catch this spend.
- New API key in its **own workspace** (independent visibility + revocability).
- **Low spend alert** (email) at a threshold well below anything alarming (a few $/month is a genuine anomaly tripwire).
- **In-code hard cap (the real ceiling).** Anthropic offers spend *alerts*, not enforced per-key cutoffs, so the orchestrator enforces its own budget. **Express caps in dollars**, with per-model rates in config (the code tracks tokens — returned on every response — and converts). Pricing reference: Sonnet 5 $2/$10 per MTok input/output (intro, through 2026-08-31), then $3/$15; Opus 4.8 $5/$25.
  - **Definitions.** A **turn** = one inbound-Slack-message-triggered response cycle (the turn cap counts these). A **run** = all Agent SDK loop calls within one cycle (many API calls) — so the **token budget aggregates across all of them**, not per-call. Turn cap bounds *interaction count*; token/$ budget bounds *cost* even if one cycle explodes internally.
  - **Generation (v1.0):** per-run hard cap ≈ **$2** (~500K tokens). A realistic run costs cents; this trips only on a true runaway.
  - **Revision (v3.0), three nested guards:** per-response-cycle token cap ≈ **150K** (bounds one runaway cycle) + per-thread **turn cap ≈ 25** + per-thread cumulative budget ≈ **$5**.
  - **On any cap hit:** stop, alert `#agent-alerts`, and (for revision) post an in-thread "paused for cost" note. Never die silently.
  - This guards the real risk: not the weekly cron, but a **runaway revision loop** (v3.0+) where an event-driven listener calls a paid API on every inbound message.

### 9.4 Ops / setup checklist
- **Confirm system sleep is disabled** (`pmset -g` → `sleep 0`) — display sleep is irrelevant, *system* sleep is what matters. The in-process scheduler depends on the machine being awake at the trigger; the startup catch-up (§8) is the safety net that makes this a "posts late" rather than "silently skips" failure if the assumption ever reverts (OS update, changed power setting).
- **Do one real test-fire** of the scheduler path rather than assuming it (guards the rare launchd/scheduler "won't fire until activity" quirk).
- `#agent-alerts` is **alerts-only** (no heartbeat, no "skipping this week" messages). Complete local log on disk.

---

## 10. Open questions (flagged, non-blocking for v1.0)

1. **Completion signal (gates v3.x recency — moved from v2.0 per ADR 0006):** recency reads Todoist *completed* tasks as "meals eaten," but committing a plan creates *open* tasks. Who checks them off — does the family mark meals complete as cooked, or should recency key on *scheduled/committed* tasks instead? Resolve before wiring v3.x recency. (The task→recipe round-trip and task schema are now settled in **ADR 0006**; this remaining open question is only the read semantics.)
2. **Approval governance (gates v3.0):** who may issue `/mealplan-approved` / `/grocerylist-approved` — anyone in the workspace, or gated?
3. **1Password service-account availability:** confirm support or fold setup into the build.
4. **Calendar source (v2.0 recon):** ~~Google vs. iCloud vs. other~~ — **RESOLVED (ADR 0004):** read the **local macOS Calendar.app via EventKit**. The family schedule spans multiple iCloud calendars (incl. cross-account shares); Calendar.app is the aggregation layer, so one local read covers all of them without CalDAV/OAuth. Local-first, like the Notes reader.
5. **Todoist / AnyList / calendar MCP — adopt vs. build:** recon on maintained community servers before v2.0 / v3.0 / v4.0. *Calendar half **RESOLVED (ADR 0004): build a local reader** (EventKit), not adopt.* Todoist (v2.0/v3.0) and AnyList (v4.0, see §10.6 / bead d9i) still open.
6. **Grocery aggregation edge cases (v4.0):** unit reconciliation ("2 cloves garlic" + "1 tbsp minced garlic"), pantry staples to exclude, quantity scaling for household size. Related: the ingredient **package-size** capture decision (§5.1).

*(The earlier "weekend slots" question is resolved: weekend = relaxed slots / candidate big-cook nights per the slot model in §6.1; the concrete day mapping is now a v2.0 calendar concern.)*

---

## 11. Decisions log (ratified)

- Local persistent service (not cloud); **Node/TypeScript**; Claude Agent SDK over raw Messages API; local MCP over stdio.
- Build the persistent/interactive architecture **upfront** to avoid a v3.0 rewrite — but distinguish building *machinery* early (daemon, state schema, structured ingredients) from emitting *content* early (day assignment), which is deferred.
- **Trigger:** in-process scheduler in the resident daemon; `launchd` = boot-launch + `KeepAlive` only; startup catch-up makes the never-sleep assumption safe.
- **Idempotency:** week-keyed guard; `generating` pre-post status; three-case startup catch-up.
- **State machine:** `generating → suggested → under-revision → committed`, plus `failed` and `expired`; "active week" is computed, clock-derived; rows are retained, not cleaned up.
- Phase map: v1.0 display-only (unordered slot-typed set, no day assignment); v2.0 weather + **calendar (introduces day assignment)** (no Todoist dependency); v3.0 revision + Todoist commit + **recency/dedup** (moved from v2.0, ADR 0006) + Socket Mode; v4.0 grocery + AnyList.
- **Planner = hybrid:** deterministic hard-filter pre-pass (structured predicates) + LLM reasoning over survivors. Signals grouped by mechanism; picky-youngest = prompt-level reasoning input; portion relocated to v4.0 scaling.
- Recency = Todoist completed tasks, sole source of truth; semantic dedup on-the-fly; no mirror/ETL. **Moved v2.0 → v3.x (ADR 0006, bead `chj`):** recency reads the commit's writes, so it can't precede commit. **Round-trip is deterministic** — commit stamps `mp:rid=<recipe_id>` per task; recency parses it back (→ wired `exclude_ids` + semantic penalty), no title guessing. **Task schema:** config'd project, recipe-title content, ISO-`day` due, `second_dish`/prep → own tasks. **Task-ids persist in `working_plan` JSON** (`todoist_task_id?`, additive/resume-safe, no new column) for re-commit update-in-place. Completion signal (§10.1) + MCP adopt-vs-build stay open, both v3.x.
- Two-tier recipe interface; **ingest-time extraction pass** (hash-gated, at sync, owned by the recipe server) produces structured **times + ingredients** in v1.0; ingredient schema frozen (raw always kept).
- Vegetarian-satisfiable as a per-night hard constraint (inherent / separable / rare second dish); separability inferred; retrieval enforces a veg-satisfiable floor per pool.
- Active-time hard filter (metadata predicate, not semantic search) + total-time soft penalty; active-time and `do-ahead` treated as orthogonal; do-aheads eligible-but-flagged.
- Quality tags = soft ranking + parameterized untested injection.
- Fan-out pooled by slot-type (~3–5× per slot; favor the high end).
- **Weather (v2.0, ADR 0003 A1, bead `bgb`):** one **week-level** soft signal `temperature_band` (`cold`/`mild`/`hot`) from Open-Meteo (no key); refines the tag-based `current_season` (no double-count); feeds the single selection+assignment call; degrade-to-absent (seasonal-only) + silent on fetch failure. **Precipitation/grill signal cut from scope** (no structured outdoor signal; §6.5). No validation added (advisory only).
- **Day assignment (v2.0, ADR 0005):** the single ADR-0003 selection call assigns each meal an **ISO-date `day`** by placing it onto ADR-0004's `NightSchedule` (LLM decides, code guarantees — no separate pass). `validate()` gains day rules (valid non-NONE night, slot↔weekday, QUICK capacity-fit, distinct days, prep-before-serve) under the existing one-shot repair; the Slack render moves from slot-sections to **day-ordered** (Mon→Sun) with capacity + prep annotations. `SelectedMeal.day` becomes a **nullable ISO date** (null = legacy v1.0 / degraded) — the first additive `working_plan` evolution, resume-safe (bd6.10, bd6.13).
- Open-Meteo for weather; no key. **Calendar = local read (v2.0, ADR 0004): Calendar.app via EventKit** (aggregates multiple iCloud calendars incl. shares), TCC Calendars grant on `node`. Include-list of calendars with `cook`/`logistics` roles; per-night FULL/QUICK/NONE capacity from cooking-window overlap; cook-night count = #(FULL)+#(QUICK) (replaces static 4+2); full prep placement in v2.0, materialized to Todoist in v3.0; no calendar ⇒ degrade to static count + alert, never fail the week. Produces a `NightSchedule` (the seam bead 824 consumes for day assignment).
- One channel, thread-per-week, listener scoped to the active (computed) week; slash-command approval resolves to the active thread; soft-commit; skip-on-silence, silent.
- **dev/prod profile** (channel ID + SQLite path + force-regenerate + post/dry-run); `#dev-meal-plan` for test output.
- SQLite for per-week state; resume-quietly on restart; nullable `day` field carried for v2.0.
- **Slack:** v1.0 posts via Web API (bot token + `chat:write` only); Socket Mode + app-level token are a v3.0 addition.
- 1Password service account (primary) / `chmod 600` env file (fallback); own API workspace; `claude-sonnet-5` medium effort (config); spend alert + in-code dollar-denominated caps (per-run generation cap; per-cycle/turn/thread caps for revision).
- Ops: verify system sleep disabled + test-fire the scheduler; `#agent-alerts` alerts-only; complete local log.
