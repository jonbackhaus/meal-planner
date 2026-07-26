# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

## Git Authority — this repo opts in to Team-maintainer

**This section is the repository's explicit opt-in** required by the Agent
Context Profiles block above. That block is bd-managed (regenerated from a
template) and defaults to the conservative git policy; this section overrides
it, and the block itself defers to repository instructions.

**The active profile is Team-maintainer, unconditionally.** Landing work is
part of the job, not a separate approval step:

- **Default workflow is branch → PR → CI green → squash-merge → cleanup.** Run
  it end to end without pausing for push/merge approval. Watch with
  `gh pr checks <n> --watch`; merge with
  `gh pr merge <n> --squash --delete-branch`. **Never merge red.**
- **Re-run the gates yourself on the pushed branch before merging.** Never
  merge on a subagent's or an earlier step's "it passed."
- **Close beads, run quality gates, commit, and push as part of session close.**
  Don't leave verified work stranded locally — that is not "done."

Still genuinely blocking, and worth interrupting for:

- An explicit current "do not commit" / "do not push" instruction — that always wins.
- Anything irreversible or leaving the repo: force-push, history rewrite,
  branch/tag deletion beyond merged feature branches, published releases,
  secrets, prod data.
- **Design semantics.** Ambiguity in *behavior* — an unratified state-machine
  interaction, a cost/limit default, a schema shape — is what deserves the
  escalation budget. A revertible squash-merge behind green CI is not.

An instruction to "finish", "land", or "ship" work carries push-and-merge
authority. State any assumption once and proceed; don't re-raise it each turn.
Background task notifications are not user turns, and their "do not interpret
as acknowledgement" boilerplate prevents *fabricating* consent — it is not
evidence that consent was required. See the bd memory
`workflow-land-work-by-default-when-told-to-finish` for the incident this
encodes.

## Beads Export Hygiene — never discard `.beads/issues.jsonl`

**Dolt is authoritative; `.beads/issues.jsonl` is a passive export.** Reconcile
*toward* Dolt, never away from it.

**Never run `git checkout -- .beads/issues.jsonl`** to clean the tree. bd's
export is not sorted by any stable key, so a rewritten row moves its line — a
real `open → closed` transition and meaningless line movement look identical in
`git diff`. Discarding the file on that assumption silently reverts real status
(incident 2026-07-26, bead `meal-planner-p2p`; commits `a25c673` → `31939e6`).

Before trusting or discarding any export diff, diff it **semantically**:

```bash
node scripts/beads-diff.mjs            # HEAD's committed export vs. live Dolt
node scripts/beads-diff.mjs --staged   # staged export vs. live Dolt
node scripts/beads-diff.mjs a.jsonl b.jsonl
```

It compares by issue id, not by line, and separates benign line movement and
`updated_at` bumps from real status/priority/label deltas. Exit 1 means a real
delta. If it reports anything significant, re-export (`bd export -o
.beads/issues.jsonl`) and commit that — do not revert.

**The commit is kept fresh automatically.** `.beads/hooks/pre-commit` carries a
repo-owned block (below bd's managed `END BEADS INTEGRATION` marker) that runs
an explicit `bd export` and re-stages the file when it was already staged, so a
commit can't capture an export predating the `bd` writes it should record.
Without it, bd's async exporter (`export.interval`, default 60s) refreshes the
*working tree* but never stages it, so git commits the stale index and the
correction shows up afterwards looking like churn. Set `BD_SKIP_EXPORT_REFRESH=1`
to bypass. **After `bd hooks install` or a bd upgrade, check the block survived.**

## Project Status

**v1.0 runtime code-complete on `main`.** The full `src/` tree, toolchain (pnpm
+ Vitest + Biome), and test suite (~491 tests passing) are in place; the v1.0
daemon is built and PRs #1–#19 are merged. Remaining work is ops go-live (see
`docs/RUNBOOK.md`) and the v2.0+ phases. The design docs in `docs/` remain the
authoritative source for intent and invariants:

- `docs/SPEC.md` — the authoritative design document (v1.0). Read this first. Section numbers (§) are referenced throughout the ADRs.
- `docs/adr-0001-recipe-mcp-structured-field-interface.md` — Recipe MCP two-tier tool interface + ingest-time extraction + frozen ingredient schema.
- `docs/adr-0002-orchestrator-state-machine-idempotency.md` — session schema, state machine, week-keyed idempotency, startup catch-up.
- `docs/adr-0003-planner-hybrid-selection-contract.md` — planner prompt, `WeekPlan` output schema, and deterministic post-validation.

When implementing, **the ADRs override the SPEC** where they refine it, and both are more specific than this file. Keep them in sync when a decision changes.

## Build & Test

The **stack** (per SPEC §3.2) is **Node/TypeScript** (Node ≥ 22, pnpm), driving Claude via the **Claude Agent SDK** (chosen over the raw Messages API for native stdio MCP support), with the **Slack Web API**, **SQLite** (`better-sqlite3` + `sqlite-vec`), and local **MCP servers over stdio**. The daemon is managed by `launchd` (boot-launch + `KeepAlive` only; the weekly trigger is an in-process scheduler, not a launchd calendar job).

Commands (from `package.json`):

```bash
pnpm install                 # deps (CI: pnpm install --frozen-lockfile)
pnpm build                   # tsc -p tsconfig.json → dist/
pnpm typecheck               # tsc --noEmit (source)
pnpm typecheck:test          # tsc -p tsconfig.test.json (tests)
pnpm test                    # vitest run (full suite)
pnpm vitest run <path>       # single test file
pnpm vitest run -t "<name>"  # single test by name
pnpm lint                    # biome check .
pnpm format                  # biome format --write .
pnpm dev                     # tsx watch src/index.ts (dev daemon)
pnpm sync                    # tsx src/sync-cli.ts (recipe sync CLI)
```

Model config (SPEC §9.3): `claude-sonnet-5` at medium effort, as per-context config (not hardcoded). Gotchas — manual thinking `budget_tokens` is rejected (use `effort`); non-default `temperature`/`top_p`/`top_k` are rejected; the new tokenizer runs ~1.0–1.35× higher token counts (size cost caps accordingly).

**Local run & ops gotchas** (learned in the 2026-07-20 go-live):
- **`.env` auto-loads for `pnpm dev`/`pnpm sync`** (the scripts pass `--env-file-if-exists=.env`) — but a hand-run *built* daemon (`node dist/index.js`) does not; `set -a; source ./.env; set +a` first. launchd carries the same vars via the plist `EnvironmentVariables`, not your shell.
- **Rebuild `dist/` after ANY source change meant to reach the daemon** (learned 2026-07-24 go-live) — prod runs the *compiled* `node dist/index.js`, NOT `src/`, so `git pull`/merge updates source but leaves the running daemon on stale `dist/`. Run **`pnpm build`** then reload launchd (`launchctl unload/load`); build alone doesn't restart the resident process, reload alone runs stale code. (Whole v2.0 was merged green yet the daemon kept executing the old build — `dist/calendar/` didn't exist — so the new calendar vars would have done nothing.) Asymmetry: `pnpm dev`/`pnpm sync` use tsx and run `src/` directly (no build); prod is the built `dist/`. CI builds fresh per run, so it's unaffected. Quick check: `dist/index.js` mtime vs newest `src/*.ts`, or `ls dist/<new-module>/`.
- **macOS has no `timeout`** — bound a hangable command (`op`, sync, the daemon) with a background sleep-kill watchdog (`cmd & p=$!; (sleep N; kill -9 $p) & wait $p`), not `timeout`.
- **A full recipe re-sync is expensive** — a note-reader/hash change invalidates the index, so the whole corpus re-processes and exceeds the default `MP_GENERATION_DOLLAR_CAP=2`. Use the **`/resync-recipes`** skill (`.claude/skills/resync-recipes/`), which raises the cap for the one-off out-of-band `pnpm sync` and runs it under a watchdog (RUNBOOK §6; bead a9e).
- **launchd plist gotchas** — `PATH` must include `/opt/homebrew/bin` (else `op` isn't found → boot crash-loop), and it needs the *real* `OP_SERVICE_ACCOUNT_TOKEN` (not the template placeholder); the daemon's `node` needs Full Disk Access + Automation→Notes (TCC keys on the binary — re-grant after node/OS upgrades). RUNBOOK §0.1/§7.
- **Prod's calendar read is `native/ekreader` (EventKit), not node** (bead ob8/12p) — built by `pnpm build:native` (macOS-only, NOT part of `pnpm build`/CI, so it never runs there); it needs its own **Calendars** TCC grant separate from node's Automation/FDA grants. `build:native` signs it with a stable Apple Development cert (`--identifier com.backhaus.meal-planner.ekreader`, override via `MP_EKREADER_SIGN_IDENTITY`) + embeds an `Info.plist` usage-description, so the grant is triggered by running the bare binary once (click Allow), **carries to the headless launchd daemon, and survives rebuilds** (stable designated requirement — only an OS upgrade drops it). This resolved the 12p "launchd can't read calendar" limitation: the earlier revert failed only because it granted a `.app` wrapper while launchd exec'd the bare binary (identity mismatch). RUNBOOK §0.1 item 3/§8.1.

## Architecture Overview

A **persistent local daemon** on the family Mac (not cloud — the recipe source is a local-only Apple Notes MCP with a local vector DB that cloud schedulers can't reach). Each Sunday it syncs recipes, drafts a weekly meal plan, and posts it to Slack `#meal-plan`. The full daemon architecture is built in v1.0 even though inbound interactivity doesn't land until v3.0 — a deliberate choice to avoid a later rewrite.

Weekly flow: `in-process scheduler (+ startup catch-up)` → `sync recipes via Recipe MCP` → `generate plan (Agent SDK)` → `post draft to Slack (Web API)`.

**Phased delivery** (build the machinery early, defer emitting content):
- **v1.0 (MVP):** recipe sync + ingest extraction → hybrid planner → post an **unordered, slot-typed set** (no day assignment) to `#meal-plan`. Writes nothing anywhere. Full daemon + scheduler + SQLite state machine + idempotency + startup catch-up present; Socket Mode **not** open.
- **v2.0:** live weather (Open-Meteo) + **calendar** (introduces day assignment) + Todoist recency read → semantic dedup.
- **v3.0:** Socket Mode listener → in-thread revision + `/mp-approve` → commit to Todoist.
- **v4.0:** grocery list normalize/aggregate → `#grocery-list` → `/grocerylist-approved` → AnyList.

**Three subsystems:**
1. **Recipe MCP server** (ADR 0001, owned by us) — two-tier interface: cheap `search_recipes(query, filters)` for fan-out (semantic intent in `query`, structured predicates like `active_max` in `filters`), full `get_recipe(id)` for the ~5–6 chosen. An **ingest-time extraction pass** (hash-gated, at sync) produces the structured `{prep, active, total}` times and the frozen ingredient block.
2. **Orchestrator daemon** (ADR 0002) — SQLite session state keyed by `week_key`, the state machine, and startup recovery. The orchestrator owns retrieval and pool composition; it is glue, not a data-science workload.
3. **Planner** (ADR 0003) — a **hybrid**: deterministic hard filters run first as `search_recipes` predicates, then the LLM does *selection only* over the survivors, emitting a structured `WeekPlan` (which IS the stored `working_plan`); the Slack draft is rendered from it.

## Conventions & Patterns

Invariants pulled from the design docs — preserve these when implementing:

- **Write-before-post ordering** (ADR 0002): insert the session row at `generating` **before** posting to Slack, then update to `suggested` + `thread_ts` + `working_plan` after the post returns a `ts`. A Slack side effect can't be transactional with the local write; this ordering is what makes a mid-flight crash detectable.
- **Week-keyed idempotency** (ADR 0002): all generation gates on "does a session row exist for this `week_key`?" — one check covers restart catch-up, timer double-fire, and manual re-runs. Requires the week-boundary timezone pinned in config.
- **"Active week" is computed, not stored** — it's the session row whose `week_key` equals the current plan-week (clock-derived). Never a stored flag. Rows are **retained, never cleaned up** (historical record + late-reply mapping).
- **Startup catch-up, three cases:** live row → skip; no row past trigger → generate; stale `generating` row → alert once, set `failed`, **never auto-repost** (accepts a rare manual re-run to guarantee no duplicates).
- **Hard filter vs. LLM** (SPEC §6, ADR 0003): hard constraints (active-time `<60`, veg-satisfiable floor) are **structured metadata predicates**, never semantic search. Everything else is an LLM reasoning input. The planner selects; it does not filter.
- **Capture is not aggregation** (ADR 0001): v1.0 losslessly *captures* ingredient fields (always keep `raw` as fallback); v4.0 reconciles. Keep `prep` separate from `name`.
- **Deterministic post-validation** with one bounded repair retry on the planner output (ADR 0003 D5).
- **Cost caps are dollar-denominated and enforced in code** (SPEC §9.3) — Anthropic offers alerts, not enforced per-key cutoffs. A *turn* = one inbound-message response cycle; a *run* = all Agent SDK calls within one cycle (budget aggregates across them). The real risk is a runaway v3.0 revision loop, not the weekly cron.
- **dev/prod profile** (SPEC §7): a single `--profile dev|prod` switch bundles settings that must move together — target channel **ID** (never a name lookup), a **separate** SQLite path for dev, force-regenerate (on in dev), and post-vs-dry-run.
- **Slack** is outbound-only via the Web API (`chat:write`) through v2.0; Socket Mode + the app-level token are a v3.0 addition — do not front-load them.
- Nullable `day` field is carried through v1.0 schemas (unused until v2.0 calendar assignment) so v2.0/v3.0 are purely additive.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts. `cp`, `mv`, and `rm` may be aliased to `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

```bash
# Force overwrite / delete without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

Other commands that may prompt: `scp`/`ssh` → `-o BatchMode=yes`; `apt-get` → `-y`; `brew` → `HOMEBREW_NO_AUTO_UPDATE=1`.
