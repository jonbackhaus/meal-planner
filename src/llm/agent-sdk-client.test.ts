import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import { createLlmClient } from "./agent-sdk-client.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const queryMock = vi.mocked(query);

function baseConfig(
  overrides: Partial<Pick<Config, "model" | "effort">> = {},
): Pick<Config, "model" | "effort"> {
  return {
    model: "claude-sonnet-5",
    effort: "high",
    ...overrides,
  };
}

/** Builds a fake `Query` (the async generator `query()` returns) from plain message objects. */
function fakeQueryResult(messages: unknown[]) {
  async function* generator() {
    for (const message of messages) {
      yield message;
    }
  }
  // `Query` is `AsyncGenerator<SDKMessage, void>` plus a couple of extra
  // control methods we don't use in the harness (interrupt/setPermissionMode/etc).
  // A bare async generator satisfies everything the adapter actually calls.
  return generator() as unknown as ReturnType<typeof query>;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createLlmClient / AgentSdkLlmClient", () => {
  it("builds SDK query options carrying the config's model and effort", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([{ type: "result", subtype: "success", result: "done" }]),
    );

    const client = createLlmClient(
      baseConfig({ model: "claude-opus-4-8", effort: "xhigh" }),
    );
    await client.runQuery({ prompt: "hello" });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [{ options }] = queryMock.mock.calls[0];
    expect(options?.model).toBe("claude-opus-4-8");
    expect(options?.effort).toBe("xhigh");
  });

  it("never constructs temperature/top_p/top_k or a manual thinking budget (Sonnet 5 rejects them with HTTP 400)", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([{ type: "result", subtype: "success", result: "done" }]),
    );

    const client = createLlmClient(baseConfig());
    await client.runQuery({ prompt: "hello" });

    const [{ options }] = queryMock.mock.calls[0];
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("top_p");
    expect(options).not.toHaveProperty("topP");
    expect(options).not.toHaveProperty("top_k");
    expect(options).not.toHaveProperty("topK");
    expect(options).not.toHaveProperty("budget_tokens");
    expect(options).not.toHaveProperty("maxThinkingTokens");
    expect(options).not.toHaveProperty("thinking");
  });

  it("aggregates usage across multiple turns and returns the final result text", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "thinking..." }],
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "still going" }],
            usage: { input_tokens: 50, output_tokens: 30 },
          },
        },
        { type: "result", subtype: "success", result: "final answer" },
      ]),
    );

    const client = createLlmClient(baseConfig());
    const result = await client.runQuery({ prompt: "hello" });

    expect(result.text).toBe("final answer");
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 50 });
  });

  it("falls back to the last assistant text when no final result message is present", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "only turn" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ]),
    );

    const client = createLlmClient(baseConfig());
    const result = await client.runQuery({ prompt: "hello" });

    expect(result.text).toBe("only turn");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("translates a StdioMcpServerSpec into the SDK's MCP-server option shape", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([{ type: "result", subtype: "success", result: "done" }]),
    );

    const client = createLlmClient(baseConfig());
    await client.runQuery({
      prompt: "hello",
      mcpServers: [
        {
          name: "recipes",
          command: "/usr/bin/recipe-server",
          args: ["--stdio"],
          env: { FOO: "bar" },
        },
      ],
    });

    const [{ options }] = queryMock.mock.calls[0];
    expect(options?.mcpServers).toEqual({
      recipes: {
        type: "stdio",
        command: "/usr/bin/recipe-server",
        args: ["--stdio"],
        env: { FOO: "bar" },
      },
    });
  });

  it("passes the prompt and optional system prompt through to the SDK", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([{ type: "result", subtype: "success", result: "done" }]),
    );

    const client = createLlmClient(baseConfig());
    await client.runQuery({
      prompt: "extract this recipe",
      system: "You are a recipe extractor.",
    });

    const [{ prompt, options }] = queryMock.mock.calls[0];
    expect(prompt).toBe("extract this recipe");
    expect(options?.systemPrompt).toBe("You are a recipe extractor.");
  });

  it("omits mcpServers entirely when none are passed", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([{ type: "result", subtype: "success", result: "done" }]),
    );

    const client = createLlmClient(baseConfig());
    await client.runQuery({ prompt: "hello" });

    const [{ options }] = queryMock.mock.calls[0];
    expect(options).not.toHaveProperty("mcpServers");
  });

  it("throws when the SDK reports a non-success result", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([{ type: "result", subtype: "error_during_execution" }]),
    );

    const client = createLlmClient(baseConfig());
    await expect(client.runQuery({ prompt: "hello" })).rejects.toThrow();
  });

  it("throws immediately when an assistant turn carries a per-turn error, naming the error type and never leaking secrets", async () => {
    const secret = "sk-ant-api03-super-secret-token-should-never-appear";
    queryMock.mockReturnValue(
      fakeQueryResult([
        {
          type: "assistant",
          error: "rate_limit",
          message: {
            content: [{ type: "text", text: secret }],
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        // A per-turn error should abort before this later message is ever
        // reached (proves throw-on-first, not accumulate).
        { type: "result", subtype: "success", result: secret },
      ]),
    );

    const client = createLlmClient(baseConfig());

    let caught: unknown;
    try {
      await client.runQuery({ prompt: "hello" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/rate_limit/);
    expect(message).not.toContain(secret);
  });

  it("throws on a per-turn overloaded error too, naming the error type", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([
        {
          type: "assistant",
          error: "overloaded",
          message: {
            content: [],
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
      ]),
    );

    const client = createLlmClient(baseConfig());
    await expect(client.runQuery({ prompt: "hello" })).rejects.toThrow(
      /overloaded/,
    );
  });

  it("includes the result's errors[] detail (not just the subtype) when the final result is non-success", async () => {
    queryMock.mockReturnValue(
      fakeQueryResult([
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["upstream timeout", "connection reset"],
        },
      ]),
    );

    const client = createLlmClient(baseConfig());

    let caught: unknown;
    try {
      await client.runQuery({ prompt: "hello" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/upstream timeout/);
    expect(message).toMatch(/connection reset/);
  });
});
