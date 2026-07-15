import { describe, expect, it, vi } from "vitest";
import type { SyncResult } from "./recipe-mcp/sync.js";
import { runSyncCli } from "./sync-cli.js";

/**
 * `runSyncCli` is the testable core of the `pnpm sync` command — everything
 * except the boot wrapper (secrets/stores/llm construction, process.exit),
 * mirroring how `index.ts` splits `main()` from its pure helpers.
 */

function syncResult(): SyncResult {
  return { total: 5, processed: 2, skipped: 3, extractionFailures: 1 };
}

describe("runSyncCli", () => {
  it("runs the sync, logs a summary, and returns the SyncResult", async () => {
    const runSync = vi.fn(async () => syncResult());
    const logger = { log: vi.fn(), error: vi.fn() };

    const out = await runSyncCli({ runSync, logger });

    expect(runSync).toHaveBeenCalledTimes(1);
    expect(out).toEqual(syncResult());
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("processed=2"),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("extractionFailures=1"),
    );
  });

  it("logs token/$ spend from the meter when one is provided", async () => {
    const runSync = vi.fn(async () => syncResult());
    const meter = {
      totals: vi.fn(() => ({
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.0042,
      })),
    };
    const logger = { log: vi.fn(), error: vi.fn() };

    await runSyncCli({ runSync, meter, logger });

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("in=100"));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("$0.0042"));
  });
});
