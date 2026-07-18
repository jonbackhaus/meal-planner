import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "./with-timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves with the wrapped promise's value when it settles before the timeout", async () => {
    const result = await withTimeout(Promise.resolve("secret-value"), {
      timeoutMs: 1000,
    });

    expect(result).toBe("secret-value");
  });

  it("rejects with the wrapped promise's error when it rejects before the timeout", async () => {
    const boom = new Error("boom");

    await expect(
      withTimeout(Promise.reject(boom), { timeoutMs: 1000 }),
    ).rejects.toThrow("boom");
  });

  it("rejects on timeout when the wrapped promise never settles (hung loader), without leaking a timer", async () => {
    vi.useFakeTimers();

    const hungPromise = new Promise<string>(() => {}); // never resolves, simulating a hung `op` CLI call

    const settled = withTimeout(hungPromise, {
      timeoutMs: 5000,
      message: "secret load timed out",
    });
    const assertion = expect(settled).rejects.toThrow("secret load timed out");

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a TimeoutError on timeout, so callers can distinguish it from the wrapped promise's own rejection", async () => {
    vi.useFakeTimers();

    const hungPromise = new Promise<string>(() => {});
    const settled = withTimeout(hungPromise, { timeoutMs: 1000 });
    const assertion = expect(settled).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("does not leak a pending timeout timer once the wrapped promise resolves early", async () => {
    vi.useFakeTimers();

    await withTimeout(Promise.resolve("ok"), { timeoutMs: 5000 });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a generic default timeout message that never echoes secret content", async () => {
    vi.useFakeTimers();

    const hungPromise = new Promise<string>(() => {});
    const settled = withTimeout(hungPromise, { timeoutMs: 1000 });
    const assertion = expect(settled).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});
