import { z } from "zod";
import { extractJsonObject } from "../lib/json-extraction.js";
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
  z.object({ kind: z.literal("inherent") }),
  z.object({ kind: z.literal("separable"), note: z.string() }),
  z.object({
    kind: z.literal("second_dish"),
    recipe_id: z.string(),
    title: z.string(),
  }),
]);
export type VegPath = z.infer<typeof VegPathSchema>;

/**
 * One selected meal. `recipe_id` MUST be a member of the matching pool —
 * that pool-membership check (along with counts/veg-consistency/no-dupes)
 * is the semantic `validate()` in 8zs.4, NOT enforced by this shape schema.
 * `day` is v1.0's literal `null` — day-of-week assignment is v2.0 scope.
 */
export const SelectedMealSchema = z.object({
  slot_type: z.enum(["constrained", "relaxed"]),
  recipe_id: z.string(),
  title: z.string(),
  day: z.null(),
  veg: VegPathSchema,
  flags: z.array(z.string()),
  rationale: z.string(),
});
export type SelectedMeal = z.infer<typeof SelectedMealSchema>;

/**
 * The full week's selection. `meals.length` is expected to equal
 * `slots.constrained + slots.relaxed` — that count check is also 8zs.4's
 * semantic `validate()`, not this shape schema.
 */
export const WeekPlanSchema = z.object({
  week_key: z.string(),
  meals: z.array(SelectedMealSchema),
  summary: z.string().optional(),
});
export type WeekPlan = z.infer<typeof WeekPlanSchema>;

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

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

export interface LlmSelectDeps {
  llm: LlmClient;
}

/**
 * Runs the SINGLE LLM selection call (ADR 0003 D1/D3: the LLM does
 * selection only, over the code-composed pools, in exactly one call — no
 * agentic loop, no retry here). Builds the prompt from `input` via
 * `buildSelectionPrompt`, calls `deps.llm.runQuery` exactly once, extracts a
 * JSON object from the response text (tolerating prose/fences around it —
 * see `extractJsonObject`), and shape-validates it against `WeekPlanSchema`.
 *
 * Throws `PlanSelectionError` on a JSON-parse failure or a schema-shape
 * failure. Does NOT perform the semantic validation (slot counts, pool
 * membership, veg-consistency, no-dupes) or the bounded repair retry —
 * those belong to 8zs.4, which wraps this function.
 */
export async function llmSelect(
  input: PlannerInput,
  deps: LlmSelectDeps,
): Promise<WeekPlan> {
  const prompt = buildSelectionPrompt(input);
  const result = await deps.llm.runQuery({ prompt });

  let candidate: unknown;
  try {
    candidate = extractJsonObject(result.text);
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
