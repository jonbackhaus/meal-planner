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

- **The planner had literal amnesia until 2026-09-27, and it showed.** Dedup
  depends on the Todoist recency read, which failed every week (bd `54i`) and
  whose data source (the v3.0 round-trip, `4sr`) isn't live — so across 7
  weeks of plans the bot used only **17 distinct recipes out of 765**. The fix
  (bd `5uy`, PR #75) treats each week's *initial* posted plan as accepted:
  `session.initial_plan` is written once at suggest and never revised, and
  `plan-memory.ts` unions the last 8 weeks' main dishes with the Todoist read.
  Two design choices worth keeping in mind: (1) *initial*, not latest — the
  user's explicit call, and `working_plan`/`last_posted_plan` both mutate on
  revision, hence the new column; (2) the union catches a Todoist throw
  *itself*, because `buildPlan`'s degrade-silently catch would otherwise
  discard the local memory along with the failed Todoist result.

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
     26.5.0's grants. node 26.5.1 lacked Full Disk Access until
     2026-09-27 (`notes-tags: could not open NoteStore … unable to open
     database file` every run; only the tag refresh was skipped). FDA is now
     granted (TCC.db `auth_value=2`); the Oct 4 run is the first real proof.
  **Prevention now in place:** `brew pin node` + `brew pin 1password-cli` so a
  background `brew upgrade` can't silently replace them again. Diagnostic
  reflex for "op hangs": `sample <pid>` a stuck process (no sudo needed) and
  grep the system log for `AppleSystemPolicy` — that's what pinned it to
  Gatekeeper. And note the failure was *invisible from the outside*: the daemon
  kept posting a degraded (static all-FULL, no-dedup) plan and only the alert
  log showed it — read `logs/meal-planner.err.log`, don't trust "it still
  posted."

- **An unanswerable consent prompt + a fatal boot timeout + `KeepAlive` = a
  prompt flood** (2026-09-23, just before the macOS 27.0 upgrade; bd
  `meal-planner-dx2`). `op read` blocked on a macOS dialog; the dialog said
  "node" because TCC names the *responsible* process (launchd → node → op).
  The 15s secrets timeout exited the process, `KeepAlive` relaunched it at
  once, and each new process raised a fresh "Allow" prompt — endless dialogs
  until the user set `KeepAlive=false` by hand. The likely source is `op`
  probing the 1Password desktop app (installed; its group container is
  `2BUA8C4S2C.com.1password`) even though a service-account token needs no
  app integration. `OP_BIOMETRIC_UNLOCK_ENABLED=false` in the plist env
  (PR #73) made the next boot load secrets cleanly — consistent with, not
  proof of, that cause (the system log had already rotated). In hindsight the
  August "op hangs, all threads parked in `__psynch_cvwait`" symptom is the
  same shape: a process waiting on a dialog. Treat any headless `op` hang as
  "who is it waiting on?" before blaming the network.

- **Bead state no longer touches git (2026-09-27, PRs #77 + `37e8979`).** Both
  `.beads/issues.jsonl` and `.beads/interactions.jsonl` are gitignored. The
  tracked export was the source of constant tree churn — every claim, comment,
  or close forced a beads-only commit or a direct push to `main` — and of the
  July "discarded real statuses via `git checkout --`" incident; untracking
  removes both. Bead state rides `refs/dolt/data` (`bd dolt push`). Caveat:
  `interactions.jsonl` is bd's optional audit sidecar, **not** in Dolt, so its
  entries after 2026-09-27 exist only on this Mac.

- **Don't verify with real writes against the live tracker.** A "does a bd
  write leave the tree clean?" check was done with `bd comments add ...
  test-noise` on a real bead (54i) — and embedded-mode bd has no comment
  delete (`bd sql` is unsupported there), so the noise is permanent. Use a
  read-only check or a throwaway bead you can close.

- **A handoff's "lead" is a hypothesis, not a diagnosis — 54i proved it.**
  The recorded lead for "Todoist recency: Invalid argument value" was
  `toISOString` millisecond precision; a read-only live repro disproved it in
  minutes (ms precision returns 200). The real cause was the live plist's
  `MP_TODOIST_PROJECT_ID_PROD` holding a **pre-2025 numeric Todoist project
  id**, which the v1 API rejects (`error_extra.argument: "project_id"`); the
  RUNBOOK had told us to source it from the deprecated v2 endpoint. Two
  takeaways: the error body *named the field* all along but our client threw
  it away (PR #79 now folds `error_extra.argument` into the message), and a
  config-value bug survives every rebuild — "persists across builds" pointed
  at env, not code. Fixed in prod 2026-09-29 (`6Crcx82JRXcwQQv3`); the Oct 4
  run is the proof. Next layer down (bd `ww2`): completed meal tasks carry no
  `mp:rid=` marker, so recency will still resolve zero recipe ids.

- **Restart safety is back on (2026-09-29).** The Sep 23 lockdown had set
  `KeepAlive` *and* `RunAtLoad` false (so unload/load left the daemon
  stopped). `dx2` (PR #78) added a secrets-free boot-failure guard —
  persisted streak in `data/boot-failure-state.json`, one log alert per 30
  min, exponential backoff to 60s before `exit(1)` — and both flags were
  restored. The guard alerts to the local log only (no Slack: secrets may be
  what failed), so a boot crash-loop still shows up only in
  `logs/meal-planner.err.log`.

## Open questions

- **What happens to the plan memory once Todoist round-trip feedback flows?**
  Today it's a union: "recommended" and "actually completed" both count as
  recent. Once `4sr` is live, a recommended-but-rejected meal arguably
  shouldn't be excluded for 8 weeks — the user said this behavior will be
  "modified later to incorporate round-trip feedback," not yet designed.

- **`4sr` (round-trip go-live) is ops-only, not agent-drivable end-to-end.**
  It's 1Password secret storage, Slack-dashboard config (Event Subscriptions +
  slash-command registration), launchd reload, and TCC/prod verification on the
  family Mac — steps an agent can prep and sanity-check but can't execute
  headlessly. If splitting it later, the RUNBOOK §8.2 checklist maps cleanly
  onto sub-issues (secrets / Slack-config / the three live verifications:
  socket-opened, in-thread revision, `/mp-approve` commit).
