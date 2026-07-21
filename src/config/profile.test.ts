import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { resolveProfile } from "./profile.js";

function baseConfig(profile: "dev" | "prod"): Config {
  return {
    profile,
    timezone: "America/Chicago",
    triggerTime: "06:00",
    model: "claude-sonnet-5",
    effort: "medium",
    modelRates: {
      "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
    },
    cookNights: { constrained: 4, relaxed: 2 },
    activeMaxMinutes: 60,
    fanoutMultiplier: 4,
    vegFloorK: 2,
    untestedRate: 0.15,
    maxPairedSides: 2,
    generationDollarCap: 2,
    triggerTimeoutMs: 2_700_000,
    llmCallTimeoutMs: 240_000,
  };
}

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    MP_CHANNEL_ID_DEV: "C0DEV1234",
    MP_CHANNEL_ID_PROD: "C0PROD5678",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("resolveProfile", () => {
  it("resolves the dev channel ID, dev db path, and forceRegenerate=true for the dev profile", () => {
    const settings = resolveProfile(baseConfig("dev"), baseEnv());

    expect(settings).toEqual({
      profile: "dev",
      channelId: "C0DEV1234",
      sqlitePath: "./data/meal-planner.dev.sqlite",
      forceRegenerate: true,
      postMode: "post",
    });
  });

  it("resolves the prod channel ID, prod db path, and forceRegenerate=false for the prod profile", () => {
    const settings = resolveProfile(baseConfig("prod"), baseEnv());

    expect(settings).toEqual({
      profile: "prod",
      channelId: "C0PROD5678",
      sqlitePath: "./data/meal-planner.prod.sqlite",
      forceRegenerate: false,
      postMode: "post",
    });
  });

  it("throws naming the field when the active profile's channel ID is missing", () => {
    const env = baseEnv({ MP_CHANNEL_ID_DEV: undefined });

    expect(() => resolveProfile(baseConfig("dev"), env)).toThrowError(
      /channelId/i,
    );
  });

  it("throws naming the field when the active profile's channel ID is empty", () => {
    const env = baseEnv({ MP_CHANNEL_ID_PROD: "" });

    expect(() => resolveProfile(baseConfig("prod"), env)).toThrowError(
      /channelId/i,
    );
  });

  it("does not fall back to the other profile's channel ID when the active one is missing", () => {
    const env = baseEnv({ MP_CHANNEL_ID_DEV: undefined });

    expect(() => resolveProfile(baseConfig("dev"), env)).toThrowError();
    // prod's channel ID must never leak into a dev resolution
  });

  it("rejects a channel value that looks like a name rather than an explicit ID", () => {
    const env = baseEnv({ MP_CHANNEL_ID_DEV: "#dev-meal-plan" });

    expect(() => resolveProfile(baseConfig("dev"), env)).toThrowError(
      /channelId/i,
    );
  });

  it("resolves different sqlite paths for dev and prod by default", () => {
    const devSettings = resolveProfile(baseConfig("dev"), baseEnv());
    const prodSettings = resolveProfile(baseConfig("prod"), baseEnv());

    expect(devSettings.sqlitePath).not.toBe(prodSettings.sqlitePath);
  });

  it("throws when dev and prod sqlite paths resolve to the same value", () => {
    const env = baseEnv({
      MP_SQLITE_PATH_DEV: "./data/shared.sqlite",
      MP_SQLITE_PATH_PROD: "./data/shared.sqlite",
    });

    expect(() => resolveProfile(baseConfig("dev"), env)).toThrowError(
      /sqlitePath/i,
    );
  });

  it("throws when dev and prod sqlite paths differ as strings but resolve to the same file", () => {
    // "data/mp.sqlite" vs "./data/mp.sqlite" are distinct raw strings but the
    // SAME file — a raw-string compare would miss the collision SPEC §7 exists
    // to prevent (dev forceRegenerate overwriting prod rows).
    const env = baseEnv({
      MP_SQLITE_PATH_DEV: "data/mp.sqlite",
      MP_SQLITE_PATH_PROD: "./data/mp.sqlite",
    });

    expect(() => resolveProfile(baseConfig("dev"), env)).toThrowError(
      /sqlitePath/i,
    );
  });

  it("accepts genuinely different explicit sqlite paths", () => {
    const env = baseEnv({
      MP_SQLITE_PATH_DEV: "./data/dev.sqlite",
      MP_SQLITE_PATH_PROD: "./data/prod.sqlite",
    });

    expect(() => resolveProfile(baseConfig("dev"), env)).not.toThrow();
  });

  it("applies the MP_POST_MODE override to dry-run", () => {
    const env = baseEnv({ MP_POST_MODE: "dry-run" });

    const settings = resolveProfile(baseConfig("dev"), env);

    expect(settings.postMode).toBe("dry-run");
  });

  it("applies the MP_FORCE_REGENERATE override", () => {
    const env = baseEnv({ MP_FORCE_REGENERATE: "false" });

    const settings = resolveProfile(baseConfig("dev"), env);

    expect(settings.forceRegenerate).toBe(false);
  });

  it("applies MP_FORCE_REGENERATE=true override for prod", () => {
    const env = baseEnv({ MP_FORCE_REGENERATE: "true" });

    const settings = resolveProfile(baseConfig("prod"), env);

    expect(settings.forceRegenerate).toBe(true);
  });

  it("throws when MP_POST_MODE is not a valid enum value", () => {
    const env = baseEnv({ MP_POST_MODE: "publish" });

    expect(() => resolveProfile(baseConfig("dev"), env)).toThrowError(
      /postMode/i,
    );
  });

  it("aggregates multiple validation errors into a single thrown error", () => {
    const env = baseEnv({
      MP_CHANNEL_ID_DEV: undefined,
      MP_POST_MODE: "publish",
    });

    try {
      resolveProfile(baseConfig("dev"), env);
      expect.fail("expected resolveProfile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/channelId/i);
      expect(message).toMatch(/postMode/i);
    }
  });
});
