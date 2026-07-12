import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResult, RunQueryInput } from "../llm/llm-client.js";
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
});
