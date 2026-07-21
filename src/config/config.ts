import { z } from "zod";

/**
 * Environment variable names read by loadConfig, namespaced under `MP_`.
 *
 * - MP_PROFILE                    -> profile ("dev" | "prod")
 * - MP_TIMEZONE                   -> timezone (IANA zone, REQUIRED)
 * - MP_TRIGGER_TIME               -> triggerTime ("HH:MM" 24h, REQUIRED)
 * - MP_MODEL                      -> model
 * - MP_EFFORT                     -> effort ("low" | "medium" | "high" | "xhigh")
 * - MP_COOK_NIGHTS_CONSTRAINED    -> cookNights.constrained
 * - MP_COOK_NIGHTS_RELAXED        -> cookNights.relaxed
 * - MP_ACTIVE_MAX_MINUTES         -> activeMaxMinutes
 * - MP_FANOUT_MULTIPLIER          -> fanoutMultiplier
 * - MP_VEG_FLOOR_K                -> vegFloorK
 * - MP_UNTESTED_RATE              -> untestedRate
 * - MP_MAX_PAIRED_SIDES          -> maxPairedSides
 * - MP_GENERATION_DOLLAR_CAP      -> generationDollarCap
 * - MP_STALE_SYNC_THRESHOLD       -> staleSyncThreshold
 * - MP_TRIGGER_TIMEOUT_MS         -> triggerTimeoutMs
 * - MP_LLM_CALL_TIMEOUT_MS        -> llmCallTimeoutMs
 * - MP_HEALTHCHECK_URL            -> healthcheckUrl (OPTIONAL; unset/empty = disabled)
 *
 * `modelRates` is not env-configurable (it's a map); it is seeded here with
 * SPEC §9.3 intro-pricing values and can be edited in code when pricing changes.
 *
 * Secrets (Slack token, Anthropic key, etc.) are explicitly OUT OF SCOPE here
 * (see task 7js.3) and must never be read or held by this module.
 */

const IANA_TIMEZONE_ERROR =
  "must be a valid IANA timezone (e.g. America/Chicago)";
const TRIGGER_TIME_ERROR = "must be a 24h HH:MM time (e.g. 06:00)";

function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

const modelRateSchema = z.object({
  inputPerMTok: z.number().positive(),
  outputPerMTok: z.number().positive(),
});

const DEFAULT_MODEL_RATES: Record<
  string,
  { inputPerMTok: number; outputPerMTok: number }
> = Object.freeze({
  "claude-sonnet-5": Object.freeze({ inputPerMTok: 2, outputPerMTok: 10 }),
  "claude-opus-4-8": Object.freeze({ inputPerMTok: 5, outputPerMTok: 25 }),
});

const configSchema = z
  .object({
    profile: z.enum(["dev", "prod"]).default("prod"),
    timezone: z
      .string({ error: "timezone is required" })
      .min(1, "timezone is required")
      .superRefine((timezone, ctx) => {
        if (!isValidIanaTimezone(timezone)) {
          ctx.addIssue({
            code: "custom",
            message: `timezone "${timezone}" is invalid: ${IANA_TIMEZONE_ERROR}`,
          });
        }
      }),
    triggerTime: z
      .string({ error: "triggerTime is required" })
      .superRefine((triggerTime, ctx) => {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(triggerTime)) {
          ctx.addIssue({
            code: "custom",
            message: `triggerTime "${triggerTime}" is invalid: ${TRIGGER_TIME_ERROR}`,
          });
        }
      }),
    model: z.string().default("claude-sonnet-5"),
    effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
    modelRates: z
      .record(z.string(), modelRateSchema)
      .default(DEFAULT_MODEL_RATES),
    cookNights: z.preprocess(
      (value) => value ?? {},
      z.object({
        constrained: z
          .number()
          .int("cookNights.constrained must be a positive integer")
          .positive("cookNights.constrained must be a positive integer")
          .default(4),
        relaxed: z
          .number()
          .int("cookNights.relaxed must be a positive integer")
          .positive("cookNights.relaxed must be a positive integer")
          .default(2),
      }),
    ),
    activeMaxMinutes: z
      .number()
      .positive("activeMaxMinutes must be a positive number")
      .default(60),
    fanoutMultiplier: z
      .number()
      .positive("fanoutMultiplier must be a positive number")
      .default(4),
    vegFloorK: z
      .number()
      .int("vegFloorK must be a non-negative integer")
      .nonnegative("vegFloorK must be a non-negative integer")
      .default(2),
    untestedRate: z
      .number()
      .min(0, "untestedRate must be between 0 and 1")
      .max(1, "untestedRate must be between 0 and 1")
      .default(0.15),
    // Hard ceiling on paired side dishes per week (bd meal-planner-8zs.8). The
    // selection prompt steers toward 0-1 typically; validation enforces this as
    // a HARD cap. 0 disables side pairing entirely. Default 2 (mirrors
    // DEFAULT_MAX_PAIRED_SIDES in planner/pools.ts).
    maxPairedSides: z
      .number()
      .int("maxPairedSides must be a non-negative integer")
      .nonnegative("maxPairedSides must be a non-negative integer")
      .default(2),
    generationDollarCap: z
      .number()
      .positive("generationDollarCap must be a positive number")
      .default(2),
    // Threshold (count of stale notes) above which the daemon SKIPS its inline
    // pre-generation recipe sync in favor of alerting + planning against the
    // existing index (bd meal-planner-a9e). Sync is normally hash-gated and
    // cheap, but a mass hash-invalidation (a note-reader/hash change, or a long
    // Notes outage) can leave hundreds of notes stale; re-embedding +
    // re-extracting each SEQUENTIALLY (~10-34s LLM call each) inline would trip
    // `generationDollarCap` and/or blow past `triggerTimeoutMs`, failing the
    // week. Default 50 is comfortably above a normal week's incremental drift
    // (a handful of edited recipes) but well below a mass-invalidation event
    // (hundreds) — tune per corpus size.
    staleSyncThreshold: z
      .number()
      .int("staleSyncThreshold must be a non-negative integer")
      .nonnegative("staleSyncThreshold must be a non-negative integer")
      .default(50),
    // Watchdog cap for a single weekly trigger run (bd meal-planner-bd6.11).
    // If `onTrigger` (sync -> generate -> post) hangs past this, the Scheduler
    // stops WAITING on it (releasing its re-entrant `busy` flag so future
    // Sundays still fire) and ALERTS — alert-only, no state change, since the
    // post window is undecidable (same rationale as startup catch-up D4).
    // Generous by design: a real weekly run is minutes; this only trips on a
    // genuine hang (blocked macOS Automation dialog, stalled SDK subprocess,
    // wedged Slack call). Default 45 min.
    triggerTimeoutMs: z
      .number()
      .positive("triggerTimeoutMs must be a positive number")
      .default(45 * 60 * 1000),
    // Per-call watchdog for a single `LlmClient.runQuery` (bd meal-planner-qjk).
    // During a transient API rough patch the SDK subprocess can keep
    // reconnecting/retrying and never yield a terminal message -- `runQuery`
    // then neither resolves nor throws, and the ONLY backstop left is
    // `triggerTimeoutMs` above (up to 45 min of silent hang per call). This
    // must stay << triggerTimeoutMs so a wedged call fails fast and surfaces
    // via the existing failed+alert path long before the whole-trigger
    // watchdog would even notice. Default 4 min: generous for a real slow
    // turn, short enough to distinguish "slow" from "wedged".
    llmCallTimeoutMs: z
      .number()
      .positive("llmCallTimeoutMs must be a positive number")
      .default(4 * 60 * 1000),
    // External dead-man switch (bd meal-planner-fkg.8, SPEC §9.4). When set,
    // the daemon pings this healthchecks.io-style URL on each successful weekly
    // trigger (and its `<url>/fail` sub-path on a caught generation failure) so
    // something OUTSIDE the daemon alerts if a ping is missed -- the internal
    // alert channel lives inside the thing that died. OPTIONAL: unset/empty
    // disables the feature entirely (no ping is ever made). Mildly sensitive
    // (the path is a shared secret), so it is never logged in full.
    healthcheckUrl: z.url("healthcheckUrl must be a valid URL").optional(),
  })
  .strict();

/** Fully-typed, validated application configuration. */
export type Config = z.infer<typeof configSchema>;

export type Profile = Config["profile"];
export type Effort = Config["effort"];
export type ModelRate = Config["modelRates"][string];
export type CookNights = Config["cookNights"];

/** Loosely-typed candidate object accepted by validateConfig, prior to schema validation. */
export type RawConfigInput = Record<string, unknown>;

function formatZodError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return ` - ${path}: ${issue.message}`;
  });
  return `Invalid configuration:\n${lines.join("\n")}`;
}

/**
 * Boot-validation entry point: validates a raw candidate config object against
 * the schema and returns a fully-typed Config, or throws a single aggregated
 * Error naming every offending field.
 */
export function validateConfig(raw: RawConfigInput): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  return result.data;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return Number(value);
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

/**
 * Reads MP_-namespaced environment variables, builds a raw candidate config,
 * and validates it via validateConfig. Throws a clear aggregated error on
 * invalid/missing values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: RawConfigInput = {
    profile: env.MP_PROFILE,
    timezone: env.MP_TIMEZONE,
    triggerTime: env.MP_TRIGGER_TIME,
    model: env.MP_MODEL,
    effort: env.MP_EFFORT,
    cookNights: {
      constrained: optionalNumber(env.MP_COOK_NIGHTS_CONSTRAINED),
      relaxed: optionalNumber(env.MP_COOK_NIGHTS_RELAXED),
    },
    activeMaxMinutes: optionalNumber(env.MP_ACTIVE_MAX_MINUTES),
    fanoutMultiplier: optionalNumber(env.MP_FANOUT_MULTIPLIER),
    vegFloorK: optionalNumber(env.MP_VEG_FLOOR_K),
    untestedRate: optionalNumber(env.MP_UNTESTED_RATE),
    maxPairedSides: optionalNumber(env.MP_MAX_PAIRED_SIDES),
    generationDollarCap: optionalNumber(env.MP_GENERATION_DOLLAR_CAP),
    staleSyncThreshold: optionalNumber(env.MP_STALE_SYNC_THRESHOLD),
    triggerTimeoutMs: optionalNumber(env.MP_TRIGGER_TIMEOUT_MS),
    llmCallTimeoutMs: optionalNumber(env.MP_LLM_CALL_TIMEOUT_MS),
    healthcheckUrl: optionalString(env.MP_HEALTHCHECK_URL),
  };

  return validateConfig(raw);
}
