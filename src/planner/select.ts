import { z } from "zod";
import { extractJsonObject } from "../lib/json-extraction.js";
import { summarizeZodError } from "../lib/zod-errors.js";
import type { LlmClient } from "../llm/llm-client.js";
import { buildSelectionPrompt, type PlannerInput } from "./input.js";

/**
 * `WeekPlan` structured output schema (ADR 0003 "Selection output"): this IS
 * the persisted `working_plan` (ADR 0002) and flows straight into v3.0
 * revision / v4.0 grocery with no reformatting. A separate, later,
 * deterministic render step (E5) turns it into Slack markdown — the LLM
 * never writes the post.
 *
 * Zod schemas are the single source of truth; the TS types below are
 * derived via `z.infer` so the runtime validators and the static types can't
 * drift (same convention as `recipe-mcp/schema.ts`).
 */

/**
 * How the per-night vegetarian-daughter constraint is satisfied for one
 * selected meal, discriminated on `kind`:
 *  - `inherent`: the dish itself is vegetarian (pairs with a candidate whose
 *    `veg_status === "vegetarian"`; that cross-check against the pool is
 *    THIS task's schema shape only — the semantic pool-membership /
 *    veg-consistency check is 8zs.4, not here).
 *  - `separable`: a meat dish that can be served without the meat for her
 *    (e.g. "hold the chicken; she has pasta+sauce") — `note` is required.
 *  - `second_dish`: rare fallback when the main dish isn't cleanly
 *    separable — an extra vegetarian recipe (its own `recipe_id` + `title`,
 *    drawn from a pool) is added just for her, which also means extra
 *    grocery/Todoist line items downstream.
 */
export const VegPathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inherent") }).strict(),
  z.object({ kind: z.literal("separable"), note: z.string() }).strict(),
  z
    .object({
      kind: z.literal("second_dish"),
      recipe_id: z.string(),
      title: z.string(),
    })
    .strict(),
]);
export type VegPath = z.infer<typeof VegPathSchema>;

/**
 * Normalizes a single LLM-emitted flag token to its canonical hyphenated
 * lowercase form (bd meal-planner-600): the prompt asks for exact tokens
 * like `"do-ahead"`, but the model has been observed drifting to
 * underscore/mixed-case variants (`"do_ahead"`, `"Do Ahead"`). Code that
 * matches flags downstream (`place-prep.ts`, `validate.ts`) does an exact
 * literal comparison against `"do-ahead"`, so normalizing here — once, at
 * the parse boundary — makes that matching robust to formatting drift
 * without needing a synonym map (there is no other flag the code branches
 * on). Pure string transform: lowercases, collapses any run of whitespace
 * or underscores into a single hyphen, collapses repeated hyphens, and
 * trims leading/trailing hyphens.
 */
export function sanitizeFlag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One selected meal. `recipe_id` MUST be a member of the matching pool —
 * that pool-membership check (along with counts/veg-consistency/no-dupes)
 * is the semantic `validate()` in 8zs.4, NOT enforced by this shape schema.
 * `day` (ADR 0005 D2) is a nullable ISO calendar date (`"2026-07-28"`), not
 * a weekday name: it is the unambiguous key into `NightSchedule`, `week_key`
 * already pins the week, and the render derives the "Tuesday" label from the
 * date. Nullability is load-bearing, not a placeholder — a legacy v1.0 row
 * (`day: null`) and the ADR 0004 D6 degraded no-calendar path both persist
 * `null` and must keep parsing; v2.0 only requires non-null on a *freshly
 * generated* plan, which is a semantic `validate()` rule (ADR 0005 D3), not
 * enforced by this shape schema.
 *
 * `side` (bd meal-planner-8zs.8) is an OPTIONAL side dish paired with this
 * main ("we make this with cornbread"). It is DISTINCT from a
 * `veg.kind:"second_dish"` (an accompaniment for everyone vs. the vegetarian
 * daughter's substitute main) — both may appear on one meal. Its `recipe_id`
 * must be a member of the sides pool and vegetarian, and paired sides are
 * capped week-wide — all enforced by the semantic `validate()`, not this
 * shape schema.
 */
export const SelectedMealSchema = z
  .object({
    slot_type: z.enum(["constrained", "relaxed"]),
    recipe_id: z.string(),
    title: z.string(),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    veg: VegPathSchema,
    flags: z
      .array(z.string())
      .transform((flags) => [...new Set(flags.map(sanitizeFlag))]),
    rationale: z.string(),
    side: z
      .object({ recipe_id: z.string(), title: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type SelectedMeal = z.infer<typeof SelectedMealSchema>;

/**
 * A single make-ahead prep unit (ADR 0004 D5): "prep Sun -> serve Tue".
 * `serve_date`/`prep_date` are unambiguous ISO calendar dates, matching
 * `day`'s format/rationale (ADR 0005 D2) rather than weekday names.
 * `prep_date` is nullable and starts `null` — v2.0's placement step
 * (bd meal-planner-468.2) fills it in by choosing an earlier suitable night
 * off the capacity schedule; `null` also covers the ADR 0004 D6 degraded
 * no-calendar path, where no earlier night can be chosen. This is the first
 * additive plan-schema evolution to carry a NESTED (object) value rather
 * than a flat scalar like `day` — hence its own reusable schema here rather
 * than inlining three fields onto `WeekPlanSchema`.
 */
export const PrepUnitSchema = z
  .object({
    description: z.string(),
    serve_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    prep_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .strict();
export type PrepUnit = z.infer<typeof PrepUnitSchema>;

/**
 * The full week's selection. `meals.length` is expected to equal
 * `slots.constrained + slots.relaxed` — that count check is also 8zs.4's
 * semantic `validate()`, not this shape schema.
 *
 * `prep` (ADR 0004 D5) is an OPTIONAL, additive array of {@link PrepUnit}s —
 * absent on any plan predating v2.0 prep scheduling (bd meal-planner-468) and
 * on a freshly-generated plan until 468.2 populates it; absent is equivalent
 * to "no prep units this week", not an error. Purely additive: existing
 * stored plans without a `prep` key keep parsing (resume-safety, bd6.10 /
 * bd6.13) — see `resolvePrepUnits` below for the read-side default, and
 * `orchestrator/resume.ts`'s `ResumedWeekPlanSchema` for the lenient-read
 * mirror of this same field.
 */
export const WeekPlanSchema = z
  .object({
    week_key: z.string(),
    meals: z.array(SelectedMealSchema),
    summary: z.string().optional(),
    prep: z.array(PrepUnitSchema).optional(),
  })
  .strict();
export type WeekPlan = z.infer<typeof WeekPlanSchema>;

/**
 * Forward-migration read helper (ADR 0004 D5, bd6.13): a plan that predates
 * prep scheduling carries no `prep` key at all. Backfills that absence to an
 * empty array so a caller (468.2's placement step, a future render) can
 * treat "no `prep` key" and "`prep: []`" identically as "no prep units this
 * week" without an `undefined` check at every call site. Never mutates its
 * input — this is a pure read, not a stored migration (there is nothing to
 * write back; the empty-array reading is synthesized on demand).
 */
export function resolvePrepUnits(plan: Pick<WeekPlan, "prep">): PrepUnit[] {
  return plan.prep ?? [];
}

/**
 * Thrown when the single selection call's response can't be turned into a
 * valid `WeekPlan` — either the response text contained no parseable JSON
 * object, or the parsed JSON didn't match `WeekPlanSchema`. Deliberately
 * carries only a short reason summary — never the raw prompt (which
 * includes household prose) or the raw LLM response text — so it's always
 * safe to log. Callers needing the bounded repair retry (8zs.4) wrap
 * `llmSelect` themselves; this function never retries.
 */
export class PlanSelectionError extends Error {
  constructor(reason: string) {
    super(`plan selection failed: ${reason}`);
    this.name = "PlanSelectionError";
  }
}

export interface LlmSelectDeps {
  llm: LlmClient;
}

/**
 * Runs ONE selection-shaped LLM call from an already-rendered `prompt` and
 * returns the raw response text. Split from `llmSelectFromPrompt` so a caller
 * that needs to build a SHAPE-repair prompt (8zs.10, `selectValidatedPlan` in
 * `validate.ts`) can hold onto the raw malformed text — which `PlanSelectionError`
 * deliberately does NOT carry — and quote it back to the model, mirroring
 * `recipe-mcp/extraction.ts`'s repair pattern. Any `runQuery` failure (e.g.
 * `LlmCallError`) propagates unwrapped.
 */
export async function runSelectionQuery(
  prompt: string,
  deps: LlmSelectDeps,
): Promise<string> {
  const result = await deps.llm.runQuery({ prompt });
  return result.text;
}

/**
 * Pure parse/shape-validate step (no LLM call): extracts a JSON object from
 * an LLM `text` response (tolerating prose/fences around it — see
 * `extractJsonObject`) and shape-validates it against `WeekPlanSchema`.
 * Throws `PlanSelectionError` on a JSON-parse failure or a schema-shape
 * failure.
 *
 * Split from the LLM call (`runSelectionQuery`) so the bounded repair retry
 * (8zs.10, `selectValidatedPlan`) can re-run this identical pipeline on a
 * repair response while keeping the raw text in hand for the repair prompt —
 * without duplicating the parse/validate logic.
 */
export function parseSelectionResponse(text: string): WeekPlan {
  let candidate: unknown;
  try {
    candidate = extractJsonObject(text);
  } catch (error) {
    throw new PlanSelectionError(
      `could not parse JSON from LLM response: ${(error as Error).message}`,
    );
  }

  const parsed = WeekPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlanSelectionError(
      `schema validation failed: ${summarizeZodError(parsed.error)}`,
    );
  }

  return parsed.data;
}

/**
 * Runs ONE selection-shaped LLM call from an already-rendered `prompt`:
 * calls `deps.llm.runQuery` exactly once (via `runSelectionQuery`), extracts a
 * JSON object from the response text, and shape-validates it against
 * `WeekPlanSchema`. Throws `PlanSelectionError` on a JSON-parse failure or a
 * schema-shape failure.
 *
 * Factored out of `llmSelect` so the bounded repair retry (8zs.4,
 * `selectValidatedPlan` in `validate.ts`) can run its ONE semantic-repair
 * prompt through the exact same parse/validate pipeline, without duplicating it
 * or widening `llmSelect`'s single-call-from-`PlannerInput` contract.
 */
export async function llmSelectFromPrompt(
  prompt: string,
  deps: LlmSelectDeps,
): Promise<WeekPlan> {
  return parseSelectionResponse(await runSelectionQuery(prompt, deps));
}

/**
 * Runs the SINGLE LLM selection call (ADR 0003 D1/D3: the LLM does
 * selection only, over the code-composed pools, in exactly one call — no
 * agentic loop, no retry here). Builds the prompt from `input` via
 * `buildSelectionPrompt` and delegates to `llmSelectFromPrompt`.
 *
 * Does NOT perform the semantic validation (slot counts, pool membership,
 * veg-consistency, no-dupes) or the bounded repair retry — those belong to
 * 8zs.4 (`validate.ts`'s `selectValidatedPlan`), which wraps this function.
 */
export async function llmSelect(
  input: PlannerInput,
  deps: LlmSelectDeps,
): Promise<WeekPlan> {
  const prompt = buildSelectionPrompt(input);
  return llmSelectFromPrompt(prompt, deps);
}
