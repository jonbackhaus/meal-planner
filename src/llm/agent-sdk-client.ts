import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config/config.js";
import {
  LlmCallError,
  type LlmClient,
  type LlmResult,
  type RunQueryInput,
  type StdioMcpServerSpec,
} from "./llm-client.js";

type AgentSdkConfig = Pick<Config, "model" | "effort">;

/** Translates OUR stdio MCP server spec into the SDK's `mcpServers` option shape. */
function toSdkMcpServers(
  servers: StdioMcpServerSpec[] | undefined,
): Options["mcpServers"] | undefined {
  if (servers === undefined || servers.length === 0) {
    return undefined;
  }
  const mcpServers: NonNullable<Options["mcpServers"]> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      type: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
    };
  }
  return mcpServers;
}

/**
 * The ONLY module in this codebase that imports `@anthropic-ai/claude-agent-sdk`.
 * Everything else depends on `LlmClient` (see `./llm-client.ts`).
 */
export class AgentSdkLlmClient implements LlmClient {
  constructor(private readonly config: AgentSdkConfig) {}

  async runQuery(input: RunQueryInput): Promise<LlmResult> {
    const options: Options = {
      model: this.config.model,
      // Reasoning depth is controlled solely via `effort` (from Config, per
      // SPEC §9.3). Do NOT set `thinking` or the deprecated
      // `maxThinkingTokens` here: Sonnet 5 rejects an explicit manual
      // thinking budget (`thinking: { type: "enabled", budgetTokens: N }`)
      // with an HTTP 400. Omitting `thinking` lets adaptive thinking apply.
      effort: this.config.effort,
      // Sonnet 5 also rejects non-default `temperature`/`top_p`/`top_k` with
      // an HTTP 400 — the SDK's `Options` type doesn't even expose them, so
      // there is nothing to set here and nothing to omit.
      //
      // Runtime isolation (bd meal-planner-q95.10). With `settingSources`
      // UNSET the SDK loads ALL filesystem settings — the developer's
      // project/user `CLAUDE.md`, `.claude/settings.json`, etc. — into every
      // LLM call. Measured on this repo that was ~19k extra INPUT tokens per
      // call (a ~13x blowup: 21,976 → ~1,600) AND it framed the model as a
      // coding agent, derailing the clean-JSON extraction/selection these
      // calls need. Dev-machine config must never bleed into runtime
      // inference, so isolate explicitly with `[]`.
      settingSources: [],
    };

    if (input.system !== undefined) {
      options.systemPrompt = input.system;
    }

    const mcpServers = toSdkMcpServers(input.mcpServers);
    if (mcpServers !== undefined) {
      options.mcpServers = mcpServers;
    } else {
      // No MCP tools requested — this is a pure text completion (ingest
      // extraction / planner selection). Give the model NO tools so it
      // answers directly instead of reaching for the SDK's default Claude
      // Code tools (which also drops their schema tokens). When `mcpServers`
      // ARE provided (a future MCP-driven call) we leave `tools` unset so
      // those tools stay available.
      options.tools = [];
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let lastAssistantText: string | undefined;
    let finalText: string | undefined;
    // The authoritative cumulative usage from the final `result` message. The
    // streaming `assistant` turns under-report (esp. output_tokens — observed
    // as ~1 per turn regardless of the real output), so summing them
    // undercounts spend and would let the cost cap (SPEC §9.3) be bypassed.
    // We prefer this when present and fall back to the assistant sum only when
    // there is no result message at all.
    let resultUsage: { inputTokens: number; outputTokens: number } | undefined;

    // A failure can land AFTER the model has already ingested the prompt and
    // billed for some turns (rate_limit / overloaded / server_error mid-stream,
    // or a per-turn error on the very first turn). That spend is real, so any
    // throw out of this loop is wrapped in an `LlmCallError` carrying whatever
    // usage was accumulated before the throw — the sole place usage is attached
    // to a failure — so `meteredLlmClient` can still record it against the cost
    // cap (bd meal-planner-fkg.9). `usage` may be all-zero (failure before any
    // billing); recording zero is a harmless no-op.
    try {
      for await (const message of query({ prompt: input.prompt, options })) {
        if (message.type === "assistant") {
          // Accumulate this turn's usage FIRST — even a turn that carries a
          // per-turn error (`authentication_failed`, `billing_error`,
          // `rate_limit`, `overloaded`, `server_error`, etc. — see
          // `SDKAssistantMessageError` in sdk.d.ts) has already ingested input
          // and billed for it, and `message.message` is non-optional on the
          // SDK type even for an errored turn. Counting it before we throw is
          // what lets that spend ride out on the `LlmCallError`.
          //
          // `BetaMessage.usage` (and its `input_tokens`/`output_tokens`
          // fields) are non-optional on the real SDK type, so no `if (usage)`
          // guard is needed here.
          const usage = message.message.usage;
          inputTokens += usage.input_tokens;
          outputTokens += usage.output_tokens;

          // A per-turn error can appear on an assistant message even though the
          // run may still reach a final `success` result. Left uninspected,
          // that produces a silent partial failure: the turn errored, still
          // contributed usage, and the caller sees a "successful" result. We
          // abort on the FIRST per-turn error rather than accumulate, so
          // failures surface immediately and loudly. The error value is a
          // closed enum of type names (never raw credentials/secrets), so it's
          // always safe to include verbatim.
          if (message.error !== undefined) {
            throw new Error(`Claude Agent SDK turn failed: ${message.error}`);
          }

          let text = "";
          for (const block of message.message.content) {
            if (block.type === "text") {
              text += block.text;
            }
          }
          if (text.length > 0) {
            lastAssistantText = text;
          }
        } else if (message.type === "result") {
          if (message.subtype === "success") {
            finalText = message.result;
            // `SDKResultSuccess.usage` is typed non-optional, but guard the
            // field reads so a partial/older message shape falls back to the
            // assistant-sum rather than yielding NaN/undefined token counts.
            const ru = message.usage as
              | {
                  input_tokens?: number;
                  cache_creation_input_tokens?: number;
                  cache_read_input_tokens?: number;
                  output_tokens?: number;
                }
              | undefined;
            if (
              ru &&
              typeof ru.input_tokens === "number" &&
              typeof ru.output_tokens === "number"
            ) {
              // Count every input category (fresh + cache-write + cache-read):
              // the SDK prompt-caches by default, so `input_tokens` alone is
              // only the non-cached remainder. Summing keeps the cost cap
              // conservative (a slight over-estimate of $, since cache reads
              // bill cheaper, is the safe direction for a spend guard).
              resultUsage = {
                inputTokens:
                  ru.input_tokens +
                  (ru.cache_creation_input_tokens ?? 0) +
                  (ru.cache_read_input_tokens ?? 0),
                outputTokens: ru.output_tokens,
              };
            }
          } else {
            // `SDKResultError.errors` carries the actionable detail; the
            // `subtype` alone (e.g. "error_during_execution") isn't enough for
            // callers to debug what actually went wrong.
            const detail =
              message.errors.length > 0 ? `: ${message.errors.join("; ")}` : "";
            throw new Error(
              `Claude Agent SDK query failed: ${message.subtype}${detail}`,
            );
          }
        }
      }
    } catch (error) {
      // Already an `LlmCallError` (shouldn't happen from here, but keep it
      // idempotent — never wrap twice / double-attach usage): rethrow as-is.
      if (error instanceof LlmCallError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmCallError(
        message,
        // Prefer the authoritative result usage if we got that far; otherwise
        // the assistant-turn sum accumulated before the throw.
        resultUsage ?? { inputTokens, outputTokens },
        { cause: error },
      );
    }

    return {
      text: finalText ?? lastAssistantText ?? "",
      usage: resultUsage ?? { inputTokens, outputTokens },
    };
  }
}

/** Public entry point: builds the harness's `LlmClient` from app `Config`. */
export function createLlmClient(config: AgentSdkConfig): LlmClient {
  return new AgentSdkLlmClient(config);
}
