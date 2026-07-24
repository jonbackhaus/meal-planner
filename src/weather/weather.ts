import { DateTime } from "luxon";
import type { WeekKey } from "../orchestrator/week-key.js";

/**
 * Open-Meteo → week-level `temperature_band` (ADR-0003 A1, bd `bgb`).
 *
 * A **soft** LLM reasoning input, refining the tag-based `current_season`
 * signal (never a second/competing seasonality axis — see `input.ts`'s
 * no-double-count prompt instruction). Week-level, not per-day (A1: with
 * precipitation cut from scope there's no per-day driver, and dinner
 * heaviness doesn't meaningfully swing day-to-day).
 *
 * **Silent degrade (A1):** any fetch failure/timeout/malformed response is
 * caught here and mapped to `null` — log-only, no alert (unlike the
 * calendar's alert-once degrade, ADR-0004 D6). `null` means "plan
 * seasonal-only"; this function never throws.
 *
 * No API key: Open-Meteo's `/v1/forecast` endpoint is a keyless GET.
 */

export type TemperatureBand = "cold" | "mild" | "hot";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

/**
 * Fetch timeout (bd `bgb`): mirrors the house pattern (calendar reader,
 * heartbeat) of bounding an outbound call so a hung network request can't
 * stall the run — this degrades to `null` well before it could threaten
 * `triggerTimeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Week-level cold/mild/hot thresholds (bd `bgb`), applied to the plan week's
 * MEAN daily high (`temperature_2m_max`, °F, across its 7 dates). Afternoon/
 * evening warmth is the more relevant driver for a dinner-heaviness nudge
 * than the overnight low. These are a simple, easily-retuned starting split
 * — not derived from any external standard:
 *   - `cold`: mean daily high < 45°F
 *   - `hot`:  mean daily high > 80°F
 *   - `mild`: otherwise (45–80°F inclusive)
 */
const COLD_MAX_F = 45;
const HOT_MIN_F = 80;

/** Minimal shape this module needs from a fetch `Response` (real or stubbed). */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** Injectable fetch signature — production defaults to the global `fetch`. */
export type FetchForecast = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface GetTemperatureBandArgs {
  /** The plan week (anchor Sunday) to fetch the forecast for. */
  weekKey: WeekKey;
  /** IANA timezone — passed through to Open-Meteo so its daily buckets align with the household's days. */
  timezone: string;
  latitude: number;
  longitude: number;
}

export interface GetTemperatureBandDeps {
  /** Injected so tests never make a live Open-Meteo call; defaults to global `fetch`. */
  fetchForecast?: FetchForecast;
  /** Injectable for tests; defaults to `console`. */
  logger?: Pick<Console, "warn">;
  /** Abort deadline for the fetch, ms. Default 10s; injectable so tests can exercise the timeout path quickly. */
  timeoutMs?: number;
}

interface OpenMeteoDailyResponse {
  daily?: {
    temperature_2m_max?: unknown;
  };
}

function classifyBand(meanHighF: number): TemperatureBand {
  if (meanHighF < COLD_MAX_F) {
    return "cold";
  }
  if (meanHighF > HOT_MIN_F) {
    return "hot";
  }
  return "mild";
}

/** `[start, end]` (inclusive, `yyyy-MM-dd`) covering the plan week's 7 dates, for Open-Meteo's `start_date`/`end_date`. */
function planWeekDateRange(
  weekKey: WeekKey,
  timezone: string,
): { start: string; end: string } {
  const sunday = DateTime.fromISO(weekKey, { zone: timezone }).startOf("day");
  return {
    start: sunday.toFormat("yyyy-MM-dd"),
    end: sunday.plus({ days: 6 }).toFormat("yyyy-MM-dd"),
  };
}

function buildForecastUrl(args: GetTemperatureBandArgs): string {
  const { start, end } = planWeekDateRange(args.weekKey, args.timezone);
  const params = new URLSearchParams({
    latitude: String(args.latitude),
    longitude: String(args.longitude),
    daily: "temperature_2m_max",
    temperature_unit: "fahrenheit",
    timezone: args.timezone,
    start_date: start,
    end_date: end,
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

function extractDailyHighs(body: OpenMeteoDailyResponse): number[] {
  const highs = body.daily?.temperature_2m_max;
  if (
    !Array.isArray(highs) ||
    highs.length === 0 ||
    !highs.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new Error(
      "Open-Meteo response missing/malformed daily.temperature_2m_max",
    );
  }
  return highs;
}

/**
 * Fetches the Open-Meteo forecast for the plan week's dates + household
 * location and derives the week-level `temperature_band`. Returns `null` on
 * ANY failure (timeout, non-2xx, malformed body) — SILENT degrade (A1): logs
 * a warning, never alerts, never throws.
 */
export async function getTemperatureBand(
  args: GetTemperatureBandArgs,
  deps: GetTemperatureBandDeps = {},
): Promise<TemperatureBand | null> {
  const fetchForecast =
    deps.fetchForecast ?? (globalThis.fetch as FetchForecast);
  const logger = deps.logger ?? console;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = buildForecastUrl(args);
    const response = await fetchForecast(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Open-Meteo returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as OpenMeteoDailyResponse;
    const highs = extractDailyHighs(body);
    const meanHighF = highs.reduce((sum, v) => sum + v, 0) / highs.length;
    return classifyBand(meanHighF);
  } catch (error) {
    logger.warn(
      `[weather-degrade] temperature_band unavailable for week ${args.weekKey}: ` +
        `${String(error)}. Planning seasonal-only (ADR-0003 A1) — silent, no alert.`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
