import { describe, expect, it, vi } from "vitest";
import { CostCapExceededError } from "../cost/cost-cap-exceeded-error.js";
import { CostMeter } from "../cost/cost-meter.js";
import { meteredLlmClient } from "../cost/metered-llm-client.js";
import {
  LlmCallError,
  type LlmClient,
  type LlmResult,
  LlmTimeoutError,
  type RunQueryInput,
} from "./llm-client.js";
import { retryLlmClient } from "./retry-llm-client.js";

const RATE = { inputPerMTok: 1, outputPerMTok: 0 };

function fakeResult(text: string): LlmResult {
  return { text, usage: { inputTokens: 1000, outputTokens: 0 } };
}

describe("retryLlmClient (bd meal-planner-k31)", () => {
  it("retries once on a transient LlmTimeoutError and returns the successful attempt's result", async () => {
    let calls = 0;
    const inner: LlmClient = {
      runQuery: vi.fn(async (_input: RunQueryInput) => {
        calls += 1;
        if (calls === 1) {
          throw new LlmTimeoutError("wedged", {
            inputTokens: 0,
            outputTokens: 0,
          });
        }
        return fakeResult("recovered on retry");
      }),
    };
    const client = retryLlmClient(inner, { maxRetries: 1 });

    const result = await client.runQuery({ prompt: "hi" });

    expect(result.text).toBe("recovered on retry");
    expect(inner.runQuery).toHaveBeenCalledTimes(2);
  });

  it("is BOUNDED: exhausts maxRetries and rethrows the final LlmTimeoutError, never retrying past the bound", async () => {
    const inner: LlmClient = {
      runQuery: vi.fn(async () => {
        throw new LlmTimeoutError("always wedged", {
          inputTokens: 0,
          outputTokens: 0,
        });
      }),
    };
    const client = retryLlmClient(inner, { maxRetries: 2 });

    await expect(client.runQuery({ prompt: "hi" })).rejects.toBeInstanceOf(
      LlmTimeoutError,
    );
    // Exactly 1 initial attempt + 2 retries = 3 total, never more.
    expect(inner.runQuery).toHaveBeenCalledTimes(3);
  });

  it("maxRetries: 0 disables retrying entirely (fail-fast, pre-k31 behavior)", async () => {
    const inner: LlmClient = {
      runQuery: vi.fn(async () => {
        throw new LlmTimeoutError("wedged", {
          inputTokens: 0,
          outputTokens: 0,
        });
      }),
    };
    const client = retryLlmClient(inner, { maxRetries: 0 });

    await expect(client.runQuery({ prompt: "hi" })).rejects.toBeInstanceOf(
      LlmTimeoutError,
    );
    expect(inner.runQuery).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a genuine (non-timeout) LlmCallError -- only a silent stall is retried", async () => {
    const failure = new LlmCallError("rate_limit", {
      inputTokens: 10,
      outputTokens: 0,
    });
    const inner: LlmClient = {
      runQuery: vi.fn(async () => {
        throw failure;
      }),
    };
    const client = retryLlmClient(inner, { maxRetries: 3 });

    await expect(client.runQuery({ prompt: "hi" })).rejects.toBe(failure);
    expect(inner.runQuery).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a plain Error", async () => {
    const inner: LlmClient = {
      runQuery: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const client = retryLlmClient(inner, { maxRetries: 3 });

    await expect(client.runQuery({ prompt: "hi" })).rejects.toThrow("boom");
    expect(inner.runQuery).toHaveBeenCalledTimes(1);
  });

  it("returns the inner result unchanged on a first-attempt success (no retry needed)", async () => {
    const result = fakeResult("first try");
    const inner: LlmClient = {
      runQuery: vi.fn(async () => result),
    };
    const client = retryLlmClient(inner, { maxRetries: 2 });

    const returned = await client.runQuery({ prompt: "hi" });

    expect(returned).toBe(result);
    expect(inner.runQuery).toHaveBeenCalledTimes(1);
  });

  describe("cost-cap enforcement across retries (bd meal-planner-k31 + fkg.2/fkg.9)", () => {
    it("composed OUTSIDE meteredLlmClient, retries stop the instant the cap trips -- even with retries still available", async () => {
      // Each wedged attempt "spends" $1.50 worth of tokens on its way to
      // timing out (LlmTimeoutError carries partial usage, same as any other
      // LlmCallError -- fkg.9). With a $2 cap: attempt 1 bills $1.50 (under
      // cap, retried); attempt 2 bills another $1.50 (cumulative $3, over
      // cap, but the failure-recording path doesn't gate -- still retried);
      // attempt 3's PRE-call gate then finds cumulative already over cap and
      // throws CostCapExceededError WITHOUT calling inner a third time --
      // even though maxRetries (5) would otherwise allow two more attempts.
      const meter = new CostMeter(RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => {
          throw new LlmTimeoutError("wedged", {
            inputTokens: 1_500_000,
            outputTokens: 0,
          });
        }),
      };
      const metered = meteredLlmClient(inner, meter, { capUsd: 2 });
      const client = retryLlmClient(metered, { maxRetries: 5 });

      await expect(client.runQuery({ prompt: "hi" })).rejects.toBeInstanceOf(
        CostCapExceededError,
      );

      // Only 2 of the 5 allowed retries ever reached `inner` -- the cap gate
      // cut the retry loop short, proving the bound never lets retries spend
      // past the cap regardless of how many retries remain.
      expect(inner.runQuery).toHaveBeenCalledTimes(2);
      expect(meter.totals().costUsd).toBeCloseTo(3, 10);
    });

    it("a retry attempt that itself succeeds still has its usage recorded and cap-checked individually", async () => {
      const meter = new CostMeter(RATE);
      let calls = 0;
      const inner: LlmClient = {
        runQuery: vi.fn(async () => {
          calls += 1;
          if (calls === 1) {
            throw new LlmTimeoutError("wedged", {
              inputTokens: 500_000,
              outputTokens: 0,
            });
          }
          return {
            text: "ok",
            usage: { inputTokens: 500_000, outputTokens: 0 },
          };
        }),
      };
      const metered = meteredLlmClient(inner, meter, { capUsd: 2 });
      const client = retryLlmClient(metered, { maxRetries: 1 });

      const result = await client.runQuery({ prompt: "hi" });

      expect(result.text).toBe("ok");
      // Both attempts' usage recorded: 0.5 + 0.5 = $1, under the $2 cap.
      expect(meter.totals().costUsd).toBeCloseTo(1, 10);
      expect(inner.runQuery).toHaveBeenCalledTimes(2);
    });
  });
});
