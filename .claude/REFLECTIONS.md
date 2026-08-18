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

## Open questions

- **`4sr` (round-trip go-live) is ops-only, not agent-drivable end-to-end.**
  It's 1Password secret storage, Slack-dashboard config (Event Subscriptions +
  slash-command registration), launchd reload, and TCC/prod verification on the
  family Mac — steps an agent can prep and sanity-check but can't execute
  headlessly. If splitting it later, the RUNBOOK §8.2 checklist maps cleanly
  onto sub-issues (secrets / Slack-config / the three live verifications:
  socket-opened, in-thread revision, `/mp-approve` commit).
