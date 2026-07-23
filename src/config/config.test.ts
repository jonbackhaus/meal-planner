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
      maxPairedSides: 2,
      generationDollarCap: 2,
      staleSyncThreshold: 50,
      triggerTimeoutMs: 2_700_000,
      llmCallTimeoutMs: 240_000,
      llmCallMaxRetries: 1,
      quickActiveMax: 30,
      calendar: {
        enabled: false,
        include: [],
        cookingWindow: { start: "16:30", end: "19:30" },
      },
    });
  });

  it("reads maxPairedSides from MP_MAX_PAIRED_SIDES when set", () => {
    const config = loadConfig(validEnv({ MP_MAX_PAIRED_SIDES: "1" }));

    expect(config.maxPairedSides).toBe(1);
  });

  it("throws when maxPairedSides is negative or not an integer", () => {
    expect(() =>
      loadConfig(validEnv({ MP_MAX_PAIRED_SIDES: "-1" })),
    ).toThrowError(/maxPairedSides/i);
    expect(() =>
      loadConfig(validEnv({ MP_MAX_PAIRED_SIDES: "1.5" })),
    ).toThrowError(/maxPairedSides/i);
  });

  it("applies a MP_TRIGGER_TIMEOUT_MS override", () => {
    const config = loadConfig(validEnv({ MP_TRIGGER_TIMEOUT_MS: "600000" }));

    expect(config.triggerTimeoutMs).toBe(600_000);
  });

  it("throws when triggerTimeoutMs is not a positive number", () => {
    const env = validEnv({ MP_TRIGGER_TIMEOUT_MS: "0" });

    expect(() => loadConfig(env)).toThrowError(/triggerTimeoutMs/i);
  });

  it("applies a MP_LLM_CALL_TIMEOUT_MS override", () => {
    const config = loadConfig(validEnv({ MP_LLM_CALL_TIMEOUT_MS: "60000" }));

    expect(config.llmCallTimeoutMs).toBe(60_000);
  });

  it("applies a MP_STALE_SYNC_THRESHOLD override", () => {
    const config = loadConfig(validEnv({ MP_STALE_SYNC_THRESHOLD: "100" }));

    expect(config.staleSyncThreshold).toBe(100);
  });

  it("throws when staleSyncThreshold is negative or not an integer", () => {
    expect(() =>
      loadConfig(validEnv({ MP_STALE_SYNC_THRESHOLD: "-1" })),
    ).toThrowError(/staleSyncThreshold/i);
    expect(() =>
      loadConfig(validEnv({ MP_STALE_SYNC_THRESHOLD: "1.5" })),
    ).toThrowError(/staleSyncThreshold/i);
  });

  it("throws when llmCallTimeoutMs is not a positive number", () => {
    const env = validEnv({ MP_LLM_CALL_TIMEOUT_MS: "0" });

    expect(() => loadConfig(env)).toThrowError(/llmCallTimeoutMs/i);
  });

  describe("llmCallMaxRetries (bd meal-planner-k31, qjk follow-up)", () => {
    it("defaults llmCallMaxRetries to 1", () => {
      const config = loadConfig(validEnv());

      expect(config.llmCallMaxRetries).toBe(1);
    });

    it("applies a MP_LLM_CALL_MAX_RETRIES override, including 0 to disable retrying", () => {
      expect(
        loadConfig(validEnv({ MP_LLM_CALL_MAX_RETRIES: "3" }))
          .llmCallMaxRetries,
      ).toBe(3);
      expect(
        loadConfig(validEnv({ MP_LLM_CALL_MAX_RETRIES: "0" }))
          .llmCallMaxRetries,
      ).toBe(0);
    });

    it("throws when llmCallMaxRetries is negative or not an integer", () => {
      expect(() =>
        loadConfig(validEnv({ MP_LLM_CALL_MAX_RETRIES: "-1" })),
      ).toThrowError(/llmCallMaxRetries/i);
      expect(() =>
        loadConfig(validEnv({ MP_LLM_CALL_MAX_RETRIES: "1.5" })),
      ).toThrowError(/llmCallMaxRetries/i);
    });
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

  describe("quickActiveMax (ADR-0004 D4/D6)", () => {
    it("defaults quickActiveMax to 30", () => {
      const config = loadConfig(validEnv());

      expect(config.quickActiveMax).toBe(30);
    });

    it("reads quickActiveMax from MP_QUICK_ACTIVE_MAX when set", () => {
      const config = loadConfig(validEnv({ MP_QUICK_ACTIVE_MAX: "20" }));

      expect(config.quickActiveMax).toBe(20);
    });

    it("throws when quickActiveMax is not a positive number", () => {
      expect(() =>
        loadConfig(validEnv({ MP_QUICK_ACTIVE_MAX: "0" })),
      ).toThrowError(/quickActiveMax/i);
      expect(() =>
        loadConfig(validEnv({ MP_QUICK_ACTIVE_MAX: "-5" })),
      ).toThrowError(/quickActiveMax/i);
    });
  });

  describe("calendar config (ADR-0004 D2/D3/D6)", () => {
    it("defaults calendar to disabled, empty include-list, and the default cooking window", () => {
      const config = loadConfig(validEnv());

      expect(config.calendar).toEqual({
        enabled: false,
        include: [],
        cookingWindow: { start: "16:30", end: "19:30" },
      });
    });

    it("reads calendar.enabled from MP_CALENDAR_ENABLED", () => {
      expect(
        loadConfig(validEnv({ MP_CALENDAR_ENABLED: "true" })).calendar.enabled,
      ).toBe(true);
      expect(
        loadConfig(validEnv({ MP_CALENDAR_ENABLED: "false" })).calendar.enabled,
      ).toBe(false);
    });

    it("throws when MP_CALENDAR_ENABLED is not a boolean literal", () => {
      expect(() =>
        loadConfig(validEnv({ MP_CALENDAR_ENABLED: "yes" })),
      ).toThrowError(/calendar\.enabled/i);
    });

    it("reads the include allowlist with per-calendar roles from MP_CALENDAR_INCLUDE", () => {
      const config = loadConfig(
        validEnv({
          MP_CALENDAR_ENABLED: "true",
          MP_CALENDAR_INCLUDE: JSON.stringify([
            { name: "Jonathan", role: "cook" },
            { name: "Family", role: "cook" },
            { name: "Kids", role: "logistics" },
          ]),
        }),
      );

      expect(config.calendar.include).toEqual([
        { name: "Jonathan", role: "cook" },
        { name: "Family", role: "cook" },
        { name: "Kids", role: "logistics" },
      ]);
    });

    it("throws when MP_CALENDAR_INCLUDE is not valid JSON", () => {
      expect(() =>
        loadConfig(validEnv({ MP_CALENDAR_INCLUDE: "not-json" })),
      ).toThrowError(/calendar\.include/i);
    });

    it("throws when an include entry has an empty name", () => {
      expect(() =>
        loadConfig(
          validEnv({
            MP_CALENDAR_INCLUDE: JSON.stringify([{ name: "", role: "cook" }]),
          }),
        ),
      ).toThrowError(/calendar\.include/i);
    });

    it("throws when an include entry's role is not cook or logistics (denylist-style roles rejected)", () => {
      expect(() =>
        loadConfig(
          validEnv({
            MP_CALENDAR_INCLUDE: JSON.stringify([
              { name: "Kids", role: "exclude" },
            ]),
          }),
        ),
      ).toThrowError(/calendar\.include/i);
    });

    it("reads a cookingWindow override from MP_CALENDAR_COOKING_WINDOW_START/END", () => {
      const config = loadConfig(
        validEnv({
          MP_CALENDAR_COOKING_WINDOW_START: "17:00",
          MP_CALENDAR_COOKING_WINDOW_END: "20:00",
        }),
      );

      expect(config.calendar.cookingWindow).toEqual({
        start: "17:00",
        end: "20:00",
      });
    });

    it("throws when a cookingWindow time is not HH:MM 24h format", () => {
      expect(() =>
        loadConfig(validEnv({ MP_CALENDAR_COOKING_WINDOW_START: "5:00pm" })),
      ).toThrowError(/cookingWindow/i);
    });

    it("throws when cookingWindow.start is not before cookingWindow.end", () => {
      expect(() =>
        loadConfig(
          validEnv({
            MP_CALENDAR_COOKING_WINDOW_START: "19:30",
            MP_CALENDAR_COOKING_WINDOW_END: "16:30",
          }),
        ),
      ).toThrowError(/cookingWindow/i);
    });

    it("does not require the reader to exist — enabled defaults false and include-list is code-independent", () => {
      const config = loadConfig(validEnv());

      expect(config.calendar.enabled).toBe(false);
      expect(Array.isArray(config.calendar.include)).toBe(true);
    });
  });
});
