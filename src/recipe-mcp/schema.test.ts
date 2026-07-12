import { describe, expect, it } from "vitest";
import {
  IngredientSchema,
  QualitySchema,
  QuantitySchema,
  RecipeCandidateSchema,
  RecipeSchema,
  TimeFieldsSchema,
} from "./schema.js";

function validTimeFields() {
  return { active: 20, total: 45, prep: 10, confidence: 0.8 };
}

function validIngredient(overrides: Record<string, unknown> = {}) {
  return {
    raw: "2-3 cloves garlic, minced",
    name: "garlic",
    quantity: { kind: "range", min: 2, max: 3 },
    optional: false,
    confidence: 0.9,
    needs_review: false,
    ...overrides,
  };
}

function validRecipeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "recipe-1",
    title: "Garlic Butter Chicken",
    time: validTimeFields(),
    effort_tags: ["weeknight"],
    season_tags: ["all"],
    veg_status: "contains_meat",
    ...overrides,
  };
}

describe("QuantitySchema", () => {
  it("parses a scalar quantity", () => {
    const result = QuantitySchema.safeParse({ kind: "scalar", value: 2 });
    expect(result.success).toBe(true);
  });

  it("parses a range quantity", () => {
    const result = QuantitySchema.safeParse({ kind: "range", min: 2, max: 3 });
    expect(result.success).toBe(true);
  });

  it("parses a none quantity", () => {
    const result = QuantitySchema.safeParse({ kind: "none" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = QuantitySchema.safeParse({ kind: "bogus", value: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects a range where min > max", () => {
    const result = QuantitySchema.safeParse({ kind: "range", min: 5, max: 3 });
    expect(result.success).toBe(false);
  });

  it("accepts a range where min === max", () => {
    const result = QuantitySchema.safeParse({ kind: "range", min: 3, max: 3 });
    expect(result.success).toBe(true);
  });
});

describe("QualitySchema", () => {
  it.each([3, 4, 5, "untested"])("accepts %p", (value) => {
    expect(QualitySchema.safeParse(value).success).toBe(true);
  });

  it.each([2, 6, "great", 3.5])("rejects %p", (value) => {
    expect(QualitySchema.safeParse(value).success).toBe(false);
  });
});

describe("TimeFieldsSchema", () => {
  it("parses valid time fields, including null times", () => {
    const result = TimeFieldsSchema.safeParse({
      active: null,
      total: null,
      prep: null,
      confidence: 0.5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects confidence below 0", () => {
    const result = TimeFieldsSchema.safeParse({
      ...validTimeFields(),
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const result = TimeFieldsSchema.safeParse({
      ...validTimeFields(),
      confidence: 1.1,
    });
    expect(result.success).toBe(false);
  });
});

describe("IngredientSchema", () => {
  it("parses a minimal valid ingredient without optional fields", () => {
    const result = IngredientSchema.safeParse(validIngredient());
    expect(result.success).toBe(true);
  });

  it("parses a full ingredient with all optional fields present", () => {
    const result = IngredientSchema.safeParse(
      validIngredient({
        prep: "minced",
        unit: null,
        alternatives: ["butter", "olive oil"],
        group: "for the sauce",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("requires raw on every ingredient", () => {
    const { raw: _raw, ...withoutRaw } = validIngredient();
    const result = IngredientSchema.safeParse(withoutRaw);
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0..1", () => {
    const result = IngredientSchema.safeParse(
      validIngredient({ confidence: 1.5 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a bad quantity kind nested inside an ingredient", () => {
    const result = IngredientSchema.safeParse(
      validIngredient({ quantity: { kind: "bogus" } }),
    );
    expect(result.success).toBe(false);
  });

  it("does not define a package_size field", () => {
    expect(Object.keys(IngredientSchema.shape)).not.toContain("package_size");
  });
});

describe("RecipeCandidateSchema", () => {
  it("parses a valid candidate", () => {
    const result = RecipeCandidateSchema.safeParse(validRecipeCandidate());
    expect(result.success).toBe(true);
  });

  it("does not require ingredients", () => {
    const candidate = validRecipeCandidate();
    expect("ingredients" in candidate).toBe(false);
    const result = RecipeCandidateSchema.safeParse(candidate);
    expect(result.success).toBe(true);
  });

  it("accepts an optional quality field", () => {
    const result = RecipeCandidateSchema.safeParse(
      validRecipeCandidate({ quality: "untested" }),
    );
    expect(result.success).toBe(true);
  });
});

describe("RecipeSchema", () => {
  it("parses a full recipe including ingredients", () => {
    const result = RecipeSchema.safeParse({
      ...validRecipeCandidate(),
      ingredients: [validIngredient()],
      body: "Cook the chicken in butter.",
      source_note_id: "note-123",
    });
    expect(result.success).toBe(true);
  });

  it("requires source_note_id", () => {
    const { source_note_id: _sourceNoteId, ...withoutSourceNoteId } = {
      ...validRecipeCandidate(),
      ingredients: [validIngredient()],
      source_note_id: "note-123",
    };
    const result = RecipeSchema.safeParse(withoutSourceNoteId);
    expect(result.success).toBe(false);
  });

  it("requires ingredients to be an array of valid Ingredient", () => {
    const result = RecipeSchema.safeParse({
      ...validRecipeCandidate(),
      ingredients: [{ raw: "1 cup rice" }],
      source_note_id: "note-123",
    });
    expect(result.success).toBe(false);
  });
});
