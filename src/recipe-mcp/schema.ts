import { z } from "zod";

/**
 * Frozen structured-field schema for the recipe MCP server (ADR 0001 D4).
 *
 * "Capture is not aggregation": v1.0 losslessly CAPTURES what a recipe note
 * contains; later phases reconcile/aggregate. `raw` is ALWAYS kept on every
 * Ingredient as the lossless fallback.
 *
 * RATIFIED (bd meal-planner-9yf): package_size is intentionally NOT a field
 * here. Count-with-package-size ("1 can (14 oz)") stays in the `raw` line for
 * v1.0; a later phase parses it out of `raw`.
 *
 * Zod schemas are the single source of truth; TS types are derived via
 * `z.infer` so the runtime validators and the static types can't drift
 * (matches the convention in src/config/config.ts).
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export const MinutesSchema = z.number();
export type Minutes = z.infer<typeof MinutesSchema>;

const QuantityBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scalar"), value: z.number() }),
  z.object({ kind: z.literal("range"), min: z.number(), max: z.number() }),
  z.object({ kind: z.literal("none") }),
]);

export const QuantitySchema = QuantityBaseSchema.superRefine(
  (quantity, ctx) => {
    if (quantity.kind === "range" && quantity.min > quantity.max) {
      ctx.addIssue({
        code: "custom",
        message: "range min must be <= max",
        path: ["max"],
      });
    }
  },
);
export type Quantity = z.infer<typeof QuantityBaseSchema>;

export const VegStatusSchema = z.enum([
  "vegetarian",
  "contains_meat",
  "unknown",
]);
export type VegStatus = z.infer<typeof VegStatusSchema>;

export const QualitySchema = z.union([
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal("untested"),
]);
export type Quality = z.infer<typeof QualitySchema>;

export const TimeFieldsSchema = z.object({
  active: MinutesSchema.nullable(),
  total: MinutesSchema.nullable(),
  prep: MinutesSchema.nullable(),
  confidence: z.number().min(0).max(1),
});
export type TimeFields = z.infer<typeof TimeFieldsSchema>;

// ---------------------------------------------------------------------------
// Ingredient (the frozen capture schema — per ingredient)
// ---------------------------------------------------------------------------

export const IngredientSchema = z.object({
  raw: z.string(),
  name: z.string(),
  prep: z.string().optional(),
  quantity: QuantitySchema,
  unit: z.string().nullable().optional(),
  optional: z.boolean(),
  alternatives: z.array(z.string()).optional(),
  group: z.string().optional(),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean(),
});
export type Ingredient = z.infer<typeof IngredientSchema>;

// ---------------------------------------------------------------------------
// Two-tier shapes
// ---------------------------------------------------------------------------

export const RecipeCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  time: TimeFieldsSchema,
  effort_tags: z.array(z.string()),
  season_tags: z.array(z.string()),
  quality: QualitySchema.optional(),
  veg_status: VegStatusSchema,
  // NoteStore hashtags (normalized) + planner-relevant derivations. Optional
  // for back-compat with existing candidate construction; a missing
  // `main_dinner_eligible` is treated as eligible, a missing `is_side` as false.
  tags: z.array(z.string()).optional(),
  is_side: z.boolean().optional(),
  main_dinner_eligible: z.boolean().optional(),
});
export type RecipeCandidate = z.infer<typeof RecipeCandidateSchema>;

export const RecipeSchema = RecipeCandidateSchema.extend({
  ingredients: z.array(IngredientSchema),
  body: z.string().optional(),
  source_note_id: z.string(),
});
export type Recipe = z.infer<typeof RecipeSchema>;
