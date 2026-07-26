import { describe, expect, it } from "vitest";
import {
  applyRecencyDedup,
  DEFAULT_RECENCY_PENALTY_STRENGTH,
  type RecencyDedupDeps,
} from "./recency-dedup.js";

/**
 * Tests for bd meal-planner-v9v.2 (ADR-0006 D2, SPEC §6.3): resolved recent
 * `recipe_id`s -> exact `exclude_ids` + a bounded semantic penalty on
 * near-neighbors, using an injected (mock) embedding lookup — no real
 * sqlite-vec/vector store involved.
 */

function makeEmbeddingLookup(
  table: Record<string, number[]>,
): RecencyDedupDeps {
  return {
    getEmbedding: (id: string) => table[id] ?? null,
  };
}

describe("applyRecencyDedup", () => {
  it("empty recent set is a no-op: no exclusion, no penalty, original order preserved", () => {
    const candidates = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    const deps = makeEmbeddingLookup({
      r1: [1, 0, 0],
      r2: [0, 1, 0],
      r3: [0, 0, 1],
    });

    const result = applyRecencyDedup([], candidates, deps);

    expect(result.excludeIds).toEqual([]);
    expect(result.ranked).toEqual([
      { candidate: { id: "r1" }, penalty: 0 },
      { candidate: { id: "r2" }, penalty: 0 },
      { candidate: { id: "r3" }, penalty: 0 },
    ]);
  });

  it("recent ids feed exclude_ids so exact repeats hard-drop from the ranked output", () => {
    const candidates = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    const deps = makeEmbeddingLookup({
      r1: [1, 0, 0],
      r2: [0, 1, 0],
      r3: [0, 0, 1],
    });

    const result = applyRecencyDedup(["r1"], candidates, deps);

    expect(result.excludeIds).toEqual(["r1"]);
    expect(result.ranked.map((r) => r.candidate.id)).not.toContain("r1");
    expect(result.ranked.map((r) => r.candidate.id).sort()).toEqual([
      "r2",
      "r3",
    ]);
  });

  it("dedupes repeated recent ids in excludeIds", () => {
    const deps = makeEmbeddingLookup({ r1: [1, 0, 0] });
    const result = applyRecencyDedup(["r1", "r1", "r1"], [{ id: "r2" }], deps);
    expect(result.excludeIds).toEqual(["r1"]);
  });

  it("penalizes a candidate semantically near a recent recipe more than an unrelated one", () => {
    const candidates = [{ id: "near" }, { id: "far" }];
    const deps = makeEmbeddingLookup({
      recent: [1, 0, 0],
      near: [0.95, 0.05, 0], // close to "recent"
      far: [0, 1, 0], // orthogonal to "recent"
    });

    const result = applyRecencyDedup(["recent"], candidates, deps);

    const near = result.ranked.find((r) => r.candidate.id === "near");
    const far = result.ranked.find((r) => r.candidate.id === "far");
    expect(near).toBeDefined();
    expect(far).toBeDefined();
    expect(near?.penalty ?? 0).toBeGreaterThan(far?.penalty ?? 0);

    // Ranked ascending by penalty: the unrelated candidate sorts first.
    expect(result.ranked.map((r) => r.candidate.id)).toEqual(["far", "near"]);
  });

  it("scales the penalty by the configured penaltyStrength", () => {
    const candidates = [{ id: "near" }];
    const deps = makeEmbeddingLookup({
      recent: [1, 0, 0],
      near: [1, 0, 0], // identical -> cosine similarity 1
    });

    const full = applyRecencyDedup(["recent"], candidates, deps, {
      penaltyStrength: 1,
    });
    const half = applyRecencyDedup(["recent"], candidates, deps, {
      penaltyStrength: 0.5,
    });
    const off = applyRecencyDedup(["recent"], candidates, deps, {
      penaltyStrength: 0,
    });

    expect(full.ranked[0]?.penalty).toBeCloseTo(1, 5);
    expect(half.ranked[0]?.penalty).toBeCloseTo(0.5, 5);
    expect(off.ranked[0]?.penalty).toBe(0);
  });

  it("defaults to DEFAULT_RECENCY_PENALTY_STRENGTH when no strength is given", () => {
    const candidates = [{ id: "near" }];
    const deps = makeEmbeddingLookup({
      recent: [1, 0, 0],
      near: [1, 0, 0],
    });

    const result = applyRecencyDedup(["recent"], candidates, deps);

    expect(result.ranked[0]?.penalty).toBeCloseTo(
      DEFAULT_RECENCY_PENALTY_STRENGTH,
      5,
    );
  });

  it("clamps an out-of-range penaltyStrength into [0, 1]", () => {
    const candidates = [{ id: "near" }];
    const deps = makeEmbeddingLookup({
      recent: [1, 0, 0],
      near: [1, 0, 0],
    });

    const overOne = applyRecencyDedup(["recent"], candidates, deps, {
      penaltyStrength: 5,
    });
    const negative = applyRecencyDedup(["recent"], candidates, deps, {
      penaltyStrength: -5,
    });

    expect(overOne.ranked[0]?.penalty).toBeCloseTo(1, 5);
    expect(negative.ranked[0]?.penalty).toBe(0);
  });

  it("fails open (penalty 0) for a candidate with no resolvable embedding", () => {
    const candidates = [{ id: "unembedded" }];
    const deps = makeEmbeddingLookup({ recent: [1, 0, 0] });

    const result = applyRecencyDedup(["recent"], candidates, deps);

    expect(result.ranked).toEqual([
      { candidate: { id: "unembedded" }, penalty: 0 },
    ]);
  });

  it("fails open (penalty 0 for all) when NO recent id resolves to an embedding", () => {
    const candidates = [{ id: "r2" }];
    const deps = makeEmbeddingLookup({ r2: [1, 0, 0] });

    // "recent" (the excluded id) has no embedding in the lookup table.
    const result = applyRecencyDedup(["recent"], candidates, deps);

    expect(result.excludeIds).toEqual(["recent"]);
    expect(result.ranked).toEqual([{ candidate: { id: "r2" }, penalty: 0 }]);
  });

  it("uses the MAXIMUM similarity across multiple recent recipes (nearest neighbor)", () => {
    const candidates = [{ id: "c" }];
    const deps = makeEmbeddingLookup({
      recentFar: [0, 1, 0],
      recentNear: [1, 0, 0],
      c: [1, 0, 0], // identical to recentNear, orthogonal to recentFar
    });

    const result = applyRecencyDedup(
      ["recentFar", "recentNear"],
      candidates,
      deps,
      { penaltyStrength: 1 },
    );

    expect(result.ranked[0]?.penalty).toBeCloseTo(1, 5);
  });

  it("preserves the input pool's relative order for tied penalties (stable sort)", () => {
    const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const deps = makeEmbeddingLookup({}); // no embeddings resolve for anyone

    const result = applyRecencyDedup(["recent"], candidates, deps);

    expect(result.ranked.map((r) => r.candidate.id)).toEqual(["a", "b", "c"]);
  });
});
