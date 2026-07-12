/**
 * Thrown when a generation run's cumulative spend exceeds the per-run dollar
 * cap (SPEC §9.3, bd meal-planner-fkg.2) -- the in-code ceiling that bounds a
 * runaway, since Anthropic offers spend ALERTS but not an enforced
 * per-key cutoff. Thrown by `meteredLlmClient` (see `metered-llm-client.ts`)
 * once `meter.totals().costUsd` exceeds `capUsd` -- AFTER the call that
 * tripped it is recorded, so the spend that pushed it over is never lost.
 *
 * Carries only the two numbers involved -- never a secret, a prompt, or any
 * household/plan content -- so it's always safe to surface verbatim in an
 * alert (see `generateForWeek`'s failure path, which interpolates
 * `String(e)` into the #agent-alerts message).
 */
export class CostCapExceededError extends Error {
  readonly costUsd: number;
  readonly capUsd: number;

  constructor(costUsd: number, capUsd: number) {
    super(
      `cost cap exceeded: $${costUsd.toFixed(2)} spent > $${capUsd.toFixed(2)} cap`,
    );
    this.name = "CostCapExceededError";
    this.costUsd = costUsd;
    this.capUsd = capUsd;
  }
}
