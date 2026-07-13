# Go-Live Runbook — Meal Planner v1.0

How to take the daemon from "code-complete on `main`" to "posting a weekly draft
in Slack." Everything here is **ops** — the runtime code is done; these are the
external accounts, secrets, env vars, and the launch/verify sequence.

> **Read this first — one known code gap.** The daemon does **not** yet sync
> recipes from Apple Notes before planning (`syncNotes` has no wired caller —
> tracked in `meal-planner-q95.8`). On a fresh machine the recipe index
> (`./data/*.sqlite`) is empty, so the planner has nothing to select from. Until
> `q95.8` lands you must **populate the index manually once** (see
> [§6](#6-populate-the-recipe-index-known-gap)) before the first real plan will
> be any good. The daemon will still boot, schedule, and post without it — it
> just posts against an empty/stale corpus.

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

1. Store both secrets as items/fields in a vault (e.g. an item `meal-planner`
   with fields `slack-bot-token` and `anthropic-api-key`).
2. Create a **service account** with read access to that vault; copy its token.
3. Set these env vars for the daemon (the `op` CLI must be installed and on
   `PATH`):

   ```bash
   export OP_SERVICE_ACCOUNT_TOKEN="ops_…"
   export MP_OP_SLACK_TOKEN_REF="op://Vault/meal-planner/slack-bot-token"
   export MP_OP_ANTHROPIC_KEY_REF="op://Vault/meal-planner/anthropic-api-key"
   ```

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
| `MP_HOUSEHOLD` | built-in default | household prose for the planner (see note) |

> **`MP_HOUSEHOLD`**: the built-in default already encodes the hard constraint
> (a vegetarian daughter — every dinner must be vegetarian, cleanly separable,
> or paired with a veg dish). Override it to add the rest of your household's
> real prose (picky eaters, other dietary notes). Whatever you set, keep the
> vegetarian constraint in the text.

### Planner tuning (defaults are placeholders — open decisions)

| Var | Default | Decision |
|-----|---------|----------|
| `MP_COOK_NIGHTS_CONSTRAINED` / `MP_COOK_NIGHTS_RELAXED` | `4` / `2` | slot counts |
| `MP_ACTIVE_MAX_MINUTES` | `60` | hard active-time filter — see `bd b7n` |
| `MP_FANOUT_MULTIPLIER` | `4` | candidate pool size |
| `MP_VEG_FLOOR_K` | `2` | veg-satisfiable floor — see `bd kd5` |
| `MP_UNTESTED_RATE` | `0.15` | untested-recipe injection rate — see `bd kd5` |
| `MP_GENERATION_DOLLAR_CAP` | `2` | **hard** per-run \$ cap; exceeding it fails the run + alerts |

`bd b7n`, `bd kd5`, `bd l7x` are **open decisions** deliberately deferred until we
can tune against your real corpus (`bd q95.6` / `8zs.6`). The defaults are safe
placeholders — run with them, then revisit.

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

**If the plan is empty / thin:** that's the [§6 recipe-index gap](#6-populate-the-recipe-index-known-gap), not a bug in the planner.

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

## 6. Populate the recipe index (known gap)  · `bd q95.8`

Until `q95.8` wires `syncNotes` into the daemon, the recipe index is never
populated automatically. Two ways to handle it:

- **Preferred:** implement/land `q95.8` (wire `syncNotes` into `onTrigger`, or add
  a `pnpm sync` entrypoint), then a normal run populates and refreshes the index.
- **Stopgap for a first live run:** run a one-off sync harness that builds
  `SyncDeps` (real `notes-reader` `readNotes`, `TransformersEmbedder`,
  `VectorStore` as the `SyncStore`, `StructuredStore`, and a metered `llm`) and
  calls `syncNotes(...)` once against the same `./data/*.sqlite` path the daemon
  uses. The embedder downloads the `Xenova/all-MiniLM-L6-v2` model on first run
  (needs network + a minute); extraction is hash-gated so re-runs are cheap.

Confirm afterwards that `./data/meal-planner.<profile>.sqlite` exists and has
rows before trusting a real plan.

---

## 7. Keep the Mac awake (launchd)

The weekly trigger is an **in-process scheduler**, not a launchd calendar job —
so the process must be **resident and the Mac awake**. launchd's role is only
boot-launch + restart-on-crash.

1. **Disable sleep** (daemon warns via `pmset -g` at boot if it can't confirm this):
   ```bash
   sudo pmset -a sleep 0 disablesleep 1     # or configure "prevent sleep" appropriately
   ```
2. Create a **LaunchAgent** plist (e.g. `~/Library/LaunchAgents/com.jonbackhaus.meal-planner.plist`)
   with:
   - `ProgramArguments` → `node /path/to/meal-planner/dist/index.js` (build first).
   - `RunAtLoad` → `true` (boot-launch).
   - `KeepAlive` → `true` (restart on crash — **not** a calendar `StartCalendarInterval`;
     the weekly timing is owned in-process).
   - `EnvironmentVariables` → all the `MP_*` / secret vars from §3–§4 (or have the
     plist source them; do **not** inline raw secret values into a world-readable plist —
     prefer the 1Password service-account path).
   - `StandardOutPath` / `StandardErrorPath` → a log file for the daemon's stdout.
3. Load it: `launchctl load ~/Library/LaunchAgents/com.jonbackhaus.meal-planner.plist`.

> There is no plist checked into the repo yet — author it per the above. (Worth a
> follow-up bd task if you want it templated/committed.)

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
`boot → startup catch-up → wait for the weekly trigger → (sync, once q95.8) →
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
| Planner pipeline | `src/planner/build-plan.ts` |
| Recipe sync (⚠ unwired — `q95.8`) | `src/recipe-mcp/sync.ts` |
| Slack post + alerts | `src/slack/{slack-poster,slack-alerter,render}.ts` |
| Cost cap | `src/cost/{cost-meter,metered-llm-client}.ts` |

Authoritative design: `docs/SPEC.md` (§7 profiles, §9 ops) and
`docs/adr-000{1,2,3}-*.md`.
