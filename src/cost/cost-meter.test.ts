import { describe, expect, it } from "vitest";
import { CostMeter, costUsd } from "./cost-meter.js";

/**
 * SPEC §9.3's intro pricing for `claude-sonnet-5`: $2/MTok in, $10/MTok out
 * (matches `DEFAULT_MODEL_RATES` in src/config/config.ts).
 */
const SONNET_5_RATE = { inputPerMTok: 2, outputPerMTok: 10 };

describe("costUsd", () => {
  it("computes $ from token counts and a per-model rate (sonnet-5 intro pricing)", () => {
    // 1,000,000 input tokens @ $2/MTok + 500,000 output tokens @ $10/MTok
    // = $2 + $5 = $7.
    expect(costUsd(1_000_000, 500_000, SONNET_5_RATE)).toBeCloseTo(7, 10);
  });

  it("is zero for zero tokens", () => {
    expect(costUsd(0, 0, SONNET_5_RATE)).toBe(0);
  });

  it("handles fractional-of-a-million token counts", () => {
    // 250,000 input tokens @ $2/MTok = $0.50; 100,000 output @ $10/MTok = $1.
    expect(costUsd(250_000, 100_000, SONNET_5_RATE)).toBeCloseTo(1.5, 10);
  });
});

describe("CostMeter", () => {
  it("accumulates usage across multiple record() calls", () => {
    const meter = new CostMeter(SONNET_5_RATE);

    meter.record({ inputTokens: 100_000, outputTokens: 50_000 });
    meter.record({ inputTokens: 200_000, outputTokens: 10_000 });

    const totals = meter.totals();
    expect(totals.inputTokens).toBe(300_000);
    expect(totals.outputTokens).toBe(60_000);
    expect(totals.costUsd).toBeCloseTo(
      costUsd(300_000, 60_000, SONNET_5_RATE),
      10,
    );
  });

  it("prices cache-write and cache-read input at their rate tiers, not the flat input rate (bd fkg.5)", () => {
    // 1,000,000 fresh input @ $2/MTok            = $2.00
    // 1,000,000 cache-write @ 1.25×$2/MTok       = $2.50
    // 1,000,000 cache-read  @ 0.10×$2/MTok       = $0.20
    //   500,000 output      @ $10/MTok           = $5.00
    //                                       total = $9.70
    const meter = new CostMeter(SONNET_5_RATE);
    meter.record({
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 500_000,
    });

    const totals = meter.totals();
    // Reported input tokens = ALL input categories summed (total processed).
    expect(totals.inputTokens).toBe(3_000_000);
    expect(totals.outputTokens).toBe(500_000);
    expect(totals.costUsd).toBeCloseTo(9.7, 10);
    // Explicitly LOWER than the pre-fkg.5 flat over-estimate (all 3M input
    // billed at the fresh rate → $6 in + $5 out = $11), i.e. more accurate but
    // never undercounting fresh input or output.
    expect(totals.costUsd).toBeLessThan(
      costUsd(3_000_000, 500_000, SONNET_5_RATE),
    );
  });

  it("matches the old flat cost when there is no cache activity (no regression)", () => {
    const meter = new CostMeter(SONNET_5_RATE);
    meter.record({ inputTokens: 250_000, outputTokens: 100_000 });

    expect(meter.totals().costUsd).toBeCloseTo(
      costUsd(250_000, 100_000, SONNET_5_RATE),
      10,
    );
  });

  it("treats missing cache fields as zero (backward-friendly producers)", () => {
    const meter = new CostMeter(SONNET_5_RATE);
    // No cacheWriteTokens/cacheReadTokens: same as all-fresh input.
    meter.record({ inputTokens: 500_000, outputTokens: 0 });

    const totals = meter.totals();
    expect(totals.inputTokens).toBe(500_000);
    expect(totals.costUsd).toBeCloseTo(costUsd(500_000, 0, SONNET_5_RATE), 10);
  });

  it("reset() zeroes the accumulators", () => {
    const meter = new CostMeter(SONNET_5_RATE);
    meter.record({ inputTokens: 100_000, outputTokens: 50_000 });

    meter.reset();

    expect(meter.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("starts at zero before any record() call", () => {
    const meter = new CostMeter(SONNET_5_RATE);
    expect(meter.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("throws a clear error when constructed with no rate (unknown model)", () => {
    expect(() => new CostMeter(undefined)).toThrow(/rate/i);
  });

  it("names the offending model in the no-rate error when a model name is given", () => {
    expect(() => new CostMeter(undefined, "claude-made-up-9")).toThrow(
      /claude-made-up-9/,
    );
  });

  it("still throws a clear error with no model name given (backward compatible)", () => {
    expect(() => new CostMeter(undefined)).toThrow(/no rate configured/i);
  });
});
