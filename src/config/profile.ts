import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";

/**
 * Environment variable names read by resolveProfile, namespaced under `MP_`.
 *
 * - MP_CHANNEL_ID_DEV / MP_CHANNEL_ID_PROD -> channelId (per-profile, REQUIRED
 *   for the active profile; must be an explicit Slack channel ID, never a
 *   `#name`-style lookup, so a test run can never resolve to the prod channel)
 * - MP_SQLITE_PATH_DEV / MP_SQLITE_PATH_PROD -> sqlitePath (per-profile;
 *   defaults to ./data/meal-planner.<profile>.sqlite; dev and prod MUST
 *   resolve to different paths)
 * - MP_FORCE_REGENERATE -> forceRegenerate override (true/false; default:
 *   dev=true, prod=false)
 * - MP_POST_MODE -> postMode override ("post" | "dry-run"; default: "post")
 *
 * See SPEC §7: dev and prod share the same Slack workspace/app/bot token, so
 * isolation between them is only as strong as this profile bundle. This
 * module only RESOLVES and VALIDATES the settings; it does not open SQLite,
 * post to Slack, or load secrets.
 */

const CHANNEL_ID_ERROR =
  "must be an explicit Slack channel ID (non-empty, not a #name-style lookup)";

const postModeSchema = z.enum(["post", "dry-run"]);

export type PostMode = z.infer<typeof postModeSchema>;

export interface ProfileSettings {
  profile: "dev" | "prod";
  /** Explicit Slack channel ID for the active profile. */
  channelId: string;
  /** Per-profile SQLite database file path. */
  sqlitePath: string;
  /** Whether to bypass the week-keyed idempotency guard. Default: dev=true, prod=false. */
  forceRegenerate: boolean;
  /** Whether to actually post to Slack ("post") or just render/log ("dry-run"). Default: "post". */
  postMode: PostMode;
}

function isValidChannelId(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  // Reject obvious name-style lookups (e.g. "#dev-meal-plan").
  return !value.startsWith("#");
}

function defaultSqlitePath(profile: "dev" | "prod"): string {
  return `./data/meal-planner.${profile}.sqlite`;
}

function defaultForceRegenerate(profile: "dev" | "prod"): boolean {
  return profile === "dev";
}

function parseOptionalBoolean(
  value: string | undefined,
  fieldName: string,
  errors: string[],
): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  errors.push(`${fieldName}: must be "true" or "false" (got "${value}")`);
  return undefined;
}

function formatErrors(errors: string[]): string {
  const lines = errors.map((message) => ` - ${message}`);
  return `Invalid profile settings:\n${lines.join("\n")}`;
}

/**
 * Resolves and validates the bundle of dev/prod-sensitive settings (channel
 * ID, SQLite path, forceRegenerate default, post mode) for the profile named
 * by `config.profile`. Throws a single aggregated Error naming every
 * offending field if any value is missing or invalid.
 */
export function resolveProfile(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): ProfileSettings {
  const { profile } = config;
  const errors: string[] = [];

  const channelIdEnvVar =
    profile === "dev" ? "MP_CHANNEL_ID_DEV" : "MP_CHANNEL_ID_PROD";
  const rawChannelId = env[channelIdEnvVar];
  let channelId = "";
  if (rawChannelId === undefined || rawChannelId === "") {
    errors.push(
      `channelId: ${channelIdEnvVar} is required (${CHANNEL_ID_ERROR})`,
    );
  } else if (!isValidChannelId(rawChannelId)) {
    errors.push(
      `channelId: ${channelIdEnvVar} "${rawChannelId}" is invalid: ${CHANNEL_ID_ERROR}`,
    );
  } else {
    channelId = rawChannelId;
  }

  const devSqlitePath = env.MP_SQLITE_PATH_DEV || defaultSqlitePath("dev");
  const prodSqlitePath = env.MP_SQLITE_PATH_PROD || defaultSqlitePath("prod");
  // Compare ABSOLUTE resolved paths, not the raw strings: "data/mp.sqlite" and
  // "./data/mp.sqlite" are different strings but the SAME file on disk, and a
  // dev `forceRegenerate` run pointed at that shared file would overwrite prod
  // rows — the exact collision SPEC §7's path separation exists to prevent.
  if (resolve(devSqlitePath) === resolve(prodSqlitePath)) {
    errors.push(
      `sqlitePath: dev and prod must resolve to different SQLite paths (both resolved to "${resolve(devSqlitePath)}")`,
    );
  }
  const sqlitePath = profile === "dev" ? devSqlitePath : prodSqlitePath;

  const forceRegenerateOverride = parseOptionalBoolean(
    env.MP_FORCE_REGENERATE,
    "forceRegenerate",
    errors,
  );
  const forceRegenerate =
    forceRegenerateOverride ?? defaultForceRegenerate(profile);

  let postMode: PostMode = "post";
  const rawPostMode = env.MP_POST_MODE;
  if (rawPostMode !== undefined && rawPostMode !== "") {
    const result = postModeSchema.safeParse(rawPostMode);
    if (!result.success) {
      errors.push(
        `postMode: MP_POST_MODE "${rawPostMode}" is invalid: must be "post" or "dry-run"`,
      );
    } else {
      postMode = result.data;
    }
  }

  if (errors.length > 0) {
    throw new Error(formatErrors(errors));
  }

  return {
    profile,
    channelId,
    sqlitePath,
    forceRegenerate,
    postMode,
  };
}
