import type { ModelRate } from "../config/config.js";

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
  private inputTokens = 0;
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
  record(usage: { inputTokens: number; outputTokens: number }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  /** Zeroes the accumulators -- call at the START of each run. */
  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  /** The running totals for the calls recorded since the last `reset()`. */
  totals(): CostTotals {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: costUsd(this.inputTokens, this.outputTokens, this.rate),
    };
  }
}
