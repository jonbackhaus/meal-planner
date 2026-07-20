import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../recipe-mcp/embedder.js";
import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import { type SearchFilters, searchRecipes } from "../recipe-mcp/search.js";
import { StructuredStore } from "../recipe-mcp/structured-store.js";
import { VectorStore } from "../recipe-mcp/vector-store.js";
import { composePools, type PoolCompositionConfig } from "./pools.js";

function candidate(
  id: string,
  overrides: Partial<RecipeCandidate> = {},
): RecipeCandidate {
  return {
    id,
    title: `Recipe ${id}`,
    time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
    effort_tags: [],
    season_tags: [],
    veg_status: "contains_meat",
    ...overrides,
  };
}

const baseCfg: PoolCompositionConfig = {
  cookNights: { constrained: 4, relaxed: 2 },
  activeMaxMinutes: 60,
  fanoutMultiplier: 4,
  vegFloorK: 2,
  untestedRate: 0.15,
};

interface Fixtures {
  weeknightBase: RecipeCandidate[];
  weeknightVegTopUp?: RecipeCandidate[];
  weeknightUntestedOverfetch?: RecipeCandidate[];
  weekendBase: RecipeCandidate[];
  weekendVegTopUp?: RecipeCandidate[];
  weekendUntestedOverfetch?: RecipeCandidate[];
  /** The side-dish pool (bd meal-planner-8zs.8), keyed by the `sides_only` filter. */
  sides?: RecipeCandidate[];
}

/**
 * A fake `search` keyed by FILTER SHAPE, not call order: composePools's exact
 * call sequencing (e.g. whether weeknight/weekend run sequentially or
 * interleaved) is an implementation detail these tests shouldn't pin down.
 * The three query kinds are structurally distinguishable by their quality-aware
 * filters (bd meal-planner-8zs.6): the untested injection carries
 * `quality: "untested"`; the veg-floor top-up carries `veg_status: "vegetarian"`
 * (over the rated base); the rated base carries neither.
 */
function makeFakeSearch(fixtures: Fixtures) {
  return vi.fn(async (_query: string, filters?: SearchFilters) => {
    const isWeeknight = filters?.active_max !== undefined;

    // Side pool (bd meal-planner-8zs.8): the positive #side selector. Checked
    // FIRST since it also carries veg_status:"vegetarian" (would otherwise fall
    // into the veg-floor branch below).
    if (filters?.sides_only) {
      return fixtures.sides ?? [];
    }
    if (filters?.quality === "untested") {
      return (
        (isWeeknight
          ? fixtures.weeknightUntestedOverfetch
          : fixtures.weekendUntestedOverfetch) ?? []
      );
    }
    if (filters?.veg_status === "vegetarian") {
      return (
        (isWeeknight ? fixtures.weeknightVegTopUp : fixtures.weekendVegTopUp) ??
        []
      );
    }
    return isWeeknight ? fixtures.weeknightBase : fixtures.weekendBase;
  });
}

describe("composePools", () => {
  it("searches the weeknight pool with active_max and the constrained*fanout limit", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2", { veg_status: "vegetarian" }),
        candidate("wn-3", { quality: "untested" }),
        candidate("wn-4"),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    await composePools(["family dinner"], baseCfg, { search });

    expect(search).toHaveBeenCalledWith("family dinner", {
      active_max: 60,
      main_dinner_only: true,
      quality: "rated",
      limit: 16,
    });
  });

  it("searches the weekend pool WITHOUT active_max and the relaxed*fanout limit", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2", { veg_status: "vegetarian" }),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    await composePools(["family dinner"], baseCfg, { search });

    expect(search).toHaveBeenCalledWith("family dinner", {
      main_dinner_only: true,
      quality: "rated",
      limit: 8,
    });
    const weekendCall = search.mock.calls.find(
      ([, filters]) => filters?.limit === 8 && filters?.quality === "rated",
    );
    expect(weekendCall?.[1]).not.toHaveProperty("active_max");
  });

  it("triggers a veg-floor top-up search when a pool has fewer than vegFloorK vegetarian candidates", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }), // only 1 < vegFloorK(2)
        candidate("wn-2"),
        candidate("wn-3"),
      ],
      weeknightVegTopUp: [candidate("wn-veg-1", { veg_status: "vegetarian" })],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    expect(search).toHaveBeenCalledWith("family dinner", {
      active_max: 60,
      main_dinner_only: true,
      quality: "rated",
      veg_status: "vegetarian",
      limit: 16,
    });
    expect(pools.weeknight.map((c) => c.id)).toContain("wn-veg-1");
  });

  it("does NOT trigger a veg-floor top-up when the pool already meets the floor", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2", { veg_status: "vegetarian" }),
        candidate("wn-3"),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    await composePools(["family dinner"], baseCfg, { search });

    const vegQueryForWeeknight = search.mock.calls.some(
      ([, filters]) =>
        filters?.active_max === 60 && filters?.veg_status === "vegetarian",
    );
    expect(vegQueryForWeeknight).toBe(false);
  });

  it("merges veg-floor top-up results deduped by id (no duplicate ids in the final pool)", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2"),
      ],
      // Surfaces one brand-new id AND re-surfaces an id already in the pool.
      weeknightVegTopUp: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-veg-new", { veg_status: "vegetarian" }),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    const ids = pools.weeknight.map((c) => c.id);
    expect(ids).toEqual(["wn-1", "wn-2", "wn-veg-new"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("caps the veg-floor merge at the floor deficit, even when the top-up returns more", async () => {
    // vegCount=1, vegFloorK=2 -> deficit=1, but the top-up surfaces 3 new
    // vegetarian ids. Only the deficit (1) should be merged in, matching
    // injectUntested's `maxAdd` capping behavior.
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2"),
        candidate("wn-3"),
      ],
      weeknightVegTopUp: [
        candidate("wn-veg-a", { veg_status: "vegetarian" }),
        candidate("wn-veg-b", { veg_status: "vegetarian" }),
        candidate("wn-veg-c", { veg_status: "vegetarian" }),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    expect(pools.weeknight.map((c) => c.id)).toEqual([
      "wn-1",
      "wn-2",
      "wn-3",
      "wn-veg-a",
    ]);
    expect(pools.weeknight).toHaveLength(4);
  });

  it("injects untested candidates surfaced by the overfetch, up to ceil(untestedRate * poolSize)", async () => {
    // poolSize 10 (2 vegetarian -> floor already met), untestedRate 0.15 -> ceil(1.5) = 2 needed.
    const search = makeFakeSearch({
      weeknightBase: Array.from({ length: 10 }, (_, i) =>
        candidate(`wn-${i}`, {
          veg_status: i < 2 ? "vegetarian" : "contains_meat",
        }),
      ),
      weeknightUntestedOverfetch: [
        candidate("wn-untested-1", { quality: "untested" }),
        candidate("wn-untested-2", { quality: "untested" }),
        candidate("wn-untested-3", { quality: "untested" }), // surplus beyond the needed 2
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    const untestedIds = pools.weeknight
      .filter((c) => c.quality === "untested")
      .map((c) => c.id);
    expect(untestedIds).toEqual(["wn-untested-1", "wn-untested-2"]);
    expect(pools.weeknight).toHaveLength(12);
  });

  it("issues the untested-injection search with quality:'untested' (not the rated base filter) — bd meal-planner-8zs.6", async () => {
    const search = makeFakeSearch({
      weeknightBase: Array.from({ length: 10 }, (_, i) =>
        candidate(`wn-${i}`, {
          veg_status: i < 2 ? "vegetarian" : "contains_meat",
        }),
      ),
      weeknightUntestedOverfetch: [
        candidate("wn-untested-1", { quality: "untested" }),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    await composePools(["family dinner"], baseCfg, { search });

    const untestedCall = search.mock.calls.find(
      ([, filters]) => filters?.quality === "untested",
    );
    expect(untestedCall).toBeDefined();
    // The injection must NOT restrict to rated, or it could never find untested.
    expect(untestedCall?.[1]).toMatchObject({
      active_max: 60,
      main_dinner_only: true,
      quality: "untested",
    });
  });

  it("is a no-op when the untested overfetch surfaces no untested candidates", async () => {
    const search = makeFakeSearch({
      weeknightBase: Array.from({ length: 10 }, (_, i) =>
        candidate(`wn-${i}`, {
          veg_status: i < 2 ? "vegetarian" : "contains_meat",
        }),
      ),
      weeknightUntestedOverfetch: [
        candidate("wn-extra", { veg_status: "contains_meat" }), // no untested surfaces
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    expect(pools.weeknight).toHaveLength(10);
    expect(pools.weeknight.some((c) => c.quality === "untested")).toBe(false);
  });

  it("returns pools of RecipeCandidate (lightweight, no ingredient block)", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2", { veg_status: "vegetarian" }),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    for (const c of [...pools.weeknight, ...pools.weekend]) {
      expect(c).not.toHaveProperty("ingredients");
      expect(typeof c.id).toBe("string");
      expect(typeof c.title).toBe("string");
    }
  });

  // ── Optional side pool (bd meal-planner-8zs.8) ──
  it("populates Pools.sides via a sides_only, vegetarian search", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2", { veg_status: "vegetarian" }),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
      sides: [
        candidate("side-1", { veg_status: "vegetarian", is_side: true }),
        candidate("side-2", { veg_status: "vegetarian", is_side: true }),
      ],
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    expect(pools.sides?.map((c) => c.id)).toEqual(["side-1", "side-2"]);
    // The side search is issued with the positive selector + veg gate, sized by
    // maxPairedSides (default 2) * fanout (4) = 8, season-free here.
    const sideCall = search.mock.calls.find(
      ([, filters]) => filters?.sides_only,
    );
    expect(sideCall?.[1]).toMatchObject({
      sides_only: true,
      veg_status: "vegetarian",
      limit: 8,
    });
    expect(sideCall?.[1]).not.toHaveProperty("active_max");
    expect(sideCall?.[1]).not.toHaveProperty("main_dinner_only");
  });

  it("does not break planning when the side pool comes back empty (sides are optional)", async () => {
    const search = makeFakeSearch({
      weeknightBase: [
        candidate("wn-1", { veg_status: "vegetarian" }),
        candidate("wn-2", { veg_status: "vegetarian" }),
      ],
      weekendBase: [
        candidate("we-1", { veg_status: "vegetarian" }),
        candidate("we-2", { veg_status: "vegetarian" }),
      ],
      // no `sides` fixture -> empty side pool.
    });

    const pools = await composePools(["family dinner"], baseCfg, { search });

    expect(pools.sides).toEqual([]);
    expect(pools.weeknight.map((c) => c.id)).toEqual(["wn-1", "wn-2"]);
    expect(pools.weekend.map((c) => c.id)).toEqual(["we-1", "we-2"]);
  });

  it("issues NO side search and returns an empty side pool when maxPairedSides is 0", async () => {
    const search = makeFakeSearch({
      weeknightBase: [candidate("wn-1", { veg_status: "vegetarian" })],
      weekendBase: [candidate("we-1", { veg_status: "vegetarian" })],
      sides: [candidate("side-1", { veg_status: "vegetarian", is_side: true })],
    });

    const pools = await composePools(
      ["family dinner"],
      { ...baseCfg, maxPairedSides: 0 },
      { search },
    );

    expect(pools.sides).toEqual([]);
    expect(search.mock.calls.some(([, filters]) => filters?.sides_only)).toBe(
      false,
    );
  });

  it("scopes the side search by season when cfg.season is set", async () => {
    const search = makeFakeSearch({
      weeknightBase: [candidate("wn-1", { veg_status: "vegetarian" })],
      weekendBase: [candidate("we-1", { veg_status: "vegetarian" })],
      sides: [candidate("side-1", { veg_status: "vegetarian", is_side: true })],
    });

    await composePools(
      ["family dinner"],
      { ...baseCfg, season: "summer" },
      { search },
    );

    const sideCall = search.mock.calls.find(
      ([, filters]) => filters?.sides_only,
    );
    expect(sideCall?.[1]).toMatchObject({ season: "summer" });
  });

  // ── Multi-seed retrieval (bd meal-planner-8zs.6 Stage 2 / l7x) ──
  // A query-AWARE fake: distinct seeds return distinct rated candidates, so we
  // can assert cross-seed merge + per-seed capping (the shape-based fake above
  // ignores the query and can't).
  function makeSeedAwareSearch(bySeed: Record<string, RecipeCandidate[]>) {
    return vi.fn(async (query: string, filters?: SearchFilters) => {
      if (filters?.quality === "untested") return [];
      if (filters?.veg_status === "vegetarian") return [];
      return bySeed[query] ?? [];
    });
  }

  it("multi-seed base pulls rated candidates from EACH seed, deduped (l7x)", async () => {
    const search = makeSeedAwareSearch({
      "seed-a": [
        candidate("a1", { veg_status: "vegetarian" }),
        candidate("a2", { veg_status: "vegetarian" }),
      ],
      "seed-b": [
        candidate("b1"),
        candidate("a1", { veg_status: "vegetarian" }),
      ], // a1 re-surfaces
    });

    const pools = await composePools(["seed-a", "seed-b"], baseCfg, { search });

    // a1 appears once (deduped); every seed contributes.
    expect(pools.weeknight.map((c) => c.id).sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("caps each seed's contribution so no single seed dominates (per-seed cap)", async () => {
    // weeknight target = 16, 2 seeds -> perSeedCap = ceil(16/2) = 8.
    const search = makeSeedAwareSearch({
      "seed-a": Array.from({ length: 12 }, (_, i) => candidate(`a${i}`)),
      "seed-b": Array.from({ length: 12 }, (_, i) => candidate(`b${i}`)),
    });

    const pools = await composePools(["seed-a", "seed-b"], baseCfg, { search });

    const aCount = pools.weeknight.filter((c) => c.id.startsWith("a")).length;
    const bCount = pools.weeknight.filter((c) => c.id.startsWith("b")).length;
    expect(aCount).toBe(8);
    expect(bCount).toBe(8);
    expect(pools.weeknight).toHaveLength(16);
  });

  // ── Fail-closed integration: real searchRecipes wired into composePools ──
  // (bd meal-planner-q95.15). Proves the acceptance criterion end-to-end: a
  // needs_review / fields:null record carrying rating tags never reaches EITHER
  // pool, so it can never be selected and later null-out enrich.
  it("never admits a fields:null record with rating tags into any pool (q95.15)", async () => {
    const vectorStore = new VectorStore({ path: ":memory:", dimensions: 3 });
    const structuredStore = new StructuredStore({ path: ":memory:" });
    const embedder: Embedder = { embed: vi.fn(async () => [1, 0, 0]) };

    // A genuine, well-extracted rated dinner that SHOULD be poolable.
    vectorStore.upsert("good-dinner", [1, 0, 0], {
      title: "Good Dinner",
      body: "body",
      hash: "hash-good",
      modifiedAt: new Date(),
    });
    structuredStore.upsertStructured("good-dinner", {
      contentHash: "hash-good",
      extractorVersion: 1,
      fields: {
        time: { active: 20, total: 30, prep: 10, confidence: 0.9 },
        ingredients: [],
        veg_status: "vegetarian",
      },
      needsReview: false,
    });
    structuredStore.upsertTags("good-dinner", ["4-stars", "dinner"]);

    // A needs_review record: extraction FAILED (fields null) but it carries
    // #4-stars #dinner tags that would otherwise pass quality/course gates.
    vectorStore.upsert("failed-4stars", [1, 0, 0], {
      title: "Failed 4-star Dinner",
      body: "body",
      hash: "hash-failed",
      modifiedAt: new Date(),
    });
    structuredStore.upsertStructured("failed-4stars", {
      contentHash: "hash-failed",
      extractorVersion: 1,
      fields: null,
      needsReview: true,
    });
    structuredStore.upsertTags("failed-4stars", ["4-stars", "dinner"]);

    const search = (query: string, filters?: SearchFilters) =>
      searchRecipes(query, filters, { embedder, vectorStore, structuredStore });

    const pools = await composePools(["dinner"], baseCfg, { search });

    const allIds = [...pools.weeknight, ...pools.weekend].map((c) => c.id);
    expect(allIds).not.toContain("failed-4stars");
    // Sanity: the well-extracted rated dinner IS admitted, so the exclusion is
    // targeting failed extraction — not silently emptying every pool.
    expect(allIds).toContain("good-dinner");

    vectorStore.close();
    structuredStore.close();
  });

  it("veg-floor iterates seeds until the floor is met when the base lacks veg (l7x)", async () => {
    // Base seeds return non-veg; a later veg-floor pass over the seeds supplies veg.
    const search = vi.fn(async (query: string, filters?: SearchFilters) => {
      if (filters?.quality === "untested") return [];
      if (filters?.veg_status === "vegetarian") {
        return query === "veg-seed"
          ? [
              candidate("v1", { veg_status: "vegetarian" }),
              candidate("v2", { veg_status: "vegetarian" }),
            ]
          : [];
      }
      return query === "meat-seed" ? [candidate("m1"), candidate("m2")] : [];
    });

    const pools = await composePools(["meat-seed", "veg-seed"], baseCfg, {
      search,
    });

    const vegCount = pools.weeknight.filter(
      (c) => c.veg_status === "vegetarian",
    ).length;
    expect(vegCount).toBeGreaterThanOrEqual(baseCfg.vegFloorK);
  });
});
