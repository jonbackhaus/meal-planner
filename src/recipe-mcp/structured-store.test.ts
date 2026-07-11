import { describe, expect, it } from "vitest";
import type { ExtractedFields } from "./extraction.js";
import { EXTRACTOR_VERSION, StructuredStore } from "./structured-store.js";

function fields(overrides: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    time: { active: 20, total: 45, prep: 10, confidence: 0.8 },
    ingredients: [
      {
        raw: "1 lb ground beef",
        name: "ground beef",
        quantity: { kind: "scalar", value: 1 },
        unit: "lb",
        optional: false,
        confidence: 0.9,
        needs_review: false,
      },
    ],
    veg_status: "contains_meat",
    effort_tags: ["weeknight"],
    season_tags: ["all"],
    quality: "untested",
    ...overrides,
  };
}

describe("StructuredStore", () => {
  it("returns null for a note that has never been stored", () => {
    const store = new StructuredStore({ path: ":memory:" });
    expect(store.getStructured("missing-note")).toBeNull();
    store.close();
  });

  it("round-trips an upsert through get", () => {
    const store = new StructuredStore({ path: ":memory:" });

    store.upsertStructured("note-1", {
      contentHash: "hash-a",
      extractorVersion: EXTRACTOR_VERSION,
      fields: fields(),
      needsReview: false,
    });

    const record = store.getStructured("note-1");
    expect(record).toEqual({
      contentHash: "hash-a",
      extractorVersion: EXTRACTOR_VERSION,
      fields: fields(),
      needsReview: false,
    });
    store.close();
  });

  it("updates an existing note's record on a second upsert (not a duplicate row)", () => {
    const store = new StructuredStore({ path: ":memory:" });

    store.upsertStructured("note-1", {
      contentHash: "hash-a",
      extractorVersion: EXTRACTOR_VERSION,
      fields: fields(),
      needsReview: false,
    });
    store.upsertStructured("note-1", {
      contentHash: "hash-b",
      extractorVersion: EXTRACTOR_VERSION,
      fields: fields({ veg_status: "vegetarian" }),
      needsReview: false,
    });

    const record = store.getStructured("note-1");
    expect(record?.contentHash).toBe("hash-b");
    expect(record?.fields?.veg_status).toBe("vegetarian");
    store.close();
  });

  it("stores a minimal needs_review record with null fields (failure path)", () => {
    const store = new StructuredStore({ path: ":memory:" });

    store.upsertStructured("note-1", {
      contentHash: "hash-a",
      extractorVersion: EXTRACTOR_VERSION,
      fields: null,
      needsReview: true,
    });

    const record = store.getStructured("note-1");
    expect(record).toEqual({
      contentHash: "hash-a",
      extractorVersion: EXTRACTOR_VERSION,
      fields: null,
      needsReview: true,
    });
    store.close();
  });

  it("exports an EXTRACTOR_VERSION constant", () => {
    expect(typeof EXTRACTOR_VERSION).toBe("number");
  });
});
