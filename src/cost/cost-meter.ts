import type { ModelRate } from "../config/config.js";
import type { LlmUsage } from "../llm/llm-client.js";

/**
 * Anthropic input-token rate tiers, expressed as multipliers on the base
 * (`inputPerMTok`) rate — see https://docs.anthropic.com/en/docs/about-claude/pricing
 * (prompt caching). A cache WRITE (`cache_creation_input_tokens`) bills at
 * 1.25× the base input rate; a cache READ (`cache_read_input_tokens`) bills at
 * 0.1×. Fresh (uncached) input bills at the base rate (1×). Output has its own
 * separate rate and is unaffected by these tiers.
 *
 * Kept as multipliers on the existing single `inputPerMTok` (rather than three
 * explicit per-MTok rates in `ModelRates`) so a pricing edit stays a
 * one-number change and no config plumbing has to know about caching — the
 * tier RATIOS are a stable property of Anthropic's pricing, the base rate is
 * the only per-model knob.
 */
const CACHE_WRITE_RATE_MULTIPLIER = 1.25;
const CACHE_READ_RATE_MULTIPLIER = 0.1;

/**
 * Token/$ tracking across a generation run (SPEC §9.3, bd meal-planner-fkg.1).
 *
 * A "run" = every Agent SDK call `buildPlan` makes within ONE
 * `generateForWeek` cycle (the selection call + a possible repair, etc.) —
 * the $ BUDGET aggregates ACROSS all of them, not per-call. This module only
 * TRACKS + persists the total; it does NOT enforce a cap (that's fkg.2,
 * next).
 */

/**
 * Pure conversion of token counts to dollars via a per-model rate.
 * `(inputTokens/1e6)*inputPerMTok + (outputTokens/1e6)*outputPerMTok`.
 */
export function costUsd(
  inputTokens: number,
  outputTokens: number,
  rate: ModelRate,
): number {
  return (
    (inputTokens / 1_000_000) * rate.inputPerMTok +
    (outputTokens / 1_000_000) * rate.outputPerMTok
  );
}

/**
 * Cache-aware cost (bd meal-planner-fkg.5): fresh input at the base rate,
 * cache-write at 1.25×, cache-read at 0.1×, output at its own rate. Missing
 * cache fields count as 0. This is a MORE ACCURATE (lower) figure than the
 * pre-fkg.5 flat estimate that billed every input category at the base rate —
 * but it never undercounts fresh input or output (both are billed in full;
 * cache-write is billed ABOVE the base rate), so the spend cap it feeds
 * (fkg.6) still errs conservative.
 */
export function tieredCostUsd(usage: LlmUsage, rate: ModelRate): number {
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  return (
    costUsd(usage.inputTokens, usage.outputTokens, rate) +
    (cacheWriteTokens / 1_000_000) *
      rate.inputPerMTok *
      CACHE_WRITE_RATE_MULTIPLIER +
    (cacheReadTokens / 1_000_000) *
      rate.inputPerMTok *
      CACHE_READ_RATE_MULTIPLIER
  );
}

/** Aggregated token/$ totals for the calls recorded so far in the current run. */
export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Accumulates token usage (and the $ it represents) across every LLM call in
 * one generation run. Deterministic -- never touches `Date`/`Math.random`.
 *
 * Runs are sequential (one `generateForWeek` at a time), so a single shared
 * `CostMeter` instance, `reset()` at the start of each run, is correct: there
 * is never more than one run's worth of calls live in the meter at once.
 */
export class CostMeter {
  private readonly rate: ModelRate;
  // Input is tracked per billing tier (bd meal-planner-fkg.5) so `totals()` can
  // price cache reads/writes at their real rates. `CostTotals.inputTokens`
  // still reports the SUM of all three (total input processed).
  private freshInputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  private outputTokens = 0;

  /**
   * `rate` is the resolved per-model rate to bill against (e.g.
   * `config.modelRates[config.model]`) -- resolved once, at construction, so
   * a misconfigured model (no rate entry -- `rate` is `undefined`) fails
   * loudly at startup rather than silently reporting $0 forever. `model` is
   * the model NAME that `rate` was resolved from (e.g. `config.model`) --
   * optional, purely so the no-rate error can name the offending model
   * (fkg.1 review follow-up); omitting it preserves the original message.
   */
  constructor(rate: ModelRate | undefined, model?: string) {
    if (!rate) {
      const modelDescription = model ? ` "${model}"` : "";
      throw new Error(
        `CostMeter: no rate configured for the selected model${modelDescription} -- add an ` +
          "entry to config.modelRates for it before starting the daemon",
      );
    }
    this.rate = rate;
  }

  /** Accumulates one call's usage into the running totals. */
  record(usage: LlmUsage): void {
    this.freshInputTokens += usage.inputTokens;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.outputTokens += usage.outputTokens;
  }

  /** Zeroes the accumulators -- call at the START of each run. */
  reset(): void {
    this.freshInputTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheReadTokens = 0;
    this.outputTokens = 0;
  }

  /** The running totals for the calls recorded since the last `reset()`. */
  totals(): CostTotals {
    return {
      // Total input tokens processed = fresh + cache-write + cache-read. This
      // keeps the reported token count (persisted `token_spend`, sync logging)
      // meaning the same as pre-fkg.5; only the $ math is now tiered.
      inputTokens:
        this.freshInputTokens + this.cacheWriteTokens + this.cacheReadTokens,
      outputTokens: this.outputTokens,
      costUsd: tieredCostUsd(
        {
          inputTokens: this.freshInputTokens,
          outputTokens: this.outputTokens,
          cacheWriteTokens: this.cacheWriteTokens,
          cacheReadTokens: this.cacheReadTokens,
        },
        this.rate,
      ),
    };
  }
}
