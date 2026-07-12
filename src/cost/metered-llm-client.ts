import type { LlmClient, LlmResult, RunQueryInput } from "../llm/llm-client.js";
import type { CostMeter } from "./cost-meter.js";

/**
 * Decorates an `LlmClient` so every successful `runQuery` reports its usage
 * to `meter` (SPEC §9.3, bd meal-planner-fkg.1). Records ONLY on success --
 * if `inner.runQuery` throws, no usage is recorded (tokens for a failed call
 * aren't reported here; see `generateForWeek`'s wiring for how a run's
 * already-recorded partial spend still persists on a later failure).
 *
 * The returned `LlmResult` is passed through unchanged -- this is a pure
 * side-effecting decorator, not a transform.
 */
export function meteredLlmClient(
  inner: LlmClient,
  meter: CostMeter,
): LlmClient {
  return {
    async runQuery(input: RunQueryInput): Promise<LlmResult> {
      const result = await inner.runQuery(input);
      meter.record(result.usage);
      return result;
    },
  };
}
