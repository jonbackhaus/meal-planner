import { execFile as execFileCallback } from "node:child_process";

/**
 * Environment variables read by loadSecrets.
 *
 * - OP_SERVICE_ACCOUNT_TOKEN     -> (1Password, external) presence auto-selects
 *   the "1password" source; passed through unmodified in the child env given
 *   to the `op` CLI.
 * - OP_CONNECT_HOST              -> (1Password Connect, external) MUST be
 *   absent from the child env passed to `op` when using a service account —
 *   Connect vars take precedence over OP_SERVICE_ACCOUNT_TOKEN and would
 *   silently redirect auth.
 * - OP_CONNECT_TOKEN             -> same as OP_CONNECT_HOST.
 * - MP_OP_SLACK_TOKEN_REF        -> op:// reference for the Slack bot token
 *   (e.g. "op://vault/item/field"), read via `op read` on the 1Password path.
 * - MP_OP_ANTHROPIC_KEY_REF      -> op:// reference for the Anthropic API key,
 *   read via `op read` on the 1Password path.
 * - MP_SLACK_BOT_TOKEN           -> Slack bot token (xoxb-…), read directly on
 *   the env-fallback path (sourced from a chmod-600 env file by ops tooling;
 *   this module only reads the resulting env var).
 * - MP_ANTHROPIC_API_KEY         -> Anthropic API key, read directly on the
 *   env-fallback path.
 *
 * NOTE (handoff, out of scope here): wiring anthropicApiKey into
 * process.env.ANTHROPIC_API_KEY for the Agent SDK harness is done by the
 * daemon bootstrap, not this module.
 *
 * v1.0 loads only these two secrets (SPEC §9.1). The Slack app-level token
 * (xapp-…) is a v3.0 addition and is intentionally NOT loaded here.
 */

/** Fully-resolved, validated boot secrets. */
export interface Secrets {
  slackBotToken: string;
  anthropicApiKey: string;
}

export type SecretSource = "1password" | "env";

export interface LoadSecretsOptions {
  /** Force a source; if omitted, auto-detects (see loadSecrets). */
  source?: SecretSource;
  env?: NodeJS.ProcessEnv;
}

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function execFile(
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args as string[], options, ((
      error,
      stdout,
      stderr,
    ) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    }) as ExecFileCallback);
  });
}

function formatErrors(errors: string[]): string {
  const lines = errors.map((message) => ` - ${message}`);
  return `Invalid secrets:\n${lines.join("\n")}`;
}

function detectSource(env: NodeJS.ProcessEnv): SecretSource {
  return env.OP_SERVICE_ACCOUNT_TOKEN ? "1password" : "env";
}

/**
 * Builds the child env passed to the `op` CLI: the given env plus
 * OP_CONNECT_HOST/OP_CONNECT_TOKEN removed, since those Connect vars take
 * precedence over OP_SERVICE_ACCOUNT_TOKEN and would break non-interactive
 * service-account auth if left in place.
 */
function buildOpChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.OP_CONNECT_HOST;
  delete childEnv.OP_CONNECT_TOKEN;
  return childEnv;
}

interface OpFieldSpec {
  field: keyof Secrets;
  refEnvVar: "MP_OP_SLACK_TOKEN_REF" | "MP_OP_ANTHROPIC_KEY_REF";
}

const OP_FIELD_SPECS: readonly OpFieldSpec[] = [
  { field: "slackBotToken", refEnvVar: "MP_OP_SLACK_TOKEN_REF" },
  { field: "anthropicApiKey", refEnvVar: "MP_OP_ANTHROPIC_KEY_REF" },
];

async function loadFromOnePassword(env: NodeJS.ProcessEnv): Promise<Secrets> {
  const missingRefErrors: string[] = [];
  const refs: Partial<Record<keyof Secrets, string>> = {};

  for (const spec of OP_FIELD_SPECS) {
    const ref = env[spec.refEnvVar];
    if (!ref) {
      missingRefErrors.push(
        `${spec.field}: ${spec.refEnvVar} is required (op:// reference for this secret)`,
      );
      continue;
    }
    refs[spec.field] = ref;
  }

  if (missingRefErrors.length > 0) {
    throw new Error(formatErrors(missingRefErrors));
  }

  const childEnv = buildOpChildEnv(env);

  const results = await Promise.allSettled(
    OP_FIELD_SPECS.map((spec) =>
      execFile("op", ["read", refs[spec.field] as string], {
        env: childEnv,
      }),
    ),
  );

  const errors: string[] = [];
  const values: Partial<Record<keyof Secrets, string>> = {};

  results.forEach((result, index) => {
    const spec = OP_FIELD_SPECS[index] as OpFieldSpec;
    if (result.status === "rejected") {
      // Deliberately do NOT include the raw error's message/stderr here: it
      // originates from the `op` CLI's child process and must never be
      // trusted to be free of sensitive content. Only the (non-secret) op://
      // reference is safe to surface.
      errors.push(
        `${spec.field}: op read failed for ${refs[spec.field]} (see 1Password service account permissions/logs)`,
      );
      return;
    }
    const value = result.value.stdout.trim();
    if (!value) {
      errors.push(`${spec.field}: op read returned an empty value`);
      return;
    }
    values[spec.field] = value;
  });

  if (errors.length > 0) {
    throw new Error(formatErrors(errors));
  }

  return {
    slackBotToken: values.slackBotToken as string,
    anthropicApiKey: values.anthropicApiKey as string,
  };
}

function loadFromEnv(env: NodeJS.ProcessEnv): Secrets {
  const errors: string[] = [];

  const slackBotToken = env.MP_SLACK_BOT_TOKEN;
  if (!slackBotToken) {
    errors.push("slackBotToken: MP_SLACK_BOT_TOKEN is required");
  }

  const anthropicApiKey = env.MP_ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    errors.push("anthropicApiKey: MP_ANTHROPIC_API_KEY is required");
  }

  if (errors.length > 0) {
    throw new Error(formatErrors(errors));
  }

  return {
    slackBotToken: slackBotToken as string,
    anthropicApiKey: anthropicApiKey as string,
  };
}

/**
 * Loads the daemon's boot secrets (Slack bot token, Anthropic API key).
 *
 * Source selection: if `opts.source` is unset, auto-detects — "1password"
 * when OP_SERVICE_ACCOUNT_TOKEN is present in env, else "env" fallback.
 *
 * Both secrets must be present and non-empty regardless of source; any
 * missing/failed field is aggregated into a single thrown Error. A secret
 * VALUE never appears in a thrown error or log message.
 */
export async function loadSecrets(
  opts: LoadSecretsOptions = {},
): Promise<Secrets> {
  const env = opts.env ?? process.env;
  const source = opts.source ?? detectSource(env);

  if (source === "1password") {
    return loadFromOnePassword(env);
  }
  return loadFromEnv(env);
}
