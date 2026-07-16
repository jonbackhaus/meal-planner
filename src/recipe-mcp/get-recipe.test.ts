import { describe, expect, it } from "vitest";
import type { ExtractedFields } from "./extraction.js";
import { getRecipe } from "./get-recipe.js";
import { RecipeSchema } from "./schema.js";
import { StructuredStore } from "./structured-store.js";
import { VectorStore } from "./vector-store.js";

// Real in-memory VectorStore/StructuredStore (better-sqlite3 + sqlite-vec),
// matching the pattern in search.test.ts, rather than hand-rolled mocks: both
// classes carry private fields, so a plain object literal can't structurally
// satisfy them anyway.

function makeStores(dimensions = 3) {
  const vectorStore = new VectorStore({ path: ":memory:", dimensions });
  const structuredStore = new StructuredStore({ path: ":memory:" });
  return { vectorStore, structuredStore };
}

function defaultFields(
  overrides: Partial<ExtractedFields> = {},
): ExtractedFields {
  return {
    time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
    veg_status: "vegetarian",
    ingredients: [],
    ...overrides,
  };
}

describe("getRecipe", () => {
  it("returns the complete Recipe with the ingredient block and correct source_note_id", async () => {
    const { vectorStore, structuredStore } = makeStores();
    vectorStore.upsert("note-1", [1, 0, 0], {
      title: "Tomato Soup",
      body: "Simmer tomatoes...",
      hash: "hash-1",
      modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const ingredients = [
      {
        raw: "2 cups tomatoes, diced",
        name: "tomatoes",
        prep: "diced",
        quantity: { kind: "scalar" as const, value: 2 },
        unit: "cups",
        optional: false,
        confidence: 0.9,
        needs_review: false,
      },
      {
        raw: "1-2 cloves garlic or 1 tsp garlic powder, optional",
        name: "garlic",
        quantity: { kind: "range" as const, min: 1, max: 2 },
        unit: "cloves",
        optional: true,
        alternatives: ["garlic powder"],
        confidence: 0.7,
        needs_review: false,
      },
    ];
    structuredStore.upsertStructured("note-1", {
      contentHash: "hash-1",
      extractorVersion: 1,
      fields: defaultFields({
        veg_status: "vegetarian",
        ingredients,
      }),
      needsReview: false,
    });

    const recipe = await getRecipe("note-1", {
      noteStore: vectorStore,
      structuredStore,
    });

    expect(recipe).not.toBeNull();
    expect(recipe).toEqual({
      id: "note-1",
      title: "Tomato Soup",
      time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
      veg_status: "vegetarian",
      ingredients,
      body: "Simmer tomatoes...",
      source_note_id: "note-1",
      // Tag-derived fields (no tags set on this note -> empty/defaults).
      effort_tags: [],
      season_tags: [],
      tags: [],
      is_side: false,
      main_dinner_eligible: true,
    });
    expect(recipe?.ingredients).toEqual(ingredients);
  });

  it("returns null for an unknown id", async () => {
    const { vectorStore, structuredStore } = makeStores();

    const recipe = await getRecipe("missing", {
      noteStore: vectorStore,
      structuredStore,
    });

    expect(recipe).toBeNull();
  });

  it("returns null when the note exists but has no structured fields yet (not-ready)", async () => {
    const { vectorStore, structuredStore } = makeStores();
    vectorStore.upsert("note-pending", [1, 0, 0], {
      title: "Unextracted Recipe",
      body: "body",
      hash: "hash-pending",
      modifiedAt: new Date(),
    });
    // No upsertStructured call at all: never extracted.

    const recipe = await getRecipe("note-pending", {
      noteStore: vectorStore,
      structuredStore,
    });

    expect(recipe).toBeNull();
  });

  it("returns null when the note has a needs_review record with fields: null", async () => {
    const { vectorStore, structuredStore } = makeStores();
    vectorStore.upsert("note-failed", [1, 0, 0], {
      title: "Failed Extraction",
      body: "body",
      hash: "hash-failed",
      modifiedAt: new Date(),
    });
    structuredStore.upsertStructured("note-failed", {
      contentHash: "hash-failed",
      extractorVersion: 1,
      fields: null,
      needsReview: true,
    });

    const recipe = await getRecipe("note-failed", {
      noteStore: vectorStore,
      structuredStore,
    });

    expect(recipe).toBeNull();
  });

  it("returns an object that passes RecipeSchema validation", async () => {
    const { vectorStore, structuredStore } = makeStores();
    vectorStore.upsert("note-2", [1, 0, 0], {
      title: "Chili",
      body: "Brown the beef...",
      hash: "hash-2",
      modifiedAt: new Date(),
    });
    structuredStore.upsertStructured("note-2", {
      contentHash: "hash-2",
      extractorVersion: 1,
      fields: defaultFields({ veg_status: "contains_meat" }),
      needsReview: false,
    });

    const recipe = await getRecipe("note-2", {
      noteStore: vectorStore,
      structuredStore,
    });

    expect(() => RecipeSchema.parse(recipe)).not.toThrow();
  });
});
