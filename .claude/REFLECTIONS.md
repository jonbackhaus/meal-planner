# Project Reflections

Reflective notes maintained at session wrap-up. Rules to obey live in
`CLAUDE.md`; backlog and work state live in Beads (`bd`); the authoritative
design intent lives in `docs/SPEC.md` + the ADRs. This file is for
*understanding* — mental models, gotchas-with-context, and why decisions went
the way they did — the kind of thing that has no natural home in an issue
tracker.

## Current understanding

- **Top-level Slack messages already reach the daemon; thread-only scope is a
  choice, not a technical limit.** With `channels:history` + the
  `message.channels` Event Subscription, Slack delivers *every* channel message
  to the `message` handler in `src/slack/inbound-router.ts` — including
  top-level ones that @mention the bot. The router drops them only because they
  lack a `thread_ts`. Consequence: supporting top-level @mentions would **not**
  require the `app_mentions:read` scope / an `app_mention` handler (the natural
  assumption, and the one bd `meal-planner-kqq` was written under). A dedicated
  `app_mention` path would be *cleaner*, but the message event is already in
  hand. We deliberately kept thread-only anyway (SPEC §7; ratified in bd
  `meal-planner-j8b`) because the whole revision loop keys on `thread_ts →
  session row`, so a top-level message has no plan context to act on. Read the
  RUNBOOK's "does nothing, by design" line with this nuance: *by design*, not
  *impossible*.

## Lessons & gotchas

- **Model dependency edges from the durable work, not toward closed work.**
  When a bead is a *stopgap that exists only until some real work lands*, the
  blocking edge points **real-work → stopgap** (the real work blocks the
  stopgap, because finishing it makes the stopgap unnecessary). Example this
  backlog: `4sr` (v3.0 round-trip go-live) **blocks** `88j` (interim recency
  back-fill CLI) — once the prod round-trip is live and writing recency data,
  `88j` is moot. Corollary: never wire a `blocks` edge against an
  already-**closed** bead — it would assert open work is waiting on something
  finished. Use a `relates_to` link instead for context to closed beads (e.g.
  `88j ↔ v9v`/`chj`: the dedup epic + the ADR-0006 decision that named the
  v2.0/v3.0 phase-ordering hole `88j` bridges).

- **A routine `brew upgrade` took prod down for ~3 weeks by replacing the
  daemon's `node` and `op` binaries — three distinct failure modes, one trigger**
  (2026-08-19 incident, bd `meal-planner-93k`; my *first* diagnosis here blamed
  an ekreader cert rotation and was wrong — recorded so the mistake isn't
  repeated). On **Aug 1** `brew` bumped `node` 26.5.0 → 26.5.1 (**deleting** the
  26.5.0 binary) and `1password-cli`, near the macOS 26.5.2 upgrade. That one
  event caused, in sequence:
  1. **Ghost-binary TCC failure.** The daemon had run since Jul 26 on node
     26.5.0; after Aug 1 that process held a binary no longer on disk. macOS TCC
     can't validate a deleted binary, so the daemon's calendar (`ekreader`, exit
     3) and Notes (`osascript -1743`) reads began failing on the next weekly run
     (Aug 2). **This was the "calendar failing" symptom — not the ekreader
     grant.** ekreader reads the calendar fine (verified 20 real events); its
     grant was never broken. A running daemon can silently rot the moment
     `brew` deletes the binary underneath it, while `git`/`ps` look normal.
  2. **Gatekeeper block on the fresh binaries.** Restarting to clear the ghost
     surfaced that the freshly-installed, *quarantined* node 26.5.1 and op were
     blocked by macOS `AppleSystemPolicy` ("Security policy would not allow
     process"). `op` hung spawning its `op-daemon` child (all threads parked in
     `__psynch_cvwait`, zero output), so secrets-load timed out at 15s and the
     daemon crash-looped. **Fix: approve *both* `op` and `node` in Privacy &
     Security** — the launchd daemon's own main binary (`node`) needs approval,
     not just the tool it shells out to. This op breakage was latent since ~Aug
     1: the daemon would have died on *any* reboot regardless; the restart
     merely surfaced it.
  3. **Voided per-binary TCC grants.** TCC keys Automation/Calendar grants to
     the exact Cellar path/cdhash, so node 26.5.1 inherits none of node
     26.5.0's grants — the Notes Automation grant likely still needs one
     interactive re-grant (open at time of writing; verify on the Sun 2026-08-23
     run).
  **Prevention now in place:** `brew pin node` + `brew pin 1password-cli` so a
  background `brew upgrade` can't silently replace them again. Diagnostic
  reflex for "op hangs": `sample <pid>` a stuck process (no sudo needed) and
  grep the system log for `AppleSystemPolicy` — that's what pinned it to
  Gatekeeper. And note the failure was *invisible from the outside*: the daemon
  kept posting a degraded (static all-FULL, no-dedup) plan and only the alert
  log showed it — read `logs/meal-planner.err.log`, don't trust "it still
  posted."

## Open questions

- **`4sr` (round-trip go-live) is ops-only, not agent-drivable end-to-end.**
  It's 1Password secret storage, Slack-dashboard config (Event Subscriptions +
  slash-command registration), launchd reload, and TCC/prod verification on the
  family Mac — steps an agent can prep and sanity-check but can't execute
  headlessly. If splitting it later, the RUNBOOK §8.2 checklist maps cleanly
  onto sub-issues (secrets / Slack-config / the three live verifications:
  socket-opened, in-thread revision, `/mp-approve` commit).
