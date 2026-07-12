import { z } from "zod";
import { summarizeZodError } from "../lib/zod-errors.js";
import type { EnrichedWeekPlan } from "../planner/enrich.js";
import { SelectedMealSchema } from "../planner/select.js";
import { RecipeSchema } from "../recipe-mcp/schema.js";
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
 * `working_plan` narrowed from the store's opaque `unknown` into the
 * planner's typed `EnrichedWeekPlan` (or `null` when there is none yet, e.g.
 * a row that never got past `generating` before this function's caller was
 * routed elsewhere).
 */
export interface ActiveSession {
  week_key: string;
  status: SessionStatus;
  thread_ts: string | null;
  working_plan: EnrichedWeekPlan | null;
}

/**
 * `enrich.ts` types `EnrichedWeekPlan`/`EnrichedMeal` as plain TS interfaces
 * — it has no exported zod schema of its own, because `enrichPlan` only
 * ATTACHES a `Recipe` to an already-validated `WeekPlan` (8zs.4 already did
 * the LLM-output validation); there is nothing left for it to re-validate.
 * So there is no ready-made `EnrichedWeekPlanSchema` to import.
 *
 * Rather than hand-roll a duck-typing check that could silently drift from
 * the planner's real shape, this composes ONE schema from the two the
 * planner already exports as source of truth: `SelectedMealSchema`
 * (planner/select.ts, the pre-enrichment shape) extended with the
 * `recipe`/`secondDishRecipe` fields `enrichPlan` attaches (`RecipeSchema`,
 * recipe-mcp/schema.ts). This stays anchored to the planner's real schemas —
 * if either changes shape, this validation changes with it — while still
 * being local to this module (enrich.ts itself is out of scope for bd6.5).
 */
const EnrichedMealSchema = SelectedMealSchema.extend({
  recipe: RecipeSchema,
  secondDishRecipe: RecipeSchema.optional(),
});

const EnrichedWeekPlanSchema = z.object({
  week_key: z.string(),
  meals: z.array(EnrichedMealSchema),
  summary: z.string().optional(),
});

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
 * Parses/validates `row.working_plan` into a typed `EnrichedWeekPlan | null`.
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
): EnrichedWeekPlan | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch (err) {
      throw new ResumeError(
        weekKey,
        `working_plan is a string but not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  const result = EnrichedWeekPlanSchema.safeParse(candidate);
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
 * is typed `(row: Session) => Promise<void> | void`. A synchronous function
 * returning `ActiveSession` is structurally assignable there — TypeScript
 * treats a `void`-expecting return position as accepting (and ignoring) any
 * actual return value — so this function slots directly into `onStartup`'s
 * injected dep with no adapter, while still handing the eventual daemon
 * holder (the future in-memory `ActiveSession` registry, v3.0) a real value
 * to keep instead of discarding it.
 */
export function resumeQuietly(row: Session): ActiveSession {
  return {
    week_key: row.week_key,
    status: row.status,
    thread_ts: row.thread_ts,
    working_plan: parseWorkingPlan(row.week_key, row.working_plan),
  };
}
