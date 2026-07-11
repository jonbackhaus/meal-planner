import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "./scheduler.js";

/** Formats a Date as "Sun, MM/DD/YYYY, HH:MM" in the given IANA timezone, for assertion. */
function formatInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

describe("Scheduler", () => {
  describe("nextRun", () => {
    it("computes the next Sunday trigger after a given reference date", () => {
      const scheduler = new Scheduler({
        timezone: "America/Chicago",
        triggerTime: "06:00",
        onTrigger: vi.fn(async () => {}),
      });

      // 2026-02-24 is a Tuesday (America/Chicago).
      const from = new Date("2026-02-24T12:00:00Z");
      const next = scheduler.nextRun(from);

      expect(next).not.toBeNull();
      expect(formatInZone(next as Date, "America/Chicago")).toBe(
        "Sun, 03/01/2026, 06:00",
      );
    });

    it("computes the correct trigger across the US spring-forward DST transition", () => {
      const scheduler = new Scheduler({
        timezone: "America/Chicago",
        triggerTime: "06:00",
        onTrigger: vi.fn(async () => {}),
      });

      // 2026-03-08 is the Sunday US clocks spring forward (America/Chicago).
      const from = new Date("2026-03-01T12:00:00Z"); // the prior Sunday, just after that week's trigger
      const next = scheduler.nextRun(from);

      expect(next).not.toBeNull();
      expect(formatInZone(next as Date, "America/Chicago")).toBe(
        "Sun, 03/08/2026, 06:00",
      );
    });

    it("computes the correct trigger across the US fall-back DST transition", () => {
      const scheduler = new Scheduler({
        timezone: "America/Chicago",
        triggerTime: "06:00",
        onTrigger: vi.fn(async () => {}),
      });

      // 2026-11-01 is the Sunday US clocks fall back (America/Chicago).
      const from = new Date("2026-10-25T12:00:00Z"); // the prior Sunday, just after that week's trigger
      const next = scheduler.nextRun(from);

      expect(next).not.toBeNull();
      expect(formatInZone(next as Date, "America/Chicago")).toBe(
        "Sun, 11/01/2026, 06:00",
      );
    });

    it("respects a different pinned timezone (America/Los_Angeles)", () => {
      const scheduler = new Scheduler({
        timezone: "America/Los_Angeles",
        triggerTime: "07:30",
        onTrigger: vi.fn(async () => {}),
      });

      const from = new Date("2026-02-24T12:00:00Z");
      const next = scheduler.nextRun(from);

      expect(next).not.toBeNull();
      expect(formatInZone(next as Date, "America/Los_Angeles")).toBe(
        "Sun, 03/01/2026, 07:30",
      );
    });

    it("throws a clear error when constructed with an invalid triggerTime", () => {
      expect(
        () =>
          new Scheduler({
            timezone: "America/Chicago",
            triggerTime: "6:00am",
            onTrigger: vi.fn(async () => {}),
          }),
      ).toThrowError(/triggerTime/i);
    });
  });

  describe("start/stop lifecycle", () => {
    it("does not invoke onTrigger before start() is called", async () => {
      const onTrigger = vi.fn(async () => {});
      const scheduler = new Scheduler({
        timezone: "America/Chicago",
        triggerTime: "06:00",
        onTrigger,
      });

      expect(onTrigger).not.toHaveBeenCalled();
      scheduler.stop(); // no-op, must not throw
    });

    it("stop() cancels the schedule and leaves no pending timers", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-02-24T12:00:00Z"));
        const onTrigger = vi.fn(async () => {});
        const scheduler = new Scheduler({
          timezone: "America/Chicago",
          triggerTime: "06:00",
          onTrigger,
        });

        scheduler.start();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        scheduler.stop();
        expect(vi.getTimerCount()).toBe(0);

        // Advance well past the next trigger; onTrigger must never fire.
        vi.advanceTimersByTime(14 * 24 * 60 * 60 * 1000);
        expect(onTrigger).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("start() is idempotent (calling twice does not double-schedule)", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-02-24T12:00:00Z"));
        const onTrigger = vi.fn(async () => {});
        const scheduler = new Scheduler({
          timezone: "America/Chicago",
          triggerTime: "06:00",
          onTrigger,
        });

        scheduler.start();
        const timersAfterFirstStart = vi.getTimerCount();
        scheduler.start();
        expect(vi.getTimerCount()).toBe(timersAfterFirstStart);

        scheduler.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("triggerNow (test-fire affordance)", () => {
    it("invokes onTrigger exactly once, immediately, without waiting for a schedule", async () => {
      const onTrigger = vi.fn(async () => {});
      const scheduler = new Scheduler({
        timezone: "America/Chicago",
        triggerTime: "06:00",
        onTrigger,
      });

      await scheduler.triggerNow();

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });
  });

  describe("re-entrant guard", () => {
    it("skips an overlapping trigger while a previous onTrigger run is still in progress", async () => {
      let releaseFirstRun: () => void = () => {};
      const firstRunGate = new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      });

      let callCount = 0;
      const onTrigger = vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          await firstRunGate;
        }
      });
      const onOverlap = vi.fn();

      const scheduler = new Scheduler({
        timezone: "America/Chicago",
        triggerTime: "06:00",
        onTrigger,
        onOverlap,
      });

      const firstCall = scheduler.triggerNow();
      const secondCall = scheduler.triggerNow(); // fires while first is still in-flight

      expect(onOverlap).toHaveBeenCalledTimes(1);
      expect(onTrigger).toHaveBeenCalledTimes(1);

      releaseFirstRun();
      await Promise.all([firstCall, secondCall]);

      expect(onTrigger).toHaveBeenCalledTimes(1);

      // A subsequent call after the first run completes must go through normally.
      await scheduler.triggerNow();
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });
  });

  describe("scheduled-trigger error containment", () => {
    it("contains an onTrigger error on a SCHEDULED fire: no unhandled rejection, the error is logged, and the schedule stays active for the next fire", async () => {
      vi.useFakeTimers();
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        // Pin fake "now" a few seconds before the next Sunday trigger.
        // (Croner internally chunks long waits into <=30s re-scheduled
        // timers; starting far from the trigger — e.g. from a Tuesday —
        // would need thousands of chunked re-schedules to reach it, which
        // is extremely slow to replay even under fake timers. Starting
        // close to the trigger keeps this test fast without weakening what
        // it proves: the containment behavior under test lives entirely in
        // the `catch` handler passed to croner in `start()`, independent of
        // how far away the trigger was.)
        const reference = new Date("2026-02-28T12:00:00Z"); // Sat (America/Chicago)
        vi.setSystemTime(reference);

        let callCount = 0;
        const onTrigger = vi.fn(async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("boom: generation failed on the real Sunday fire");
          }
        });
        const logger = { warn: vi.fn() };

        const scheduler = new Scheduler({
          timezone: "America/Chicago",
          triggerTime: "06:00",
          onTrigger,
          logger,
        });

        const firstTrigger = scheduler.nextRun(reference) as Date;
        expect(
          firstTrigger.getTime() - reference.getTime(),
        ).toBeLessThanOrEqual(24 * 60 * 60 * 1000); // sanity: trigger is same-day-ish, not multiple days out

        scheduler.start();

        // Advance just past the scheduled trigger and flush microtasks so
        // the throwing onTrigger's promise chain (including our try/catch
        // inside croner's `catch` option) fully resolves.
        await vi.advanceTimersByTimeAsync(
          firstTrigger.getTime() - reference.getTime() + 1000,
        );

        expect(onTrigger).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(
          /contained.*boom: generation failed on the real Sunday fire/s,
        );
        // The scheduler must still be active (not torn down by the error)...
        expect(scheduler.isActive()).toBe(true);
        // ...and must still be able to run onTrigger again: the re-entrant
        // `busy` guard was correctly reset (via guardedTrigger's `finally`)
        // despite the previous run's error, so the daemon is not wedged.
        await scheduler.triggerNow();
        expect(onTrigger).toHaveBeenCalledTimes(2);

        // No unhandled rejection was ever produced by the throwing scheduled
        // fire (this is what would crash the resident daemon process).
        expect(unhandledRejections).toEqual([]);

        scheduler.stop();
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        vi.useRealTimers();
      }
    });
  });
});
