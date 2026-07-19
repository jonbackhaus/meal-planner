import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    MP_TIMEZONE: "America/Chicago",
    MP_TRIGGER_TIME: "06:00",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("loads a fully-typed Config with defaults applied when given valid required env", () => {
    const config = loadConfig(validEnv());

    expect(config).toEqual({
      profile: "prod",
      timezone: "America/Chicago",
      triggerTime: "06:00",
      model: "claude-sonnet-5",
      effort: "medium",
      modelRates: {
        "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
        "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
      },
      cookNights: { constrained: 4, relaxed: 2 },
      activeMaxMinutes: 60,
      fanoutMultiplier: 4,
      vegFloorK: 2,
      untestedRate: 0.15,
      generationDollarCap: 2,
      triggerTimeoutMs: 2_700_000,
    });
  });

  it("applies a MP_TRIGGER_TIMEOUT_MS override", () => {
    const config = loadConfig(validEnv({ MP_TRIGGER_TIMEOUT_MS: "600000" }));

    expect(config.triggerTimeoutMs).toBe(600_000);
  });

  it("throws when triggerTimeoutMs is not a positive number", () => {
    const env = validEnv({ MP_TRIGGER_TIMEOUT_MS: "0" });

    expect(() => loadConfig(env)).toThrowError(/triggerTimeoutMs/i);
  });

  it("applies overrides for profile, model, and effort from env", () => {
    const config = loadConfig(
      validEnv({
        MP_PROFILE: "dev",
        MP_MODEL: "claude-opus-4-8",
        MP_EFFORT: "high",
      }),
    );

    expect(config.profile).toBe("dev");
    expect(config.model).toBe("claude-opus-4-8");
    expect(config.effort).toBe("high");
  });

  it("throws naming the field when timezone is missing", () => {
    const env = validEnv({ MP_TIMEZONE: undefined });

    expect(() => loadConfig(env)).toThrowError(/timezone/i);
  });

  it("throws naming the field when triggerTime is missing", () => {
    const env = validEnv({ MP_TRIGGER_TIME: undefined });

    expect(() => loadConfig(env)).toThrowError(/triggerTime/i);
  });

  it("throws naming the bad value when timezone is not a real IANA zone", () => {
    const env = validEnv({ MP_TIMEZONE: "Not/AZone" });

    expect(() => loadConfig(env)).toThrowError(/Not\/AZone/);
  });

  it("throws when triggerTime is not HH:MM 24h format", () => {
    const env = validEnv({ MP_TRIGGER_TIME: "6:00am" });

    expect(() => loadConfig(env)).toThrowError(/triggerTime/i);
  });

  it("leaves healthcheckUrl unset when MP_HEALTHCHECK_URL is absent or empty", () => {
    expect(loadConfig(validEnv()).healthcheckUrl).toBeUndefined();
    expect(
      loadConfig(validEnv({ MP_HEALTHCHECK_URL: "" })).healthcheckUrl,
    ).toBeUndefined();
  });

  it("reads healthcheckUrl from MP_HEALTHCHECK_URL when set", () => {
    const config = loadConfig(
      validEnv({ MP_HEALTHCHECK_URL: "https://hc-ping.com/abc-123" }),
    );

    expect(config.healthcheckUrl).toBe("https://hc-ping.com/abc-123");
  });

  it("throws when MP_HEALTHCHECK_URL is not a valid URL", () => {
    expect(() =>
      loadConfig(validEnv({ MP_HEALTHCHECK_URL: "not-a-url" })),
    ).toThrowError(/healthcheckUrl/i);
  });

  it("throws when untestedRate is out of the [0,1] range", () => {
    const env = validEnv({ MP_UNTESTED_RATE: "1.5" });

    expect(() => loadConfig(env)).toThrowError(/untestedRate/i);
  });

  it("throws when a cook-nights value is not an integer", () => {
    const env = validEnv({ MP_COOK_NIGHTS_CONSTRAINED: "4.5" });

    expect(() => loadConfig(env)).toThrowError(/cookNights/i);
  });

  it("aggregates multiple validation errors into a single thrown error", () => {
    const env = validEnv({
      MP_TIMEZONE: undefined,
      MP_TRIGGER_TIME: "not-a-time",
      MP_UNTESTED_RATE: "2",
    });

    try {
      loadConfig(env);
      expect.fail("expected loadConfig to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/timezone/i);
      expect(message).toMatch(/triggerTime/i);
      expect(message).toMatch(/untestedRate/i);
    }
  });
});
