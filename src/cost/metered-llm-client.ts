import {
  LlmCallError,
  type LlmClient,
  type LlmResult,
  type RunQueryInput,
} from "../llm/llm-client.js";
import { CostCapExceededError } from "./cost-cap-exceeded-error.js";
import type { CostMeter } from "./cost-meter.js";

/** Options for `meteredLlmClient` -- currently just the optional per-run cap. */
export interface MeteredLlmClientOptions {
  /**
   * The per-run dollar cap to enforce (SPEC §9.3, bd meal-planner-fkg.2),
   * e.g. `config.generationDollarCap`. When omitted (or `undefined`), no cap
   * is enforced -- behavior is identical to fkg.1 (track-only, never
   * throws).
   */
  capUsd?: number;
}

/**
 * Decorates an `LlmClient` so every successful `runQuery` reports its usage
 * to `meter` (SPEC §9.3, bd meal-planner-fkg.1), and -- when `options.capUsd`
 * is set -- ENFORCES that per-run budget (fkg.2): the real ceiling, since
 * Anthropic offers spend ALERTS but not an enforced per-key cutoff.
 *
 * Records on success AND on a failure that already billed (bd
 * meal-planner-fkg.9): if `inner.runQuery` throws an `LlmCallError`, the
 * partial `usage` it carries (input/output billed before the throw) is
 * recorded BEFORE the error is rethrown, so a rate-limit / overloaded failure
 * that lands after prompt ingestion still counts against the meter/cap instead
 * of being invisible spend. A throw that carries no usage (a plain `Error`, or
 * the pre-call `CostCapExceededError` itself) records nothing and propagates
 * unchanged. The failed usage is recorded exactly once: the success `record`
 * below is only reached when `inner.runQuery` returned, so the two paths are
 * mutually exclusive -- never a double-count.
 *
 * TWO cap gates, both required (bd meal-planner-fkg.6):
 *  - PRE-call: if the run is ALREADY over cap, throw BEFORE `inner.runQuery`
 *    so no further money is spent. Without this, a run that trips the cap
 *    mid-batch (e.g. an ~800-note sync re-extraction) would pay full price on
 *    every remaining call before the post-call check caught each one.
 *  - POST-call (after `meter.record`): catches a single call that itself
 *    blows the cap -- that call really was spent, so it's counted, and THEN
 *    the throw prevents any further calls this run.
 *
 * The thrown `CostCapExceededError` propagates out of `buildPlan` and is
 * caught by `generateForWeek`'s existing failure path (row -> `failed`,
 * alert fires, partial spend persisted); on the sync path it propagates out
 * of `extractRecipeFields` (unwrapped) and aborts the batch in `syncNotes` --
 * no separate stop/alert mechanism here or there.
 *
 * The returned `LlmResult` is passed through unchanged when under (or with
 * no) cap -- this is a pure side-effecting decorator, not a transform.
 */
export function meteredLlmClient(
  inner: LlmClient,
  meter: CostMeter,
  options?: MeteredLlmClientOptions,
): LlmClient {
  const capUsd = options?.capUsd;
  return {
    async runQuery(input: RunQueryInput): Promise<LlmResult> {
      // PRE-call gate: already over cap => refuse to spend anything more.
      if (capUsd != null) {
        const { costUsd } = meter.totals();
        if (costUsd > capUsd) {
          throw new CostCapExceededError(costUsd, capUsd);
        }
      }
      let result: LlmResult;
      try {
        result = await inner.runQuery(input);
      } catch (error) {
        // fkg.9: a failure that already billed carries its partial usage on an
        // `LlmCallError`. Record it (exactly once -- the success `record` below
        // is unreachable on this path) then rethrow the ORIGINAL error, so the
        // failed-call spend counts against the cap. Any other throw (plain
        // Error, or a pre-call CostCapExceededError) carries no usage and just
        // propagates.
        if (error instanceof LlmCallError) {
          meter.record(error.usage);
        }
        throw error;
      }
      meter.record(result.usage);
      // POST-call gate: this call itself may have pushed the run over.
      if (capUsd != null) {
        const { costUsd } = meter.totals();
        if (costUsd > capUsd) {
          throw new CostCapExceededError(costUsd, capUsd);
        }
      }
      return result;
    },
  };
}
