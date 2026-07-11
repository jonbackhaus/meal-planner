import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config/config.js";
import type {
  LlmClient,
  LlmResult,
  RunQueryInput,
  StdioMcpServerSpec,
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
    };

    if (input.system !== undefined) {
      options.systemPrompt = input.system;
    }

    const mcpServers = toSdkMcpServers(input.mcpServers);
    if (mcpServers !== undefined) {
      options.mcpServers = mcpServers;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let lastAssistantText: string | undefined;
    let finalText: string | undefined;

    for await (const message of query({ prompt: input.prompt, options })) {
      if (message.type === "assistant") {
        const usage = message.message.usage;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
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
        } else {
          throw new Error(`Claude Agent SDK query failed: ${message.subtype}`);
        }
      }
    }

    return {
      text: finalText ?? lastAssistantText ?? "",
      usage: { inputTokens, outputTokens },
    };
  }
}

/** Public entry point: builds the harness's `LlmClient` from app `Config`. */
export function createLlmClient(config: AgentSdkConfig): LlmClient {
  return new AgentSdkLlmClient(config);
}
