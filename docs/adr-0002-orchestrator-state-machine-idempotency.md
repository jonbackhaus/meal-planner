# ADR 0002 — Orchestrator state machine & week-keyed idempotency

- **Status:** Accepted (mechanism fixed; field-level details may be refined during implementation)
- **Date:** 2026-07-09
- **Owner:** Backhaus
- **Relates to:** Meal Planner Bot design doc v1.0, §3.2 (trigger/catch-up), §7 (active week), §8 (state/persistence/recovery), §9.3 (cost counters); sibling ADR 0001 (recipe interface)

---

## Context

The orchestrator is a resident daemon with an in-process scheduler (design §3.2). It must survive three realities without ever posting a duplicate draft or silently skipping a week:

1. **Non-transactional Slack side effect.** Posting a draft (`chat.postMessage`) returns a thread `ts` that is load-bearing (lost `ts` = deaf bot in v3.0), but the post is an external side effect that *cannot* be made transactional with the local write. A crash between "post succeeded" and "record the `ts`" is possible.
2. **Multiple generation triggers.** Restart catch-up (§3.2), an in-process timer double-fire, and manual/dev re-runs can all try to generate the same week.
3. **Skips.** A week can go unanswered and roll over. Across any number of skipped weeks, the v3.0 listener still needs an unambiguous "which thread is current."

SQLite is the store (design §8, already ratified). This ADR fixes the **state machine, the idempotency key, the write ordering, and the startup reconciliation** layered on top of it.

---

## Decision

### D1 — Idempotency key = `week_key`, a clock-derived plan-week identifier

`week_key` is the **anchor Sunday's date** in a **pinned timezone** (e.g. `2026-07-12`). All generation gates on *"does a session row exist for this `week_key`?"* — one gate covers restart catch-up, timer double-fire, and manual re-runs. (ISO year-week is a viable alternative; the Sunday-date is chosen to avoid ISO's Monday/Sunday boundary confusion given a Sunday trigger.) **This requires pinning the week-boundary timezone + trigger time in config** — a real dependency, called out in Open Items.

### D2 — State machine with a pre-post `generating` status and write-before-post ordering

Insert the row at `generating` **before** posting; update to `suggested` (+ `thread_ts` + `working_plan`) **after** the post returns a `ts`. This ordering is the whole trick: it makes a mid-flight crash *detectable* (a stale `generating` row is the evidence a Slack side effect may have escaped without a local record). Terminal `failed` and `expired` states complete the machine.

### D3 — "Active week" is computed, not stored

`active = (row.week_key == currentPlanWeek(now))`. Not a stored flag, not "latest `ts`." No deactivation job; robust across any number of skips (past keys are non-active by definition). Exactly one active row at a time (or zero before the current week generates).

### D4 — Startup catch-up: three cases; stale `generating` → alert-once-then-`failed`, never auto-repost

On start, reconcile the current `week_key` against its row. A stale `generating` row *may or may not* have posted; we cannot tell, so we **do not auto-repost** — we alert once and set `failed` (so repeated same-week crash-restarts don't re-alert), accepting a rare manual re-run as the price of a no-duplicate guarantee.

### D5 — Rows are retained, never cleaned up

They are the historical record and the v3.0 reverse map (old `ts` → past `week_key`) that lets the listener recognize a late reply to an expired thread. SQLite is tiny; an optional prune of terminal rows older than N months is a deferred someday-nicety.

---

## Session schema

```sql
CREATE TABLE session (
  week_key     TEXT PRIMARY KEY,      -- anchor Sunday, pinned TZ, e.g. '2026-07-12'
  status       TEXT NOT NULL,         -- generating|suggested|under_revision|committed|failed|expired
  thread_ts    TEXT,                  -- Slack parent ts; NULL until the post returns (load-bearing)
  working_plan TEXT,                  -- JSON; each meal carries a nullable `day` (populated v2.0)
  turn_count   INTEGER NOT NULL DEFAULT 0,   -- per-thread turns; v3.0 turn cap (§9.3)
  token_spend  INTEGER NOT NULL DEFAULT 0,   -- cumulative tokens; cost cap (§9.3)
  cost_usd     REAL    NOT NULL DEFAULT 0,   -- derived from token_spend + per-model rates
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- v3.0 reverse lookup: inbound event's thread_ts -> which week?
CREATE INDEX idx_session_thread_ts ON session(thread_ts);
```

`thread_ts` being **nullable** is meaningful: a row with `status='generating'` and `thread_ts=NULL` is a generation that hasn't (yet, or ever) posted. The cost counters live on the session row so the §9.3 caps read/write in the same transaction as the rest of the state.

*(dev/prod: identical schema, **separate DB file per profile** so dev runs never collide with prod `week_key` rows; dev's force-regenerate bypasses the D1 gate — see design §7.)*

---

## State machine

```
                 post + local write ok        first reply (v3.0)      /mealplan-approved (v3.0)
   generating ───────────────────────► suggested ──────────► under_revision ──────────► committed
       │                                    │                     │                         ▲
       │ crash before ts / stale at startup │  next week generates, never committed         │ re-approve
       ▼                                    ▼                     ▼                         │ (soft-commit,
    failed                               expired ◄───────────────┘                         └─ re-commit)
```

| From | Trigger | To |
|------|---------|-----|
| *(none)* | idempotency gate passes → row inserted | `generating` |
| `generating` | post returns `ts` + local write commits | `suggested` |
| `generating` | crash before post, or stale row seen at startup | `failed` |
| `suggested` | first inbound thread reply (v3.0) | `under_revision` |
| `suggested` / `under_revision` | `/mealplan-approved` (v3.0) | `committed` |
| `suggested` / `under_revision` | next week generates; never committed | `expired` |
| `committed` | re-issued approval (soft-commit) | `committed` (re-commit/overwrite) |

`committed`, `failed`, `expired` are terminal (except `committed`'s soft-commit self-loop).

---

## Core logic (pseudocode)

### Current plan-week (the clock-derived anchor)

```ts
function currentPlanWeek(now, cfg): WeekKey {
  const local = toZone(now, cfg.tz);
  const sunday = mostRecentSundayOnOrBefore(local);      // today if Sunday, else last Sunday
  const trigger = at(sunday, cfg.triggerTime);           // e.g. Sunday 06:00 local
  // If this week's trigger hasn't passed yet, the active plan is still last week's.
  return (local >= trigger) ? dateKey(sunday) : dateKey(sunday.minusDays(7));
}
```

### Generation (idempotency gate + write-before-post)

```ts
function generateForWeek(wk, opts) {
  if (!opts.force && sessionExists(wk)) return SKIP;      // D1 — one gate, all double-fire sources

  expirePriorIfUncommitted(wk);                           // D-expired, piggybacked (below)
  insertSession(wk, { status: "generating", created_at: now() });   // D2 — row BEFORE post

  let ts;
  try {
    const plan = buildPlan(wk);                           // sync recipes, fan-out, LLM select (ADR 0001)
    ts = slack.postMessage(cfg.channelId, renderDraft(plan));   // ← irreversible side effect
    updateSession(wk, { status: "suggested", thread_ts: ts, working_plan: plan });  // AFTER post
  } catch (e) {
    if (ts === undefined) {                               // nothing posted → clean failure
      updateSession(wk, { status: "failed" });
      alert(`generation for ${wk} failed before posting: ${e}`);
    } else {                                              // posted but local write faltered → retry
      retry(() => updateSession(wk, { status: "suggested", thread_ts: ts, working_plan: plan }));
      // if retry still fails, the row stays `generating`; startup catch-up (D4) will resolve it.
    }
    throw e;
  }
}

// The one truly unrecoverable window: a hard kill (power loss) AFTER postMessage
// returns but BEFORE updateSession commits. Not handled here — resolved by D4 at startup.
```

### Startup catch-up (D4 — three cases)

```ts
function onStartup() {
  const wk = currentPlanWeek(now(), cfg);
  const row = getSession(wk);

  if (!row) {
    if (now() >= triggerMoment(wk, cfg)) generateForWeek(wk, { force: false });  // missed trigger → catch up
    // else: not yet time; hand off to the in-process scheduler.
  } else if (["suggested", "under_revision", "committed"].includes(row.status)) {
    resumeQuietly(row);                                   // reload working_plan + thread_ts; say nothing
  } else if (row.status === "generating") {               // died mid-flight; may or may not have posted
    alert(`week ${wk} interrupted; check #meal-plan, re-run manually if needed`);
    updateSession(wk, { status: "failed" });              // ← so repeated restarts don't re-alert
    // do NOT auto-repost; do NOT auto-generate — a human decides (force re-run or leave skipped)
  }
  // status in {failed, expired}: already resolved; no automatic action.
}
```

### Expired (piggybacked on the next generation — no timer)

```ts
function expirePriorIfUncommitted(currentWk) {
  const prior = getSession(previousPlanWeek(currentWk));      // currentWk minus 7 days
  if (prior && ["suggested", "under_revision"].includes(prior.status))
    updateSession(prior.week_key, { status: "expired" });    // clean record + explicit skip signal
  // Correctness doesn't depend on this — activeness is computed (D3) — it's for the record.
}
```

### Active-week check (v3.0 listener scoping)

```ts
function isActiveThread(inboundTs) {
  const row = getSessionByThreadTs(inboundTs);               // reverse lookup via idx_session_thread_ts
  return row && row.week_key === currentPlanWeek(now(), cfg); // stale threads → false
}
```

---

## Consequences

**Positive**
- **One idempotency gate** neutralizes every double-fire source (catch-up, timer double-fire, manual/dev re-run) with a single existence check.
- **Computed activeness** needs zero maintenance and is automatically correct across any number of skipped weeks; slash-command resolution to the active thread means an expired week *cannot* be accidentally approved (§7).
- **Mid-flight crashes are detectable and never duplicate.** The pre-post `generating` row + startup reconciliation trade a rare manual re-run for a hard no-duplicate guarantee.
- **Rows are dual-purpose:** historical record + the v3.0 `ts → week_key` reverse map for late-reply recognition.
- **Cost counters colocated** on the session row, so the §9.3 caps update transactionally with state.

**Tradeoffs / risks**
- **A hard kill in the post→commit window costs that week.** Startup sees a stale `generating` row, alerts, marks `failed`, and stops — the operator must re-run manually. Accepted: no-duplicates > never-miss for a family draft.
- **`failed` is a human-attention state by design** — the daemon will not self-heal it, to avoid the orphaned-post risk.
- **`expired` is cosmetic** (computed activeness is already correct); it's redundant-but-cheap bookkeeping for a clean record.
- **Config dependency:** `week_key` correctness hinges on the pinned timezone + trigger time. A wrong or unset TZ silently mis-keys weeks. Must be explicit config, validated at boot.

---

## Alternatives considered

- **Stored `is_active`/`current` flag** — rejected. Needs a deactivation job, drifts on skips, and is exactly the fragility D3's computed property avoids.
- **Post-then-write (no pre-post `generating` row)** — rejected. A crash between post and write orphans a Slack thread with no local record; the next catch-up regenerates → duplicate. The pre-post row is what makes the crash observable.
- **Auto-repost on a stale `generating` row** — rejected. Risks a duplicate when the prior attempt *did* post. Alert + manual re-run is the safe resolution.
- **Timer/cron to expire stale rows** — rejected. Piggybacking expiry on the next generation needs no extra scheduler.
- **Deleting/pruning old rows eagerly** — rejected for v1.0. Retention powers v3.0 late-reply recognition; SQLite is tiny.
- **ISO year-week as `week_key`** — viable; Sunday-date preferred to dodge ISO Monday/Sunday boundary confusion.

---

## Open items (non-blocking for v1.0)

- **Pin timezone + trigger time in config**, and validate at boot (load-bearing for `week_key`).
- **`week_key` format** — Sunday-date (recommended) vs ISO year-week; pick at build.
- **Operator re-run affordance** when a week goes `failed` — a `--force` regenerate, or delete-the-row, or a small "re-run week W" command. Define the mechanism.
- **v3.0 late-reply-to-expired-thread UX** — ignore (strict) vs one-time redirect; deferred (design §8).
- **Retention/prune policy** for terminal rows older than N months — someday-nicety.
