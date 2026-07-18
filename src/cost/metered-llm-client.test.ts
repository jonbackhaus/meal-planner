import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult, RunQueryInput } from "../llm/llm-client.js";
import { CostCapExceededError } from "./cost-cap-exceeded-error.js";
import { CostMeter } from "./cost-meter.js";
import { meteredLlmClient } from "./metered-llm-client.js";

const RATE = { inputPerMTok: 2, outputPerMTok: 10 };

function fakeInner(result: LlmResult): LlmClient {
  return { runQuery: vi.fn(async (_input: RunQueryInput) => result) };
}

describe("meteredLlmClient", () => {
  it("records usage on the meter after a successful runQuery", async () => {
    const meter = new CostMeter(RATE);
    const inner = fakeInner({
      text: "ok",
      usage: { inputTokens: 1000, outputTokens: 200 },
    });
    const metered = meteredLlmClient(inner, meter);

    await metered.runQuery({ prompt: "hi" });

    expect(meter.totals().inputTokens).toBe(1000);
    expect(meter.totals().outputTokens).toBe(200);
  });

  it("returns the inner result unchanged", async () => {
    const meter = new CostMeter(RATE);
    const result: LlmResult = {
      text: "the answer",
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    const inner = fakeInner(result);
    const metered = meteredLlmClient(inner, meter);

    const returned = await metered.runQuery({ prompt: "hi" });

    expect(returned).toBe(result);
  });

  it("does NOT record usage when inner.runQuery throws", async () => {
    const meter = new CostMeter(RATE);
    const inner: LlmClient = {
      runQuery: vi.fn(async () => {
        throw new Error("SDK exploded");
      }),
    };
    const metered = meteredLlmClient(inner, meter);

    await expect(metered.runQuery({ prompt: "hi" })).rejects.toThrow(
      "SDK exploded",
    );

    expect(meter.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("accumulates across multiple calls through the same decorator", async () => {
    const meter = new CostMeter(RATE);
    let call = 0;
    const inner: LlmClient = {
      runQuery: vi.fn(async () => {
        call += 1;
        return {
          text: `call ${call}`,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }),
    };
    const metered = meteredLlmClient(inner, meter);

    await metered.runQuery({ prompt: "first" });
    await metered.runQuery({ prompt: "second" });

    expect(meter.totals().inputTokens).toBe(200);
    expect(meter.totals().outputTokens).toBe(100);
  });

  describe("cap enforcement (bd meal-planner-fkg.2, SPEC §9.3)", () => {
    // $1/MTok in, $0/MTok out -- makes the $ math trivial: 1,000,000 input
    // tokens = $1.
    const CAP_RATE = { inputPerMTok: 1, outputPerMTok: 0 };

    it("throws CostCapExceededError once cumulative cost EXCEEDS the cap across two calls", async () => {
      const meter = new CostMeter(CAP_RATE);
      let call = 0;
      const inner: LlmClient = {
        runQuery: vi.fn(async () => {
          call += 1;
          // Each call costs $1.50 (1_500_000 tokens @ $1/1k-equivalent rate
          // above) -- two calls = $3, over a $2 cap.
          return {
            text: `call ${call}`,
            usage: { inputTokens: 1_500_000, outputTokens: 0 },
          };
        }),
      };
      const metered = meteredLlmClient(inner, meter, { capUsd: 2 });

      await metered.runQuery({ prompt: "first" }); // cumulative $1.50, under cap
      await expect(metered.runQuery({ prompt: "second" })).rejects.toThrow(
        CostCapExceededError,
      );
    });

    it("does NOT throw when cumulative cost stays under the cap", async () => {
      const meter = new CostMeter(CAP_RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 500_000, outputTokens: 0 },
        })),
      };
      const metered = meteredLlmClient(inner, meter, { capUsd: 2 });

      await expect(metered.runQuery({ prompt: "hi" })).resolves.toBeDefined();
      expect(meter.totals().costUsd).toBeCloseTo(0.5, 10);
    });

    it("the call that trips the cap IS still recorded -- spend reflects it", async () => {
      const meter = new CostMeter(CAP_RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 3_000_000, outputTokens: 0 },
        })),
      };
      const metered = meteredLlmClient(inner, meter, { capUsd: 2 });

      await expect(metered.runQuery({ prompt: "hi" })).rejects.toThrow(
        CostCapExceededError,
      );

      // $3 spent, recorded even though it threw.
      expect(meter.totals().costUsd).toBeCloseTo(3, 10);
    });

    it("with no capUsd, never throws no matter how much is spent", async () => {
      const meter = new CostMeter(CAP_RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 10_000_000, outputTokens: 0 },
        })),
      };
      const metered = meteredLlmClient(inner, meter);

      await expect(metered.runQuery({ prompt: "hi" })).resolves.toBeDefined();
      expect(meter.totals().costUsd).toBeCloseTo(10, 10);
    });

    it("throws BEFORE calling inner.runQuery once already over the cap -- no further spend", async () => {
      // First call blows past the $2 cap ($3 spent); the SECOND call must be
      // rejected by the pre-call gate WITHOUT ever reaching inner.runQuery, so
      // an over-cap run stops spending immediately instead of paying full price
      // on every remaining call before the post-call check catches it.
      const meter = new CostMeter(CAP_RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 3_000_000, outputTokens: 0 },
        })),
      };
      const metered = meteredLlmClient(inner, meter, { capUsd: 2 });

      await expect(metered.runQuery({ prompt: "first" })).rejects.toThrow(
        CostCapExceededError,
      );
      expect(inner.runQuery).toHaveBeenCalledTimes(1); // the over-cap call itself

      await expect(metered.runQuery({ prompt: "second" })).rejects.toThrow(
        CostCapExceededError,
      );
      // Still 1: the pre-call gate short-circuited before inner.runQuery ran.
      expect(inner.runQuery).toHaveBeenCalledTimes(1);
      // No additional spend recorded for the short-circuited call.
      expect(meter.totals().costUsd).toBeCloseTo(3, 10);
    });

    it("with no capUsd, the pre-call gate never short-circuits", async () => {
      const meter = new CostMeter(CAP_RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 10_000_000, outputTokens: 0 },
        })),
      };
      const metered = meteredLlmClient(inner, meter);

      await metered.runQuery({ prompt: "first" }); // $10, way over any cap
      await expect(
        metered.runQuery({ prompt: "second" }),
      ).resolves.toBeDefined();
      expect(inner.runQuery).toHaveBeenCalledTimes(2);
    });

    it("the thrown error names the cost and the cap", async () => {
      const meter = new CostMeter(CAP_RATE);
      const inner: LlmClient = {
        runQuery: vi.fn(async () => ({
          text: "ok",
          usage: { inputTokens: 2_500_000, outputTokens: 0 },
        })),
      };
      const metered = meteredLlmClient(inner, meter, { capUsd: 2 });

      await expect(metered.runQuery({ prompt: "hi" })).rejects.toThrow(
        "cost cap exceeded: $2.50 spent > $2.00 cap",
      );
    });
  });
});
