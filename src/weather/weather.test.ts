import { describe, expect, it, vi } from "vitest";
import { type FetchResponseLike, getTemperatureBand } from "./weather.js";

/**
 * `getTemperatureBand` (ADR-0003 A1, bd `bgb`): derives a week-level
 * cold/mild/hot band from a stubbed Open-Meteo forecast, and — the load-
 * bearing contract — SILENTLY degrades to `null` on any fetch failure
 * (never throws, no alert dependency exists to fire).
 */

const ARGS = {
  weekKey: "2026-08-02",
  timezone: "America/Chicago",
  latitude: 41.8781,
  longitude: -87.6298,
};

function jsonResponse(daily: {
  temperature_2m_max: number[];
}): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({ daily }),
  };
}

describe("getTemperatureBand", () => {
  it("classifies cold from a low mean daily high", async () => {
    const fetchForecast = vi.fn(async () =>
      jsonResponse({ temperature_2m_max: [30, 32, 28, 25, 20, 22, 24] }),
    );

    const band = await getTemperatureBand(ARGS, { fetchForecast });

    expect(band).toBe("cold");
    expect(fetchForecast).toHaveBeenCalledTimes(1);
  });

  it("classifies mild from a moderate mean daily high", async () => {
    const fetchForecast = vi.fn(async () =>
      jsonResponse({ temperature_2m_max: [60, 62, 58, 65, 61, 59, 63] }),
    );

    const band = await getTemperatureBand(ARGS, { fetchForecast });

    expect(band).toBe("mild");
  });

  it("classifies hot from a high mean daily high", async () => {
    const fetchForecast = vi.fn(async () =>
      jsonResponse({ temperature_2m_max: [88, 92, 95, 90, 87, 91, 93] }),
    );

    const band = await getTemperatureBand(ARGS, { fetchForecast });

    expect(band).toBe("hot");
  });

  it("passes the household location and plan-week date range in the request URL", async () => {
    const fetchForecast = vi.fn(
      async (_url: string, _init: { signal: AbortSignal }) =>
        jsonResponse({ temperature_2m_max: [60] }),
    );

    await getTemperatureBand(ARGS, { fetchForecast });

    const [url] = fetchForecast.mock.calls[0];
    expect(url).toContain("latitude=41.8781");
    expect(url).toContain("longitude=-87.6298");
    expect(url).toContain("start_date=2026-08-02");
    expect(url).toContain("end_date=2026-08-08");
  });

  it("SILENTLY degrades to null when the fetch throws (no alert, never throws)", async () => {
    const logger = { warn: vi.fn() };
    const fetchForecast = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    const band = await getTemperatureBand(ARGS, { fetchForecast, logger });

    expect(band).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("2026-08-02");
  });

  it("SILENTLY degrades to null on a non-2xx response", async () => {
    const fetchForecast = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    const logger = { warn: vi.fn() };

    const band = await getTemperatureBand(ARGS, { fetchForecast, logger });

    expect(band).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("SILENTLY degrades to null on a malformed body (missing daily.temperature_2m_max)", async () => {
    const fetchForecast = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    const logger = { warn: vi.fn() };

    const band = await getTemperatureBand(ARGS, { fetchForecast, logger });

    expect(band).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("SILENTLY degrades to null on timeout (fetch never resolves within timeoutMs)", async () => {
    const fetchForecast = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<FetchResponseLike>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const logger = { warn: vi.fn() };

    const band = await getTemperatureBand(ARGS, {
      fetchForecast,
      logger,
      timeoutMs: 10,
    });

    expect(band).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
