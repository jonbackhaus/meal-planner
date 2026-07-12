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

/** Token usage totals for one `runQuery` call, aggregated across every underlying SDK turn. */
export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
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
