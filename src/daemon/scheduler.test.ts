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
});
