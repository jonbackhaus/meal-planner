import type { LlmClient, LlmResult, RunQueryInput } from "../llm/llm-client.js";
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
 * Records ONLY on success -- if `inner.runQuery` throws, no usage is
 * recorded (tokens for a failed call aren't reported here; see
 * `generateForWeek`'s wiring for how a run's already-recorded partial spend
 * still persists on a later failure).
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
      const result = await inner.runQuery(input);
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
