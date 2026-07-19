/**
 * Our own decoupled contract over "run one agentic LLM query." This is the
 * ONLY shape the rest of the app is allowed to depend on for talking to
 * Claude — no file outside `src/llm/` may import types from
 * `@anthropic-ai/claude-agent-sdk` directly. See `agent-sdk-client.ts` for
 * the (sole) adapter that bridges this interface to the real SDK.
 */

/**
 * A local MCP server launched over stdio. This is OUR shape (not the SDK's)
 * — the adapter translates it into whatever the Claude Agent SDK expects.
 */
export type StdioMcpServerSpec = {
  /** Unique name for this server; used as the key the model refers to. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Input to a single agentic run. */
export type RunQueryInput = {
  prompt: string;
  system?: string;
  mcpServers?: StdioMcpServerSpec[];
};

/**
 * Token usage totals for one `runQuery` call, aggregated across every
 * underlying SDK turn, with the input broken out by Anthropic billing tier
 * (bd meal-planner-fkg.5) so `CostMeter` can price cache reads/writes at their
 * real rates instead of a flat over-estimate.
 *
 * IMPORTANT — `inputTokens` is FRESH (uncached) input ONLY. It does NOT
 * include the cache-write / cache-read categories (those are `cacheWriteTokens`
 * / `cacheReadTokens`). This differs from the pre-fkg.5 meaning, where
 * `inputTokens` was the SUM of all three input categories. Every reader that
 * wants "total input tokens processed" must add all three (see
 * `CostTotals.inputTokens`, which does).
 *
 * The two cache fields are OPTIONAL and default to 0 wherever a producer does
 * not set them (e.g. the assistant-turn fallback path, or older callers) — a
 * missing field is treated as "no cache activity", which prices that input at
 * the full fresh rate (the conservative direction for a spend guard).
 */
export type LlmUsage = {
  /** Fresh (uncached) input tokens, billed at the base input rate. */
  inputTokens: number;
  outputTokens: number;
  /**
   * `cache_creation_input_tokens` — input written to the prompt cache, billed
   * at ~1.25× the base input rate. Optional; treated as 0 when absent.
   */
  cacheWriteTokens?: number;
  /**
   * `cache_read_input_tokens` — input served from the prompt cache, billed at
   * ~0.1× the base input rate. Optional; treated as 0 when absent.
   */
  cacheReadTokens?: number;
};

/** Result of one agentic run: the final text plus aggregated usage. */
export type LlmResult = {
  text: string;
  usage: LlmUsage;
};

/**
 * The single typed chokepoint the rest of the app uses to drive Claude.
 * Implementations are free to run an arbitrary number of underlying model
 * turns (tool calls, etc.) to produce one `LlmResult` — usage is summed
 * across all of them (see SPEC §9.3: a "run" aggregates across calls).
 */
export interface LlmClient {
  runQuery(input: RunQueryInput): Promise<LlmResult>;
}

/**
 * Thrown by an `LlmClient.runQuery` that fails AFTER the model has already
 * billed for (part of) the call — a rate-limit / overloaded / server error
 * that lands once the prompt is ingested and some turns have streamed (bd
 * meal-planner-fkg.9). It carries the usage accumulated *before* the throw so
 * a decorator (see `meteredLlmClient`) can still record that partial spend
 * against the cost meter/cap — otherwise a persistently-failing corpus burns
 * real input tokens the meter never sees.
 *
 * `usage` may be all-zero when the failure occurred before any billing (e.g.
 * the SDK stream threw on its very first step); recording zero is a no-op and
 * always safe. Lives here — beside `LlmUsage` and the `LlmClient` contract it
 * is part of — because it IS part of that contract (what `runQuery` may throw).
 * The original failure is preserved as `cause`; the message is carried through
 * verbatim (never a secret — the SDK error values are a closed enum of type
 * names).
 */
export class LlmCallError extends Error {
  readonly usage: LlmUsage;

  constructor(message: string, usage: LlmUsage, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmCallError";
    this.usage = usage;
  }
}
