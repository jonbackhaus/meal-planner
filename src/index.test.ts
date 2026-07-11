import { afterEach, describe, expect, it } from "vitest";
import { applySecretsToEnv } from "./index.js";
import type { Secrets } from "./secrets/secrets.js";

const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  // Never let a test-injected key leak into other tests.
  if (ORIGINAL_ANTHROPIC_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  }
});

function fakeSecrets(): Secrets {
  return {
    slackBotToken: "xoxb-fake",
    anthropicApiKey: "sk-ant-fake-test-value",
  };
}

describe("applySecretsToEnv", () => {
  it("wires the loaded Anthropic API key into process.env.ANTHROPIC_API_KEY by default", () => {
    delete process.env.ANTHROPIC_API_KEY;

    applySecretsToEnv(fakeSecrets());

    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-fake-test-value");
  });

  it("writes into an injected env object instead of the real process.env when one is given", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const env: NodeJS.ProcessEnv = {};

    applySecretsToEnv(fakeSecrets(), env);

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fake-test-value");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
