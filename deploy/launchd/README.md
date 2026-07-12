# launchd install (meal-planner daemon)

This plist is boot-launch + keep-alive plumbing ONLY. It does **not** schedule
the weekly meal plan — that's owned entirely by the in-process `Scheduler`
running inside the resident Node process (`src/daemon/scheduler.ts`), which
fires at the Sunday `MP_TRIGGER_TIME` slot in `MP_TIMEZONE`, DST-correct.
There is deliberately no `StartCalendarInterval` here; if you find yourself
wanting to add one, that's a sign the schedule is about to be owned in two
places at once — don't.

## Prerequisites

- `pnpm build` has been run at least once (`dist/index.js` exists).
- The Mac this runs on does not sleep (see the sleep check below) — the
  scheduler only fires while the process is actually running.

## Install

1. Copy the plist out of git and fill in real values — **do not** edit and
   commit real secrets/paths into the tracked copy in this repo:
   ```bash
   cp deploy/launchd/com.backhaus.meal-planner.plist \
     ~/Library/LaunchAgents/com.backhaus.meal-planner.plist
   ```
2. Edit the copy in `~/Library/LaunchAgents/`:
   - Replace `/Users/YOUR_USERNAME/meal-planner` with the actual absolute
     checkout path (used in `ProgramArguments`, `WorkingDirectory`,
     `StandardOutPath`, `StandardErrorPath`).
   - Replace `/usr/local/bin/node` with the output of `which node` if
     different (launchd does not use your shell's `PATH`).
   - Fill in real secret values under `EnvironmentVariables` (or set
     `OP_SERVICE_ACCOUNT_TOKEN` and rely on the 1Password source — see
     `src/secrets/secrets.ts`). Never commit this filled-in copy back into
     git.
   - Ensure `logs/` exists (`mkdir -p logs`) so the `StandardOutPath` /
     `StandardErrorPath` files can be created.
3. Load it:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.backhaus.meal-planner.plist
   ```
4. Verify it's running:
   ```bash
   launchctl list | grep com.backhaus.meal-planner
   tail -f logs/meal-planner.out.log
   ```

## Uninstall / reload after changes

```bash
launchctl unload ~/Library/LaunchAgents/com.backhaus.meal-planner.plist
# ...make changes to the plist or rebuild...
launchctl load ~/Library/LaunchAgents/com.backhaus.meal-planner.plist
```

## Sleep check (SPEC §9.4)

The scheduler only fires while the process is running, so this Mac must
never sleep. Confirm before (and periodically after) install:

```bash
pmset -g | grep -E '^\s*sleep\s'
```

`sleep` should read `0` (disabled). If it's nonzero, disable sleep in
System Settings > Energy Saver/Battery, or via:

```bash
sudo pmset -a sleep 0
```

The daemon itself also runs this check at boot (`checkSystemSleepDisabled`
in `src/daemon/system-check.ts`) and logs a WARNING (not a crash) to
`StandardErrorPath` if sleep is not confirmed disabled — check the logs
after install.

## Test-firing the scheduler once

Rather than waiting for the next real Sunday trigger, the daemon supports a
test-fire affordance (`runDaemon({ fireOnStart: true })` / the returned
handle's `triggerNow()`) to invoke the trigger hook once immediately. Use
this after install to confirm end-to-end wiring works before trusting the
weekly schedule.
