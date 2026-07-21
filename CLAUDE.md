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
- **`.env` is NOT auto-loaded** (no dotenv) — `set -a; source ./.env; set +a` before `pnpm dev`/`pnpm sync`/`node dist/index.js`. launchd carries the same vars via the plist `EnvironmentVariables`, not your shell.
- **macOS has no `timeout`** — bound a hangable command (`op`, sync, the daemon) with a background sleep-kill watchdog (`cmd & p=$!; (sleep N; kill -9 $p) & wait $p`), not `timeout`.
- **A full recipe re-sync is expensive** — a note-reader/hash change invalidates the index, so the inline pre-gen sync re-processes the *whole* corpus and exceeds the default `MP_GENERATION_DOLLAR_CAP=2`; raise the cap for the one-time out-of-band `pnpm sync` backfill (RUNBOOK §6; bead a9e).
- **launchd plist gotchas** — `PATH` must include `/opt/homebrew/bin` (else `op` isn't found → boot crash-loop), and it needs the *real* `OP_SERVICE_ACCOUNT_TOKEN` (not the template placeholder); the daemon's `node` needs Full Disk Access + Automation→Notes (TCC keys on the binary — re-grant after node/OS upgrades). RUNBOOK §0.1/§7.
- **Verifying a worktree branch** — run gates *inside* the worktree dir; vitest launched from the repo root also globs `.claude/worktrees/*/` and doubles the test/file counts.

## Architecture Overview

A **persistent local daemon** on the family Mac (not cloud — the recipe source is a local-only Apple Notes MCP with a local vector DB that cloud schedulers can't reach). Each Sunday it syncs recipes, drafts a weekly meal plan, and posts it to Slack `#meal-plan`. The full daemon architecture is built in v1.0 even though inbound interactivity doesn't land until v3.0 — a deliberate choice to avoid a later rewrite.

Weekly flow: `in-process scheduler (+ startup catch-up)` → `sync recipes via Recipe MCP` → `generate plan (Agent SDK)` → `post draft to Slack (Web API)`.

**Phased delivery** (build the machinery early, defer emitting content):
- **v1.0 (MVP):** recipe sync + ingest extraction → hybrid planner → post an **unordered, slot-typed set** (no day assignment) to `#meal-plan`. Writes nothing anywhere. Full daemon + scheduler + SQLite state machine + idempotency + startup catch-up present; Socket Mode **not** open.
- **v2.0:** live weather (Open-Meteo) + **calendar** (introduces day assignment) + Todoist recency read → semantic dedup.
- **v3.0:** Socket Mode listener → in-thread revision + `/mealplan-approved` → commit to Todoist.
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

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker (Codex)

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
