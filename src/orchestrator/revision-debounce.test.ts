import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InboundThreadReply,
  RevisionHandler,
} from "../slack/inbound-router.js";
import { createDebouncedRevisionHandler } from "./revision-debounce.js";

/**
 * `revision-debounce.ts` tests (bd meal-planner-3e2.4, ADR 0007 D3). No real
 * network / wall-clock waits -- vitest fake timers stand in for the
 * injectable clock (this module's default `DebounceClock` wraps the global
 * `setTimeout`/`clearTimeout`, which `vi.useFakeTimers()` patches).
 */

function threadReply(
  overrides: Partial<InboundThreadReply> = {},
): InboundThreadReply {
  return {
    weekKey: "2026-07-12",
    threadTs: "1000.0001",
    event: {
      type: "message",
      channel: "C123",
      user: "U123",
      ts: "1000.0002",
      thread_ts: "1000.0001",
      text: "how about tacos instead",
    },
    ...overrides,
  };
}

function makeDownstream(): RevisionHandler & {
  calls: InboundThreadReply[];
} {
  const calls: InboundThreadReply[] = [];
  return {
    calls,
    onReply: vi.fn((reply: InboundThreadReply) => {
      calls.push(reply);
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDebouncedRevisionHandler", () => {
  it("coalesces N rapid replies on one thread into exactly ONE downstream revision carrying all N messages", () => {
    const downstream = makeDownstream();
    const handler = createDebouncedRevisionHandler(downstream, {
      windowMs: 30_000,
    });

    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "msg one" } }),
    );
    vi.advanceTimersByTime(5_000);
    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "msg two" } }),
    );
    vi.advanceTimersByTime(5_000);
    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "msg three" } }),
    );

    // Not flushed yet -- still inside the window since the last reply.
    vi.advanceTimersByTime(29_999);
    expect(downstream.onReply).not.toHaveBeenCalled();

    // Window elapses with no further reply -- flush now.
    vi.advanceTimersByTime(1);
    expect(downstream.onReply).toHaveBeenCalledTimes(1);
    const merged = downstream.calls[0];
    expect(merged.weekKey).toBe("2026-07-12");
    expect(merged.threadTs).toBe("1000.0001");
    expect(merged.event.text).toBe("msg one\nmsg two\nmsg three");
  });

  it("dispatches replies spaced beyond the window as separate revisions", () => {
    const downstream = makeDownstream();
    const handler = createDebouncedRevisionHandler(downstream, {
      windowMs: 30_000,
    });

    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "first burst" } }),
    );
    vi.advanceTimersByTime(30_000);
    expect(downstream.onReply).toHaveBeenCalledTimes(1);
    expect(downstream.calls[0].event.text).toBe("first burst");

    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "second burst" } }),
    );
    vi.advanceTimersByTime(30_000);
    expect(downstream.onReply).toHaveBeenCalledTimes(2);
    expect(downstream.calls[1].event.text).toBe("second burst");
  });

  it("keeps two threads' bursts independent -- a burst in thread A does not swallow thread B's reply", () => {
    const downstream = makeDownstream();
    const handler = createDebouncedRevisionHandler(downstream, {
      windowMs: 30_000,
    });

    handler.onReply(
      threadReply({
        weekKey: "2026-07-12",
        threadTs: "1000.0001",
        event: { ...threadReply().event, text: "thread A msg" },
      }),
    );
    vi.advanceTimersByTime(10_000);
    handler.onReply(
      threadReply({
        weekKey: "2026-07-19",
        threadTs: "2000.0001",
        event: { ...threadReply().event, text: "thread B msg" },
      }),
    );

    // Thread A's window (started first) elapses first.
    vi.advanceTimersByTime(20_000);
    expect(downstream.onReply).toHaveBeenCalledTimes(1);
    expect(downstream.calls[0].threadTs).toBe("1000.0001");
    expect(downstream.calls[0].event.text).toBe("thread A msg");

    // Thread B's window elapses independently, 10s later.
    vi.advanceTimersByTime(10_000);
    expect(downstream.onReply).toHaveBeenCalledTimes(2);
    expect(downstream.calls[1].threadTs).toBe("2000.0001");
    expect(downstream.calls[1].event.text).toBe("thread B msg");
  });

  it("resets the window on each new reply within a burst (a steady drip under the window keeps extending it)", () => {
    const downstream = makeDownstream();
    const handler = createDebouncedRevisionHandler(downstream, {
      windowMs: 10_000,
    });

    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "a" } }),
    );
    vi.advanceTimersByTime(9_000);
    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "b" } }),
    );
    vi.advanceTimersByTime(9_000);
    handler.onReply(
      threadReply({ event: { ...threadReply().event, text: "c" } }),
    );
    vi.advanceTimersByTime(9_000);

    // 27s of elapsed time > the 10s window, but each reply reset the timer,
    // so nothing has flushed yet.
    expect(downstream.onReply).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(downstream.onReply).toHaveBeenCalledTimes(1);
    expect(downstream.calls[0].event.text).toBe("a\nb\nc");
  });

  it("logs (never throws out of onReply) when the downstream handler rejects on flush", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const downstream: RevisionHandler = {
      onReply: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const handler = createDebouncedRevisionHandler(downstream, {
      windowMs: 1_000,
      logger,
    });

    expect(() => handler.onReply(threadReply())).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(downstream.onReply).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it("defaults windowMs to 30s when not provided", () => {
    const downstream = makeDownstream();
    const handler = createDebouncedRevisionHandler(downstream);

    handler.onReply(threadReply());
    vi.advanceTimersByTime(29_999);
    expect(downstream.onReply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(downstream.onReply).toHaveBeenCalledTimes(1);
  });
});
