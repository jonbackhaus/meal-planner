import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSecrets } from "./secrets.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

/** Configures the mocked execFile to resolve `op read <ref>` calls from a ref->stdout map. */
function mockOpSuccess(responses: Record<string, string>) {
  mockedExecFile.mockImplementation(((
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    const ref = args[1] as string;
    const stdout = responses[ref];
    if (stdout === undefined) {
      callback(new Error(`unmocked op read ref: ${ref}`), "", "");
      return;
    }
    callback(null, stdout, "");
    return undefined;
  }) as unknown as typeof execFile);
}

/** Configures the mocked execFile so every `op read` call fails, as if `op` exited non-zero. */
function mockOpFailure(message: string) {
  mockedExecFile.mockImplementation(((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    callback(new Error(message), "", message);
    return undefined;
  }) as unknown as typeof execFile);
}

function baseOpEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    OP_SERVICE_ACCOUNT_TOKEN: "ops_fake_service_account_token",
    MP_OP_SLACK_TOKEN_REF: "op://vault/slack-item/token",
    MP_OP_ANTHROPIC_KEY_REF: "op://vault/anthropic-item/key",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function baseEnvFallback(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    MP_SLACK_BOT_TOKEN: "xoxb-real-slack-token",
    MP_ANTHROPIC_API_KEY: "sk-ant-real-anthropic-key",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

afterEach(() => {
  mockedExecFile.mockReset();
});

describe("loadSecrets", () => {
  it("auto-detects the 1Password source when OP_SERVICE_ACCOUNT_TOKEN is set", async () => {
    mockOpSuccess({
      "op://vault/slack-item/token": "xoxb-abc123\n",
      "op://vault/anthropic-item/key": "sk-ant-xyz789\n",
    });

    const secrets = await loadSecrets({ env: baseOpEnv() });

    expect(secrets).toEqual({
      slackBotToken: "xoxb-abc123",
      anthropicApiKey: "sk-ant-xyz789",
    });
    expect(mockedExecFile).toHaveBeenCalled();
  });

  it("auto-detects the env fallback source when OP_SERVICE_ACCOUNT_TOKEN is unset", async () => {
    const secrets = await loadSecrets({ env: baseEnvFallback() });

    expect(secrets).toEqual({
      slackBotToken: "xoxb-real-slack-token",
      anthropicApiKey: "sk-ant-real-anthropic-key",
    });
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("calls `op read` with the exact refs from env and trims the returned tokens", async () => {
    mockOpSuccess({
      "op://vault/slack-item/token": "xoxb-abc123\n",
      "op://vault/anthropic-item/key": "sk-ant-xyz789\n",
    });

    const secrets = await loadSecrets({
      source: "1password",
      env: baseOpEnv(),
    });

    expect(secrets).toEqual({
      slackBotToken: "xoxb-abc123",
      anthropicApiKey: "sk-ant-xyz789",
    });
    expect(mockedExecFile).toHaveBeenCalledWith(
      "op",
      ["read", "op://vault/slack-item/token"],
      expect.anything(),
      expect.any(Function),
    );
    expect(mockedExecFile).toHaveBeenCalledWith(
      "op",
      ["read", "op://vault/anthropic-item/key"],
      expect.anything(),
      expect.any(Function),
    );
  });

  it("removes OP_CONNECT_HOST and OP_CONNECT_TOKEN from the child env passed to op", async () => {
    mockOpSuccess({
      "op://vault/slack-item/token": "xoxb-abc123\n",
      "op://vault/anthropic-item/key": "sk-ant-xyz789\n",
    });

    await loadSecrets({
      source: "1password",
      env: baseOpEnv({
        OP_CONNECT_HOST: "https://connect.example.com",
        OP_CONNECT_TOKEN: "connect-secret-token",
      }),
    });

    expect(mockedExecFile.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockedExecFile.mock.calls) {
      const options = call[2] as { env?: NodeJS.ProcessEnv };
      expect(options.env?.OP_CONNECT_HOST).toBeUndefined();
      expect(options.env?.OP_CONNECT_TOKEN).toBeUndefined();
      expect(options.env?.OP_SERVICE_ACCOUNT_TOKEN).toBe(
        "ops_fake_service_account_token",
      );
    }
  });

  it("throws when op exits non-zero, without leaking the service account token", async () => {
    mockOpFailure(
      "op: [ERROR] 2026/07/11 could not read secret: ops_fake_service_account_token rejected",
    );

    let thrown: Error | undefined;
    try {
      await loadSecrets({ source: "1password", env: baseOpEnv() });
      expect.fail("expected loadSecrets to throw");
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain("ops_fake_service_account_token");
  });

  it("returns the two env-var values on the env fallback path", async () => {
    const secrets = await loadSecrets({
      source: "env",
      env: baseEnvFallback(),
    });

    expect(secrets).toEqual({
      slackBotToken: "xoxb-real-slack-token",
      anthropicApiKey: "sk-ant-real-anthropic-key",
    });
  });

  it("aggregates both missing secrets into a single thrown error on the env path", async () => {
    const env = baseEnvFallback({
      MP_SLACK_BOT_TOKEN: undefined,
      MP_ANTHROPIC_API_KEY: undefined,
    });

    try {
      await loadSecrets({ source: "env", env });
      expect.fail("expected loadSecrets to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/slackBotToken/i);
      expect(message).toMatch(/anthropicApiKey/i);
    }
  });

  it("throws naming the field when only one env-fallback secret is missing", async () => {
    const env = baseEnvFallback({ MP_SLACK_BOT_TOKEN: undefined });

    await expect(loadSecrets({ source: "env", env })).rejects.toThrow(
      /slackBotToken/i,
    );
  });

  it("throws a clear error when a `op://` ref env var is missing, without calling op", async () => {
    const env = baseOpEnv({ MP_OP_SLACK_TOKEN_REF: undefined });

    await expect(loadSecrets({ source: "1password", env })).rejects.toThrow(
      /MP_OP_SLACK_TOKEN_REF/,
    );
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("aggregates both missing `op://` ref env vars into a single thrown error", async () => {
    const env = baseOpEnv({
      MP_OP_SLACK_TOKEN_REF: undefined,
      MP_OP_ANTHROPIC_KEY_REF: undefined,
    });

    try {
      await loadSecrets({ source: "1password", env });
      expect.fail("expected loadSecrets to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/MP_OP_SLACK_TOKEN_REF/);
      expect(message).toMatch(/MP_OP_ANTHROPIC_KEY_REF/);
    }
  });

  it("throws when op read succeeds but returns an empty value", async () => {
    mockOpSuccess({
      "op://vault/slack-item/token": "",
      "op://vault/anthropic-item/key": "sk-ant-xyz789\n",
    });

    await expect(
      loadSecrets({ source: "1password", env: baseOpEnv() }),
    ).rejects.toThrow(/slackBotToken/i);
  });
});
