import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "./embedder.js";
import type { ExtractedFields } from "./extraction.js";
import { CONFIDENCE_THRESHOLD, searchRecipes } from "./search.js";
import { StructuredStore } from "./structured-store.js";
import { VectorStore } from "./vector-store.js";

// Real in-memory VectorStore/StructuredStore (better-sqlite3 + sqlite-vec),
// matching the pattern in vector-store.test.ts, rather than hand-rolled
// mocks: both classes carry private fields, so a plain object literal can't
// structurally satisfy them anyway, and exercising the real SQL path is more
// faithful for a function that composes these two stores.

function makeFakeEmbedder(vector: number[]): Embedder {
  return { embed: vi.fn(async () => vector) };
}

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
    effort_tags: [],
    season_tags: [],
    ...overrides,
  };
}

function upsertRecipe(
  vectorStore: VectorStore,
  structuredStore: StructuredStore,
  id: string,
  vector: number[],
  title: string,
  fields: ExtractedFields | null,
) {
  vectorStore.upsert(id, vector, {
    title,
    body: "body",
    hash: `hash-${id}`,
    modifiedAt: new Date(),
  });
  if (fields) {
    structuredStore.upsertStructured(id, {
      contentHash: `hash-${id}`,
      extractorVersion: 1,
      fields,
      needsReview: false,
    });
  }
}

describe("searchRecipes", () => {
  it("embeds the query and vector-searches, returning candidates in similarity order", async () => {
    const { vectorStore, structuredStore } = makeStores();
    upsertRecipe(
      vectorStore,
      structuredStore,
      "note-close",
      [1, 0, 0],
      "Close",
      defaultFields(),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "note-far",
      [0, 0, 1],
      "Far",
      defaultFields(),
    );
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes("soup", undefined, {
      embedder,
      vectorStore,
      structuredStore,
    });

    expect(embedder.embed).toHaveBeenCalledWith("soup");
    expect(results.map((r) => r.id)).toEqual(["note-close", "note-far"]);
  });

  describe("active_max (hard, fail-closed)", () => {
    it("keeps a fast, high-confidence recipe", async () => {
      const { vectorStore, structuredStore } = makeStores();
      upsertRecipe(
        vectorStore,
        structuredStore,
        "fast",
        [1, 0, 0],
        "Fast",
        defaultFields({
          time: { active: 15, total: 20, prep: 5, confidence: 0.9 },
        }),
      );
      const embedder = makeFakeEmbedder([1, 0, 0]);

      const results = await searchRecipes(
        "soup",
        { active_max: 30 },
        { embedder, vectorStore, structuredStore },
      );

      expect(results.map((r) => r.id)).toEqual(["fast"]);
    });

    it("drops a recipe with a null active time", async () => {
      const { vectorStore, structuredStore } = makeStores();
      upsertRecipe(
        vectorStore,
        structuredStore,
        "null-active",
        [1, 0, 0],
        "Null active",
        defaultFields({
          time: { active: null, total: 30, prep: 10, confidence: 0.9 },
        }),
      );
      const embedder = makeFakeEmbedder([1, 0, 0]);

      const results = await searchRecipes(
        "soup",
        { active_max: 30 },
        { embedder, vectorStore, structuredStore },
      );

      expect(results).toEqual([]);
    });

    it("drops a low-confidence active time even when the value itself is fast (fail-closed)", async () => {
      const { vectorStore, structuredStore } = makeStores();
      upsertRecipe(
        vectorStore,
        structuredStore,
        "low-confidence",
        [1, 0, 0],
        "Low confidence",
        defaultFields({
          time: {
            active: 10,
            total: 20,
            prep: 5,
            confidence: CONFIDENCE_THRESHOLD - 0.01,
          },
        }),
      );
      const embedder = makeFakeEmbedder([1, 0, 0]);

      const results = await searchRecipes(
        "soup",
        { active_max: 30 },
        { embedder, vectorStore, structuredStore },
      );

      expect(results).toEqual([]);
    });

    it("drops a too-slow recipe", async () => {
      const { vectorStore, structuredStore } = makeStores();
      upsertRecipe(
        vectorStore,
        structuredStore,
        "slow",
        [1, 0, 0],
        "Slow",
        defaultFields({
          time: { active: 90, total: 120, prep: 20, confidence: 0.9 },
        }),
      );
      const embedder = makeFakeEmbedder([1, 0, 0]);

      const results = await searchRecipes(
        "soup",
        { active_max: 30 },
        { embedder, vectorStore, structuredStore },
      );

      expect(results).toEqual([]);
    });

    it("drops a candidate with no structured record at all", async () => {
      const { vectorStore, structuredStore } = makeStores();
      upsertRecipe(
        vectorStore,
        structuredStore,
        "unextracted",
        [1, 0, 0],
        "Unextracted",
        null,
      );
      const embedder = makeFakeEmbedder([1, 0, 0]);

      const results = await searchRecipes(
        "soup",
        { active_max: 30 },
        { embedder, vectorStore, structuredStore },
      );

      expect(results).toEqual([]);
    });

    it("keeps a candidate with no structured record when the query is unfiltered (weekend)", async () => {
      const { vectorStore, structuredStore } = makeStores();
      upsertRecipe(
        vectorStore,
        structuredStore,
        "unextracted",
        [1, 0, 0],
        "Unextracted",
        null,
      );
      const embedder = makeFakeEmbedder([1, 0, 0]);

      const results = await searchRecipes("soup", undefined, {
        embedder,
        vectorStore,
        structuredStore,
      });

      expect(results.map((r) => r.id)).toEqual(["unextracted"]);
      expect(results[0].veg_status).toBe("unknown");
      expect(results[0].time).toEqual({
        active: null,
        total: null,
        prep: null,
        confidence: 0,
      });
    });
  });

  it("filters by veg_status", async () => {
    const { vectorStore, structuredStore } = makeStores();
    upsertRecipe(
      vectorStore,
      structuredStore,
      "veg",
      [1, 0, 0],
      "Veg",
      defaultFields({ veg_status: "vegetarian" }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "meat",
      [1, 0, 0],
      "Meat",
      defaultFields({ veg_status: "contains_meat" }),
    );
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes(
      "soup",
      { veg_status: "vegetarian" },
      { embedder, vectorStore, structuredStore },
    );

    expect(results.map((r) => r.id)).toEqual(["veg"]);
  });

  it("filters by season tag", async () => {
    const { vectorStore, structuredStore } = makeStores();
    upsertRecipe(
      vectorStore,
      structuredStore,
      "summer",
      [1, 0, 0],
      "Summer",
      defaultFields({ season_tags: ["summer"] }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "winter",
      [1, 0, 0],
      "Winter",
      defaultFields({ season_tags: ["winter"] }),
    );
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes(
      "soup",
      { season: "summer" },
      { embedder, vectorStore, structuredStore },
    );

    expect(results.map((r) => r.id)).toEqual(["summer"]);
  });

  it("filters by effort tags using include-any semantics", async () => {
    const { vectorStore, structuredStore } = makeStores();
    upsertRecipe(
      vectorStore,
      structuredStore,
      "quick",
      [1, 0, 0],
      "Quick",
      defaultFields({ effort_tags: ["quick"] }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "do-ahead",
      [1, 0, 0],
      "Do ahead",
      defaultFields({ effort_tags: ["do-ahead"] }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "involved",
      [1, 0, 0],
      "Involved",
      defaultFields({ effort_tags: ["involved"] }),
    );
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes(
      "soup",
      { effort: ["quick", "do-ahead"] },
      { embedder, vectorStore, structuredStore },
    );

    expect(results.map((r) => r.id).sort()).toEqual(["do-ahead", "quick"]);
  });

  it("passes exclude_ids through to the vector search", async () => {
    const { vectorStore, structuredStore } = makeStores();
    upsertRecipe(
      vectorStore,
      structuredStore,
      "note-a",
      [1, 0, 0],
      "A",
      defaultFields(),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "note-b",
      [0.9, 0.1, 0],
      "B",
      defaultFields(),
    );
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes(
      "soup",
      { exclude_ids: ["note-a"] },
      { embedder, vectorStore, structuredStore },
    );

    expect(results.map((r) => r.id)).toEqual(["note-b"]);
  });

  it("respects the limit option", async () => {
    const { vectorStore, structuredStore } = makeStores();
    for (let i = 0; i < 5; i++) {
      upsertRecipe(
        vectorStore,
        structuredStore,
        `note-${i}`,
        [1, 0, 0],
        `Note ${i}`,
        defaultFields(),
      );
    }
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes(
      "soup",
      { limit: 2 },
      { embedder, vectorStore, structuredStore },
    );

    expect(results).toHaveLength(2);
  });

  it("over-fetches so the post-filter result can still reach limit", async () => {
    const { vectorStore, structuredStore } = makeStores();
    // Six candidates ranked by similarity to the query vector [1,0,0]; the
    // three MOST similar are non-vegetarian, the three LEAST similar are
    // vegetarian. A naive (non-over-fetching) limit:3 vector fetch would
    // pull in only the non-vegetarian trio and yield zero results after the
    // veg_status filter; over-fetching pulls in all six so the filter still
    // has enough candidates to fill limit:3.
    upsertRecipe(
      vectorStore,
      structuredStore,
      "meat-1",
      [1, 0, 0],
      "Meat 1",
      defaultFields({ veg_status: "contains_meat" }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "meat-2",
      [0.95, 0.05, 0],
      "Meat 2",
      defaultFields({ veg_status: "contains_meat" }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "meat-3",
      [0.9, 0.1, 0],
      "Meat 3",
      defaultFields({ veg_status: "contains_meat" }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "veg-1",
      [0.5, 0.5, 0],
      "Veg 1",
      defaultFields({ veg_status: "vegetarian" }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "veg-2",
      [0.4, 0.6, 0],
      "Veg 2",
      defaultFields({ veg_status: "vegetarian" }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "veg-3",
      [0.3, 0.7, 0],
      "Veg 3",
      defaultFields({ veg_status: "vegetarian" }),
    );
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes(
      "soup",
      { veg_status: "vegetarian", limit: 3 },
      { embedder, vectorStore, structuredStore },
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.veg_status === "vegetarian")).toBe(true);
  });

  it("under-fills (returns fewer than limit) rather than erroring when the store can't supply enough matches", async () => {
    const { vectorStore, structuredStore } = makeStores();
    upsertRecipe(
      vectorStore,
      structuredStore,
      "veg-1",
      [1, 0, 0],
      "Veg 1",
      defaultFields({ veg_status: "vegetarian" }),
    );
    upsertRecipe(
      vectorStore,
      structuredStore,
      "meat-1",
      [0.9, 0.1, 0],
      "Meat 1",
      defaultFields({ veg_status: "contains_meat" }),
    );
    const embedder = makeFakeEmbedder([1, 0, 0]);

    const results = await searchRecipes(
      "soup",
      { veg_status: "vegetarian", limit: 5 },
      { embedder, vectorStore, structuredStore },
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("veg-1");
  });
});
