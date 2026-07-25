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
 * - MP_TODOIST_PROJECT_ID_DEV / MP_TODOIST_PROJECT_ID_PROD -> todoist.projectId
 *   (per-profile, ADR-0006 D3; mirrors the channel-ID discipline — an explicit
 *   project id, dev and prod may differ. OPTIONAL for now: no code reads this
 *   yet, so it defaults to "" rather than failing boot; the v3.0 commit
 *   consumer should treat an empty projectId as misconfiguration.)
 * - MP_TODOIST_TITLE_TEMPLATE -> todoist.titleTemplate (single value shared by
 *   both profiles; default: "{title}", i.e. the recipe title verbatim)
 * - MP_TODOIST_RECIPE_LINK_FORMAT -> todoist.recipeLinkFormat (single value
 *   shared by both profiles; optional link line prepended to a committed
 *   task's description; default: "" (omitted))
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

// ADR-0006 D2 — the `mp:rid=<recipe_id>` marker embedded in a committed Todoist
// task's description, and its parse regex. A single definition here so the
// v3.0 commit path (composes it) and the recency read (parses it back) never
// duplicate the marker string. Not env-configurable: this is a fixed contract,
// not a per-deployment setting.
export const TODOIST_RID_MARKER_PREFIX = "mp:rid=";
export const TODOIST_RID_MARKER_REGEX = /\bmp:rid=([A-Za-z0-9_-]+)\b/;

/** Composes the `mp:rid=<recipe_id>` marker for a committed task's description. */
export function composeTodoistRidMarker(recipeId: string): string {
  return `${TODOIST_RID_MARKER_PREFIX}${recipeId}`;
}

/** Parses a task description back to its exact recipe id, or undefined if absent. */
export function parseTodoistRidMarker(description: string): string | undefined {
  return description.match(TODOIST_RID_MARKER_REGEX)?.[1];
}

// ADR-0006 D3 — the v3.0 Todoist-commit config section (exact strings are
// config, not fixed by the ADR). No commit code reads this yet (C2); this
// module only resolves and validates the values.
export interface TodoistCommitConfig {
  /** Target Todoist project id for committed meal tasks. Per-profile; "" until configured. */
  projectId: string;
  /** Template for a task's title from a recipe. Default: "{title}" (the recipe title verbatim). */
  titleTemplate: string;
  /** Optional link line prepended to a task's description, before the `mp:rid=` marker. Default: "" (omitted). */
  recipeLinkFormat: string;
}

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
  /** v3.0 Todoist-commit config (ADR-0006 D3). */
  todoist: TodoistCommitConfig;
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
 * ID, SQLite path, forceRegenerate default, post mode, Todoist-commit config)
 * for the profile named by `config.profile`. Throws a single aggregated Error
 * naming every offending field if any value is missing or invalid.
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

  const todoistProjectIdEnvVar =
    profile === "dev"
      ? "MP_TODOIST_PROJECT_ID_DEV"
      : "MP_TODOIST_PROJECT_ID_PROD";
  const projectId = env[todoistProjectIdEnvVar] || "";
  const titleTemplate = env.MP_TODOIST_TITLE_TEMPLATE || "{title}";
  const recipeLinkFormat = env.MP_TODOIST_RECIPE_LINK_FORMAT || "";

  if (errors.length > 0) {
    throw new Error(formatErrors(errors));
  }

  return {
    profile,
    channelId,
    sqlitePath,
    forceRegenerate,
    postMode,
    todoist: {
      projectId,
      titleTemplate,
      recipeLinkFormat,
    },
  };
}
