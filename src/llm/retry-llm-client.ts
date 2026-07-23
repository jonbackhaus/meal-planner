import {
  type LlmClient,
  type LlmResult,
  LlmTimeoutError,
  type RunQueryInput,
} from "./llm-client.js";

/** Options for `retryLlmClient` -- see the function doc for the bound/ordering contract. */
export interface RetryLlmClientOptions {
  /**
   * Max number of ADDITIONAL attempts after the first, bounded (bd
   * meal-planner-k31, qjk follow-up). Each retried attempt calls
   * `inner.runQuery` fresh -- a fresh underlying SDK call/`AbortController`,
   * since `AgentSdkLlmClient.runQuery` constructs a new one every invocation
   * -- gated by the SAME per-call timeout (`llmCallTimeoutMs`, qjk) and, when
   * `inner` is (or wraps) a `meteredLlmClient`, the SAME cost-cap gate on
   * every attempt. `0` disables retrying entirely (fail-fast, the pre-k31
   * behavior).
   */
  maxRetries: number;
}

/**
 * Decorates an `LlmClient` with a BOUNDED retry for a transient per-call stall
 * (bd meal-planner-k31, qjk follow-up). `AgentSdkLlmClient.runQuery`'s own
 * per-call watchdog (qjk, `llmCallTimeoutMs`) throws `LlmTimeoutError` when a
 * call wedges rather than failing the whole trigger; this decorator gives a
 * brief transient rough patch (observed at go-live, ~08:15-08:27 EDT) a chance
 * to clear on a fresh call before falling through to the existing
 * `failed` + `#agent-alerts` path unchanged.
 *
 * ONLY retries `LlmTimeoutError` (a wedged call that never yielded a terminal
 * message on its own) -- any other thrown error (a genuine `LlmCallError`, a
 * `CostCapExceededError` from a metered `inner`, or a plain `Error`) propagates
 * immediately, unretried. This is deliberately narrow: qjk's whole premise is
 * that a stall is SILENT (never resolves nor rejects on its own); a real API
 * response (rate-limit, overloaded, a real result error) already surfaced
 * promptly, and retrying THAT here would just resend a request the API
 * already answered.
 *
 * ORDERING CONTRACT -- this MUST wrap the OUTSIDE of `meteredLlmClient` (i.e.
 * compose as `retryLlmClient(meteredLlmClient(inner, meter, opts), retryOpts)`,
 * never the reverse) so EVERY attempt -- including retries -- passes through
 * the SAME pre-call/post-call cost-cap gate and has its usage recorded to the
 * meter individually, exactly like any other call. Composing it the other way
 * (metering only wrapping the OUTCOME of all retries) would hide the spend of
 * every failed retry from the cap until the whole retry sequence settled --
 * the "defeats the cost cap" failure mode this bead exists to avoid. With the
 * correct ordering, a retry that would push the run over cap is refused by the
 * pre-call gate (`CostCapExceededError`, not an `LlmTimeoutError`) before it
 * spends anything further, and that error is NOT itself retried.
 *
 * Bounded and small by design: worst-case wall time for one logical call
 * becomes `(1 + maxRetries) * llmCallTimeoutMs`, which must stay well under
 * `triggerTimeoutMs` (bd6.11) for the same reason a single `llmCallTimeoutMs`
 * must -- see `config.ts`'s doc comment on `llmCallMaxRetries`.
 */
export function retryLlmClient(
  inner: LlmClient,
  options: RetryLlmClientOptions,
): LlmClient {
  const { maxRetries } = options;
  return {
    async runQuery(input: RunQueryInput): Promise<LlmResult> {
      let attempt = 0;
      for (;;) {
        try {
          return await inner.runQuery(input);
        } catch (error) {
          if (!(error instanceof LlmTimeoutError) || attempt >= maxRetries) {
            throw error;
          }
          attempt += 1;
        }
      }
    },
  };
}
