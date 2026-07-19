import { z } from "zod";
import { summarizeZodError } from "../lib/zod-errors.js";
import {
  EnrichedMealSchema,
  EnrichedWeekPlanSchema,
} from "../planner/enrich.js";
import type { Session, SessionStatus } from "./session-store.js";

/**
 * `resumeQuietly` — crash-recovery reconstitution (ADR 0002 "Crash recovery —
 * resume quietly", bd meal-planner-bd6.5). `onStartup` (bd6.4, startup.ts)
 * calls this for any "live" row (`suggested`/`under_revision`/`committed`)
 * found at boot: the working plan already exists and (in v3.0) is still
 * being discussed in-thread, so a restart must RESUME that state rather than
 * regenerate it or say anything new about it.
 *
 * "Quietly" governs only the recovery, not any user-visible action: this
 * function is a PURE reconstitution of the in-memory `ActiveSession` shape
 * from the durable `Session` row. It makes no Slack call, posts no alert,
 * writes nothing back to the store, and does no logging beyond what a caller
 * chooses to do with its return value — it only reads the row it was handed
 * and returns a value. In v1.0 there is no inbound listener yet (that's
 * v3.0), so there is nothing further to "resume" beyond having the plan/
 * thread_ts back in memory; this function is the seam v3.0's revision
 * listener is built on top of.
 */

/**
 * The in-memory shape the daemon holds for the currently-active week.
 * Mirrors the subset of `Session` a live listener/renderer needs, with
 * `working_plan` narrowed from the store's opaque `unknown` into the LENIENT
 * read shape {@link ResumedWeekPlan} (or `null` when there is none yet, e.g. a
 * row that never got past `generating` before this function's caller was
 * routed elsewhere).
 */
export interface ActiveSession {
  week_key: string;
  status: SessionStatus;
  thread_ts: string | null;
  working_plan: ResumedWeekPlan | null;
}

/**
 * The lenient READ variant of the canonical enrich schema (bd6.8 + bd6.13).
 * `enrich.ts` owns the CANONICAL field structure — `EnrichedMealSchema` /
 * `EnrichedWeekPlanSchema`, the single source of truth for what `enrichPlan`
 * produces — and this module DERIVES its read shape on top rather than
 * re-describing it (which would drift). The derivation layers exactly the
 * two read-leniencies bd6.13 introduced:
 *
 *  1. `day: z.string().nullable().optional()` — tolerate the v2.0 nullable
 *     `day` (a weekday string) as well as v1.0's literal `null` or an absent
 *     field. v1.0 STORAGE still writes `day: null` (planner/select.ts) —
 *     only the read is widened here.
 *  2. `.passthrough()` (not `.strict()`) on both the meal and the plan so a
 *     blob grown by a FUTURE schema — extra top-level or per-meal fields
 *     (v2.0 calendar context, v3.0 Todoist ids) — still parses and is
 *     PRESERVED, instead of the live week's plan being lost.
 *
 * The CORE stays required (it comes straight from the canonical schema): a
 * plan missing `meals`, or a meal missing its enriched `recipe`, still fails.
 */
const ResumedMealSchema = EnrichedMealSchema.extend({
  day: z.string().nullable().optional(),
}).passthrough();

const ResumedWeekPlanSchema = EnrichedWeekPlanSchema.extend({
  meals: z.array(ResumedMealSchema),
}).passthrough();

/**
 * The lenient READ shape of `working_plan` (bd6.13). Intentionally WIDER than
 * the planner's `EnrichedWeekPlan` (extra/optional fields tolerated, `day`
 * nullable) so a plan written by a current OR future schema both parse on
 * resume rather than being dropped. Used in place of `EnrichedWeekPlan` for
 * the resume-parse return / `ActiveSession.working_plan`.
 */
export type ResumedWeekPlan = z.infer<typeof ResumedWeekPlanSchema>;

/**
 * Thrown when a row's `working_plan` is present but doesn't parse into a
 * valid `EnrichedWeekPlan` — a `resumeQuietly` caller should fail loudly
 * rather than hand the daemon a corrupt plan to keep operating on. Carries
 * only the `week_key` and a short zod-issue summary (via the shared
 * `summarizeZodError`, same convention as `PlanSelectionError`/
 * `PlanValidationError`) — never the raw stored value, which could carry
 * household prose — so it is always safe to log or alert on.
 */
export class ResumeError extends Error {
  readonly weekKey: string;

  constructor(weekKey: string, reason: string) {
    super(
      `resumeQuietly: malformed working_plan for week ${weekKey}:\n${reason}`,
    );
    this.name = "ResumeError";
    this.weekKey = weekKey;
  }
}

/**
 * Parses/validates `row.working_plan` into a typed `ResumedWeekPlan | null`.
 *
 * `SessionStore.get` (session-store.ts) already `JSON.parse`s the stored TEXT
 * column before returning a `Session`, so the common case is an already-
 * parsed object. This also accepts a raw JSON string defensively, in case a
 * caller hands `resumeQuietly` a `Session`-shaped row constructed some other
 * way (e.g. by hand, in a test, or a future store variant) — this function
 * only requires the `Session` shape, not that it came from `SessionStore`.
 */
function parseWorkingPlan(
  weekKey: string,
  raw: Session["working_plan"],
): ResumedWeekPlan | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      // Deliberately GENERIC: V8's JSON.parse error message embeds a
      // snippet of the offending input (e.g. `Unexpected token 'v',
      // "vegetarian"... is not valid JSON`), so appending `err.message` here
      // would leak a fragment of household prose into a thrown error that
      // could be logged or alerted on. Never interpolate it.
      throw new ResumeError(
        weekKey,
        "working_plan is a string but not valid JSON",
      );
    }
  }

  const result = ResumedWeekPlanSchema.safeParse(candidate);
  if (!result.success) {
    throw new ResumeError(weekKey, summarizeZodError(result.error));
  }
  return result.data;
}

/**
 * Reconstitutes the in-memory `ActiveSession` for a live week's row on
 * daemon restart. PURE reconstitution — reads only `row`, performs zero side
 * effects (no Slack, no alert, no DB write, no logging), and says nothing
 * in-thread. Throws `ResumeError` if `row.working_plan` is present but
 * malformed, rather than returning a corrupt plan.
 *
 * Signature note: `onStartup`'s (bd6.4, startup.ts) `OnStartupDeps.resumeQuietly`
 * is typed `(row: Session) => void` (a plain `void` return position, not a
 * `Promise<void> | void` union — TypeScript's "return value ignored in void
 * position" rule applies only to a bare `void` target, not to a union
 * containing it). Because it's a plain `void` target, this synchronous
 * function returning `ActiveSession` IS structurally assignable there —
 * TypeScript accepts (and ignores) any actual return value in a `void`
 * position — so this function slots directly into `onStartup`'s injected dep
 * with no adapter, while still handing the eventual daemon holder (the
 * future in-memory `ActiveSession` registry, v3.0) a real value to keep
 * instead of discarding it.
 */
export function resumeQuietly(row: Session): ActiveSession {
  return {
    week_key: row.week_key,
    status: row.status,
    thread_ts: row.thread_ts,
    working_plan: parseWorkingPlan(row.week_key, row.working_plan),
  };
}
