import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHeartbeat } from "./heartbeat.js";

/**
 * `makeHeartbeat` (bd meal-planner-fkg.8) is the external dead-man switch. The
 * contract under test: DISABLED when no URL is given (no fetch ever), pings the
 * base URL on success and `<url>/fail` on failure, and -- crucially -- NEVER
 * throws or rejects even when `fetch` errors or times out, logging only a
 * redacted, secret-free reason (never the URL).
 */

const URL = "https://hc-ping.com/secret-uuid-1234";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeHeartbeat", () => {
  it("is a no-op when the url is undefined (no fetch call)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const hb = makeHeartbeat(undefined);
    await hb.success();
    await hb.fail();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the url is an empty string (no fetch call)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const hb = makeHeartbeat("");
    await hb.success();
    await hb.fail();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("success() pings the base url", async () => {
    const fetchMock = vi.fn(
      async (_target: string, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hb = makeHeartbeat(URL);
    await hb.success();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(URL);
  });

  it("fail() pings the `<url>/fail` sub-path", async () => {
    const fetchMock = vi.fn(
      async (_target: string, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hb = makeHeartbeat(URL);
    await hb.fail();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${URL}/fail`);
  });

  it("does not double the slash when the base url has a trailing slash", async () => {
    const fetchMock = vi.fn(
      async (_target: string, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hb = makeHeartbeat(`${URL}/`);
    await hb.fail();

    expect(fetchMock.mock.calls[0][0]).toBe(`${URL}/fail`);
  });

  it("never throws when fetch rejects, and logs a redacted reason (no url)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${URL}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.fn();

    const hb = makeHeartbeat(URL, { logger: { warn } });

    await expect(hb.success()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain("healthcheck success ping failed");
    expect(line).toContain("TypeError");
    // The URL is a mild secret -- it must never appear in the log line.
    expect(line).not.toContain("secret-uuid-1234");
  });

  it("aborts on timeout and never throws, logging a redacted timeout reason", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_target: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            });
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const warn = vi.fn();

      const hb = makeHeartbeat(URL, { timeoutMs: 10_000, logger: { warn } });
      const pending = hb.success();
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0][0] as string;
      expect(line).toContain("timeout");
      expect(line).not.toContain("secret-uuid-1234");
    } finally {
      vi.useRealTimers();
    }
  });
});
