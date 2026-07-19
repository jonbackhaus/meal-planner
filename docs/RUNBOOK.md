# Go-Live Runbook — Meal Planner v1.0

How to take the daemon from "code-complete on `main`" to "posting a weekly draft
in Slack." Everything here is **ops** — the runtime code is done; these are the
external accounts, secrets, env vars, and the launch/verify sequence.

> **Read this first — populate the recipe index once.** The daemon auto-syncs
> from Apple Notes before each real generation (`q95.8`, merged), but on a fresh
> machine the recipe index (`./data/*.sqlite`) starts empty. Run **`pnpm sync`**
> once up front (see [§6](#6-populate-the-recipe-index)) so the very first plan
> has a corpus to select from — the initial embed also downloads the local model
> and can take a minute. After that, the weekly run keeps the index fresh on its
> own.

---

## 0. Prerequisites

- The **family Mac** that will host the daemon (must stay awake — see [§7](#7-keep-the-mac-awake-launchd)).
- **Node ≥ 22** and **pnpm** (`packageManager` pins `pnpm@11.11.0`).
- Apple Notes on that Mac containing the recipe corpus (the Recipe MCP reads
  local Notes via `osascript`/JXA — this is why the daemon is local, not cloud).
- Admin access to your **Slack workspace** (to install an app).
- An **Anthropic** account you can create an API workspace/key in.
- Decide your secret-storage path: **1Password service account** (recommended)
  or a **chmod-600 env file** (simpler). Both are supported by `loadSecrets`.

```bash
pnpm install
pnpm build          # tsc -> dist/
pnpm test           # sanity: full suite green
```

---

## 1. Create the Slack app + channels  · `bd bj1.1`

1. Create three channels in your workspace:
   - `#meal-plan` — the **prod** draft target.
   - `#dev-meal-plan` — the **dev** draft target (isolated from prod).
   - `#agent-alerts` — operational alerts (failures, cost caps, stale rows).
2. Create a Slack app (<https://api.slack.com/apps> → *From scratch*), pick the
   workspace.
3. **OAuth & Permissions → Bot Token Scopes:** add **`chat:write`**. That is the
   only scope v1.0 needs — it is outbound-only via the Web API. Do **not** enable
   Socket Mode or add an app-level (`xapp-…`) token; those are a v3.0 concern.
4. **Install to Workspace.** Copy the **Bot User OAuth Token** (`xoxb-…`).
5. **Invite the bot** to all three channels: `/invite @your-app` in each. The bot
   can only post to channels it's a member of.
6. Grab each channel's **ID** (not its name): open the channel → channel name →
   *About* → copy the `C0…` ID at the bottom. The daemon **requires channel IDs**
   and rejects `#name`-style values by design (a name lookup could silently
   resolve a dev run into the prod channel).

You now have: `xoxb-…` token, and three `C0…` channel IDs.

---

## 2. Create the Anthropic API workspace + key  · `bd fkg.4`

1. In the Anthropic Console, create a dedicated **API workspace** for this bot
   (isolates spend and lets you scope a key).
2. Create an **API key** in that workspace. Copy the `sk-ant-…` value.
3. Set a **low spend alert** on the workspace (Anthropic offers alerts, not
   enforced per-key cutoffs — the *hard* dollar cap is enforced in our code via
   `generationDollarCap`; the console alert is your backstop). Start low, e.g.
   \$5–10/mo; the weekly cron is cheap and the real runaway risk (a v3.0 revision
   loop) doesn't exist yet in v1.0.

Model/pricing note (`docs/SPEC.md` §9.3): default model is `claude-sonnet-5` at
`medium` effort. `modelRates` in `src/config/config.ts` seeds Sonnet-5 pricing
for cost accounting; edit that map if pricing changes.

---

## 3. Store the two secrets

v1.0 loads exactly two secrets: the **Slack bot token** and the **Anthropic API
key** (`src/secrets/secrets.ts`). Pick one source — `loadSecrets` auto-detects
**1Password** when `OP_SERVICE_ACCOUNT_TOKEN` is present, otherwise falls back to
**env**.

### Option A — 1Password (recommended)

1. Use a **dedicated vault** (`Meal-Planner`) holding one item per secret, each
   with a `credential` field: `anthropic-api` (the `sk-ant-…` key) and
   `slack-app` (the `xoxb-…` token). A dedicated vault keeps these isolated from
   unrelated secrets and lets the service account be scoped to exactly them.
2. Create a **service account** with **read-only** access to **only** the
   `Meal-Planner` vault (least privilege); copy its token (shown once).
3. Set these env vars for the daemon (the `op` CLI must be installed and on
   `PATH`):

   ```bash
   export OP_SERVICE_ACCOUNT_TOKEN="ops_…"
   export MP_OP_SLACK_TOKEN_REF="op://Meal-Planner/slack-app/credential"
   export MP_OP_ANTHROPIC_KEY_REF="op://Meal-Planner/anthropic-api/credential"
   ```

   Verify the refs resolve without printing the secrets:
   `op read "$MP_OP_ANTHROPIC_KEY_REF" >/dev/null && echo ok`. To rotate the
   service account, issue the new token and confirm `op read` works **before**
   revoking the old one.

   > If `OP_CONNECT_HOST` / `OP_CONNECT_TOKEN` are set in the environment, the
   > loader strips them from the `op` child env on purpose — Connect vars
   > outrank the service-account token and would misdirect auth. You don't need
   > them; just be aware.

Boot loads secrets with a **15s timeout** — a hung `op` CLI fails boot loudly
rather than hanging forever.

### Option B — env file (simpler)

Put the raw values in a **chmod-600** file that only the daemon user can read,
and export them before launch:

```bash
export MP_SLACK_BOT_TOKEN="xoxb-…"
export MP_ANTHROPIC_API_KEY="sk-ant-…"
```

Either way, the daemon wires the Anthropic key into `process.env.ANTHROPIC_API_KEY`
itself (the Agent SDK reads it there). **Never** commit either secret; keep them
out of logs (the code is careful never to echo secret values).

### Rotating the secrets

Secrets are loaded **once at boot** — `loadSecrets()` runs during startup and the
Anthropic key is wired into `process.env.ANTHROPIC_API_KEY` at that point
(`src/secrets/secrets.ts` + the boot wiring in `src/index.ts`). The running
daemon holds them in memory and **never re-reads them**, so a rotated secret is
**not picked up until the daemon restarts**. Rotate in this order so the daemon
is never running against a revoked credential:

**Slack bot token (`xoxb-…`)**

1. In the Slack app (**OAuth & Permissions**), rotate/reinstall to mint a new
   Bot User OAuth Token. (If the old one is compromised, you can revoke after
   step 3; otherwise leave it valid until then.)
2. **Update the value in your secret store** — the 1Password `slack-app` item's
   `credential` field (Option A), or `MP_SLACK_BOT_TOKEN` in the env file /
   plist `EnvironmentVariables` (Option B). The `op://` ref does not change.
3. **Restart the daemon** so it reloads the new token:
   `launchctl unload … && launchctl load ~/Library/LaunchAgents/com.backhaus.meal-planner.plist`
   (see §7).
4. **Verify with a dev dry-run** before trusting prod — relaunch once in
   dev + dry-run (§5, `MP_PROFILE=dev MP_POST_MODE=dry-run MP_FIRE_ON_START=1`),
   or a dev live post, and confirm it posts / renders with no auth error. Then
   revoke the old token in Slack.

**Anthropic API key (`sk-ant-…`)**

1. In the Anthropic Console (the dedicated workspace, §2), create a **new** API
   key; keep the old one active until step 4.
2. **Update the value in your secret store** — the 1Password `anthropic-api`
   item's `credential` field, or `MP_ANTHROPIC_API_KEY` (env/plist). The `op://`
   ref does not change.
3. **Restart the daemon** (as above) so it reloads and re-wires
   `process.env.ANTHROPIC_API_KEY`.
4. **Verify with a dev dry-run** — a dev + dry-run fire still calls the Agent
   SDK, so a bad key fails loudly there without touching prod spend. Once the
   run succeeds, **revoke the old key** in the console.

> Rotating the **1Password service-account token** itself (not the secrets it
> guards) is different: issue the new token and confirm `op read` works
> **before** revoking the old one (see Option A above), then update
> `OP_SERVICE_ACCOUNT_TOKEN` and restart the daemon.

---

## 4. Configuration — environment variables

All config is read from `MP_`-namespaced env vars at boot
(`src/config/config.ts`, `src/config/profile.ts`, `src/index.ts`). **Required**
vars have no default and fail boot loudly if missing.

### Required

| Var | Meaning | Example |
|-----|---------|---------|
| `MP_TIMEZONE` | IANA zone that pins the week boundary + trigger | `America/Chicago` |
| `MP_TRIGGER_TIME` | 24h `HH:MM` weekly fire time | `06:00` |
| `MP_CHANNEL_ID_PROD` | prod `#meal-plan` channel **ID** | `C0ABC123` |
| `MP_CHANNEL_ID_DEV` | dev `#dev-meal-plan` channel **ID** | `C0DEF456` |
| `MP_ALERTS_CHANNEL_ID` | `#agent-alerts` channel **ID** (see note) | `C0GHI789` |

> `MP_ALERTS_CHANNEL_ID` is only *required in practice* when `postMode === "post"`.
> If it's unset while posting, the daemon **warns and falls back to local-log-only
> alerts** (it will not crash) — but you'd miss Slack alerts, so set it for prod.
> Both `MP_CHANNEL_ID_DEV` and `MP_CHANNEL_ID_PROD` are validated even though only
> the active profile's channel is used, and dev/prod SQLite paths must differ.

### Profile + behavior

| Var | Default | Meaning |
|-----|---------|---------|
| `MP_PROFILE` | `prod` | `dev` or `prod` — bundles channel, DB path, force, post mode |
| `MP_POST_MODE` | `post` | `post` (real Slack) or `dry-run` (render + log only) |
| `MP_FORCE_REGENERATE` | dev=`true`, prod=`false` | bypass the week-keyed idempotency guard |
| `MP_SQLITE_PATH_PROD` | `./data/meal-planner.prod.sqlite` | prod session DB |
| `MP_SQLITE_PATH_DEV` | `./data/meal-planner.dev.sqlite` | dev session DB (must differ from prod) |
| `MP_FIRE_ON_START` | unset | set to `1` to fire one trigger immediately at boot (test-fire) |
| `MP_LOG_PATH` | `./data/meal-planner.log` | durable local alert log |
| `MP_RECIPES_FOLDER` | `Food` | food-only Apple Notes folder the sync reads from (never a smart folder that also aggregates Drinks) |
| `MP_HOUSEHOLD` | built-in default | household prose for the planner (see note) |
| `MP_HEALTHCHECK_URL` | unset (disabled) | external dead-man-switch ping URL (see §11) |

> **`MP_HOUSEHOLD`**: the built-in default already encodes the hard constraint
> (a vegetarian daughter — every dinner must be vegetarian, cleanly separable,
> or paired with a veg dish). Override it to add the rest of your household's
> real prose (picky eaters, other dietary notes). Whatever you set, keep the
> vegetarian constraint in the text.

### Planner tuning (validated against the real corpus)

| Var | Default | Decision |
|-----|---------|----------|
| `MP_COOK_NIGHTS_CONSTRAINED` / `MP_COOK_NIGHTS_RELAXED` | `4` / `2` | slot counts |
| `MP_ACTIVE_MAX_MINUTES` | `60` | hard active-time gate; its fail-closed `confidence` threshold ratified at `0.5` — `bd b7n` |
| `MP_FANOUT_MULTIPLIER` | `4` | candidate pool size |
| `MP_VEG_FLOOR_K` | `2` | veg-satisfiable floor — validated as-is, `bd kd5` |
| `MP_UNTESTED_RATE` | `0.15` | untested-recipe injection rate — validated as-is, `bd kd5` |
| `MP_GENERATION_DOLLAR_CAP` | `2` | **hard** per-run \$ cap; exceeding it fails the run + alerts |

`bd b7n`, `bd kd5`, `bd l7x` are now **ratified** against the real 764-recipe
corpus (`bd q95.6` / `8zs.6`):

- **b7n** — `active_max` `confidence` threshold ratified at **`0.5`** (commit
  6b1d73d); 0.5 sits just above the low-confidence danger cluster (keeps 547
  weeknight-eligible recipes).
- **l7x** — seed-query strategy ratified as **category-seeded multi-query**
  (6 category seeds, quality-aware; commit e10eb31), replacing the single
  generic seed that under-recalled.
- **kd5** — `vegFloorK` / `untestedRate` **validated as-is** once retrieval
  became quality-aware + multi-seed (commit e10eb31).

---

## 5. First run — always dev + dry-run first

Verify the whole pipeline **without** touching the prod channel or Anthropic
spend surprises. Start in dev, dry-run, fire-on-start:

```bash
export MP_PROFILE=dev
export MP_POST_MODE=dry-run
export MP_FIRE_ON_START=1
export MP_TIMEZONE="America/Chicago"
export MP_TRIGGER_TIME="06:00"
export MP_CHANNEL_ID_DEV="C0DEF456"
export MP_CHANNEL_ID_PROD="C0ABC123"     # validated even in dev
# …secrets from §3…

pnpm dev        # tsx watch src/index.ts   (or: node dist/index.js after `pnpm build`)
```

Expected: the daemon logs `meal-planner daemon starting…`, warns if system sleep
isn't disabled, runs startup catch-up, then (because `MP_FIRE_ON_START=1`) fires
one trigger and prints a **`[DRY-RUN post] channel=… ts=dryrun-1`** block with the
fully rendered plan. Nothing is sent to Slack; a synthetic `ts` is used.

**If the plan is empty / thin:** the recipe index probably isn't populated yet — run [§6 `pnpm sync`](#6-populate-the-recipe-index) first; it's not a bug in the planner.

Then promote to a **dev live post** (real Slack, dev channel) to confirm the bot
token + channel membership work end-to-end:

```bash
export MP_POST_MODE=post
export MP_ALERTS_CHANNEL_ID="C0GHI789"
pnpm dev
```

You should see a real message in `#dev-meal-plan` and `[Slack post] channel=… ts=…`
in the logs.

---

## 6. Populate the recipe index

The daemon auto-syncs before each real generation, but populate the index once
up front so the first plan isn't empty:

```bash
# secrets + config from §3–§4 must be in the environment (loadConfig + loadSecrets run)
pnpm sync            # one pass: read Apple Notes -> embed -> extract; prints total/processed/skipped + $ spend
```

- File your recipe notes under the Apple Notes folder named by
  `MP_RECIPES_FOLDER` (default `Food`); anything else is ignored. Point this at
  the food-only folder, **not** a smart folder that aggregates other courses
  (e.g. a `Recipes` smart folder pulling in a `Drinks` subfolder) — beverages
  are untagged, pass the dinner gate, and get planned as meals.
- The first run downloads the local embedding model
  (`Xenova/all-MiniLM-L6-v2` — needs network + a minute); extraction is
  hash-gated, so re-runs are cheap.
- `pnpm sync` writes the **same** index the daemon reads and posts nothing to
  Slack — safe to run any time to refresh.

Confirm afterwards that `./data/*.sqlite` exists and has rows before trusting a
real plan. Thereafter the weekly run keeps it fresh; a whole-sync failure during
a weekly run is non-fatal (proceed + alert to `#agent-alerts`).

---

## 7. Keep the Mac awake (launchd)

The weekly trigger is an **in-process scheduler**, not a launchd calendar job —
so the process must be **resident and the Mac awake**. launchd's role is only
boot-launch + restart-on-crash.

1. **Disable sleep** (daemon warns via `pmset -g` at boot if it can't confirm this):
   ```bash
   sudo pmset -a sleep 0 disablesleep 1     # or configure "prevent sleep" appropriately
   ```
2. **Install the committed LaunchAgent plist** — a template is checked in at
   `deploy/launchd/com.backhaus.meal-planner.plist` (with a step-by-step
   `deploy/launchd/README.md`). Copy it out of git and adapt the machine-local
   copy; do **not** hand-author your own or edit real values into the tracked
   file:
   ```bash
   cp -f deploy/launchd/com.backhaus.meal-planner.plist \
     ~/Library/LaunchAgents/com.backhaus.meal-planner.plist
   ```
   Then edit the copy in `~/Library/LaunchAgents/`:
   - Replace `/Users/YOUR_USERNAME/meal-planner` with the real absolute checkout
     path (used by `ProgramArguments`, `WorkingDirectory`, `StandardOutPath`,
     `StandardErrorPath`) and `pnpm build` first so `dist/index.js` exists.
   - Replace `/usr/local/bin/node` with the output of `which node` if different
     (launchd does not use your shell `PATH`).
   - Fill in real secret/config values under `EnvironmentVariables` (or set
     `OP_SERVICE_ACCOUNT_TOKEN` and rely on the 1Password source — see §3).
     **Never commit the filled-in copy back to git.**
   - `mkdir -p logs` so the `StandardOutPath`/`StandardErrorPath` files can be
     created.

   The committed plist already fixes the invariant bits: `RunAtLoad` +
   `KeepAlive` (boot-launch + restart-on-crash) and **no**
   `StartCalendarInterval` — the weekly timing is owned in-process, never by
   launchd.
3. Load it: `launchctl load ~/Library/LaunchAgents/com.backhaus.meal-planner.plist`
   (verify with `launchctl list | grep com.backhaus.meal-planner`).

**Crash-safety you get for free:** the orchestrator writes the session row at
`generating` *before* posting, so a mid-flight crash is detectable. On restart,
startup catch-up handles three cases — live row → skip; past trigger with no row →
generate; stale `generating` row → **alert once, mark failed, never auto-repost**
(a rare manual re-run is accepted to guarantee no duplicate posts). Use the
operator re-run affordance (`src/orchestrator/rerun.ts`, `--force` for non-failed
rows) if you ever need to regenerate a week by hand.

---

## 8. Go to prod

Once dev-live looks right and the index is populated:

```bash
export MP_PROFILE=prod
export MP_POST_MODE=post
unset  MP_FIRE_ON_START          # let the weekly schedule drive it
export MP_CHANNEL_ID_PROD="C0ABC123"
export MP_ALERTS_CHANNEL_ID="C0GHI789"
# prod defaults: forceRegenerate=false (idempotency guard ON)
```

Load via launchd (§7). The daemon will:
`boot → startup catch-up → wait for the weekly trigger → sync recipes →
compose pools → LLM select → validate + repair → enrich → post the draft to
#meal-plan → track/hard-cap cost → alert #agent-alerts + local log on anomalies.`

**First prod week:** watch `#agent-alerts` and the local log
(`./data/meal-planner.log`) around `MP_TRIGGER_TIME` on the first Sunday. You can
also do one controlled real test-fire by launching once with `MP_FIRE_ON_START=1`
in prod, confirming the post, then relaunching without it.

---

## 9. Post-launch checklist

- [ ] `#meal-plan` received a sensible draft at the scheduled time.
- [ ] `#agent-alerts` is quiet on a healthy run (alerts fire only on real anomalies —
      no heartbeat, no "skipping this week" chatter by design).
- [ ] `./data/meal-planner.prod.sqlite` has a session row for the week
      (`suggested`, with `thread_ts`, `working_plan`, `token_spend`, `cost_usd`).
- [ ] Anthropic spend for the run is well under `MP_GENERATION_DOLLAR_CAP`.
- [ ] The Mac stayed awake across the weekend (no sleep warning in logs).

---

## 10. Session-DB backups  · `bd bd6.13`

The **session DB** (`./data/meal-planner.{prod,dev}.sqlite`) is the permanent
historical record and the v3.0 `thread_ts → week_key` reverse map — rows are
**retained, never cleaned up** (ADR 0002). Losing it is the SPEC's "deaf bot"
failure, so the daemon backs it up automatically. Backups use better-sqlite3's
online **`.backup()`** (a WAL-consistent snapshot) — **not** a filesystem `cp`,
which can copy a torn DB mid-write. Copies land in **`./data/backups/`** (git-
ignored) as `session-<timestamp>.sqlite`.

Two triggers:

- **Rolling boot copy** — taken at every daemon boot, **before** the schema
  migration runner touches the DB. **Best-effort:** a backup failure is logged
  and boot continues (a backup problem must never keep the daemon down).
  Retention: the **last 8** boot copies are kept; older ones are pruned.
- **Pre-migration copy** — a mandatory snapshot (`…-premigration.sqlite`, kept
  indefinitely, never pruned) taken right before a real schema migration
  applies. If it fails, boot **aborts before migrating** rather than run a
  destructive change with no snapshot. v1.0 ships **zero** real migrations (the
  only schema step is the non-destructive baseline `user_version = 1` stamp), so
  this branch is dormant until the first additive migration (v2.0 `day`); the
  rolling boot copy already covers the baseline stamp.

Schema versioning is `PRAGMA user_version` with a forward-only runner
(`src/orchestrator/migrations.ts`); the current schema is **baseline v1**.

> **The recipe index is NOT auto-backed-up here** — it is fully regenerable
> with **`pnpm sync`** (re-reads Apple Notes → re-embeds → re-extracts), so it
> needs only the ad-hoc `.bak` it already has. Only the session DB holds
> irreplaceable state.

**Restore** (rare — e.g. disk corruption): stop the daemon, copy the chosen
`./data/backups/session-<timestamp>.sqlite` back over the live
`./data/meal-planner.<profile>.sqlite` (remove any stale `-wal`/`-shm`
sidecars), then relaunch.

---

## 11. External dead-man switch  · `bd fkg.8`

**The risk:** the daemon's own alert channel lives *inside* the process that
might die. If launchd stops relaunching, the Mac sleeps (an OS update reverting
`pmset`), or a secret expires at boot, the daemon can be down for **weeks** with
no post and no alert — startup catch-up only helps if the process actually
starts. SPEC §9.4 deliberately keeps heartbeats *out* of `#agent-alerts`; the
fix is a watcher that lives **outside** the daemon's failure domain.

The daemon supports a **healthchecks.io-style dead-man ping**: on each genuine
weekly trigger it pings a check URL, and the external service alerts *you*
(email/SMS) when a ping is **missed**. It is **best-effort and never blocks a
run** (short timeout, all errors swallowed), and **disabled by default** — until
you set `MP_HEALTHCHECK_URL` the daemon behaves exactly as before.

**Setup (one-time):**

1. Create a free check at [healthchecks.io](https://healthchecks.io) (or any
   compatible service): **period = 1 week**, plus a grace window (a day or two)
   to cover the trigger time and a slow run. Configure its notification
   (email/SMS/etc.) on the service side.
2. Copy the check's ping URL and set it as a secret-ish env var (the URL path is
   effectively a token — the daemon never logs it):
   ```bash
   export MP_HEALTHCHECK_URL="https://hc-ping.com/<your-uuid>"
   ```
   Add it to the launchd plist `EnvironmentVariables` (or your env file) the
   same way as the other `MP_*` vars, then restart the daemon.
3. Verify: a dev + dry-run test-fire (`MP_FIRE_ON_START=1`, §5) will send one
   success ping — confirm the check flips to "up" on the service dashboard.

On a **successful** run the base URL is pinged ("host alive, trigger fired");
on a **caught generation failure** the daemon also POSTs `<url>/fail`, so a
failed-but-alive run surfaces externally too, independent of the internal
`#agent-alerts` alert. A *silent* death (no ping at all) is exactly what the
service's missed-ping alert catches.

---

## Reference — where things live

| Concern | File |
|---------|------|
| Boot / composition root | `src/index.ts`, `src/orchestrator/compose.ts` |
| Config env vars | `src/config/config.ts` |
| dev/prod profile bundle | `src/config/profile.ts` |
| Secret loading (1Password / env) | `src/secrets/secrets.ts` |
| Daemon lifecycle + sleep check | `src/daemon/daemon.ts`, `src/daemon/system-check.ts` |
| Weekly scheduler | `src/daemon/scheduler.ts` |
| State machine / catch-up / re-run | `src/orchestrator/{generate,startup,resume,rerun}.ts` |
| Session-DB backup + schema migrations | `src/orchestrator/{backup,boot-backup,migrations}.ts` |
| Planner pipeline | `src/planner/build-plan.ts` |
| Recipe sync + wiring | `src/recipe-mcp/{sync,sync-runner}.ts`, `src/sync-cli.ts` |
| Slack post + alerts | `src/slack/{slack-poster,slack-alerter,render}.ts` |
| Cost cap | `src/cost/{cost-meter,metered-llm-client}.ts` |

Authoritative design: `docs/SPEC.md` (§7 profiles, §9 ops) and
`docs/adr-000{1,2,3}-*.md`.
