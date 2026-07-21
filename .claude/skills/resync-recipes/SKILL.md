---
name: resync-recipes
description: Run a full out-of-band recipe re-sync (pnpm sync) that rebuilds the whole index — needed after a note-reader or hash change invalidates it. Use when the user wants to backfill/re-embed the recipe corpus, re-run sync after changing the NoteStore reader or extraction logic, or fix a stale/empty recipe index. Encodes the raised cost cap and the macOS sleep-kill watchdog this one-off run requires.
---

# Re-sync the recipe index (full backfill)

Rebuild the whole recipe index from Apple Notes via `pnpm sync`. Extraction is
hash-gated, so **normal** re-runs are cheap and need none of this ceremony. This
skill is for the **expensive** case: a change to the NoteStore reader, the note
hash, or the extraction logic invalidates the index, so `pnpm sync` re-processes
the *entire* corpus and blows past the default `$2` cap.

## When to use

- After changing the note reader / hash / extraction pass (index invalidated).
- The index is stale or empty and needs a full rebuild.
- The user says "re-sync recipes", "backfill the corpus", "re-embed everything".

Do **not** use for a routine refresh — a plain `pnpm sync` (which the daemon
also runs before each generation) is enough when the hash is unchanged.

## Why the default cap is wrong here

`MP_GENERATION_DOLLAR_CAP` defaults to `2` (RUNBOOK §4). A full re-embed of the
~760-recipe corpus costs more than that and would **fail the run + alert**. Raise
the cap for this one out-of-band run only — don't change the committed default,
which protects the weekly cron. A prior full sync ran ~$2.64 / 122 changed
recipes; budget generously and watch the printed `$ spend`.

## Steps

1. **Confirm it's really a full re-sync** (hash-invalidating change), not a
   routine refresh. If routine, just run `pnpm sync` and stop.

2. **Run under a sleep-kill watchdog** — macOS has no `timeout`, and a bad Notes
   read can hang. `pnpm sync` auto-loads `.env` (via `--env-file-if-exists`), so
   secrets/config come from there; the inline cap override wins over the file
   value (Node's `--env-file` yields to the ambient environment):

   ```bash
   # From the repo checkout. Bump the cap to comfortably exceed the expected spend.
   MP_GENERATION_DOLLAR_CAP=20 pnpm sync & p=$!; (sleep 1800; kill -9 $p) & w=$!; wait $p; kill "$w" 2>/dev/null
   ```

   `pnpm sync` prints `total / processed / skipped + $ spend` and posts nothing
   to Slack — safe to run any time.

3. **Verify** the index is current afterward:

   ```bash
   ls -la ./data/*.sqlite            # exists + recently modified
   # processed count should reflect the whole corpus; skipped ~0 on a full rebuild
   ```

   If it read **0 notes** while the index holds recipes, that's a likely
   TCC/permission loss, not an empty corpus — re-grant Full Disk Access +
   Automation→Notes to the `node`/terminal binary (RUNBOOK §0.1/§0.2) and re-run.

## References

- `docs/RUNBOOK.md` §6 (populate the recipe index) and §4 (`MP_GENERATION_DOLLAR_CAP`).
- Bead `a9e` — inline-sync budget guard (the daemon's pre-generation sync should
  not inherit this raised cap).
