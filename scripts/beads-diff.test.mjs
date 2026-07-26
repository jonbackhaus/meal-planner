import { describe, expect, it } from "vitest";
import { formatReport, semanticDiff } from "./beads-diff.mjs";

/**
 * Build a JSONL document from issue objects, in the order given. Line order is
 * meaningful to these tests: bd's export is not sorted by any stable key, so a
 * rewritten row can change position without changing meaning.
 */
function jsonl(...issues) {
  return `${issues.map((i) => JSON.stringify(i)).join("\n")}\n`;
}

const xg6 = {
  id: "meal-planner-xg6",
  title: "docs",
  status: "open",
  priority: 2,
  closed_at: null,
  updated_at: "2026-07-26T12:00:00Z",
  labels: ["tooling"],
};
const u86 = {
  id: "meal-planner-8u6",
  title: "regenerate",
  status: "in_progress",
  priority: 2,
  closed_at: null,
  updated_at: "2026-07-26T12:00:00Z",
  labels: [],
};

describe("semanticDiff", () => {
  it("reports no change for byte-identical exports", () => {
    const d = semanticDiff(jsonl(xg6, u86), jsonl(xg6, u86));
    expect(d.significantCount).toBe(0);
    expect(d.changed).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toBe(0);
  });

  it("classifies pure reordering as benign, not as a change", () => {
    const d = semanticDiff(jsonl(xg6, u86), jsonl(u86, xg6));
    expect(d.significantCount).toBe(0);
    expect(d.changed).toEqual([]);
    expect(d.moved).toBe(2);
  });

  it("flags a status transition as significant", () => {
    const d = semanticDiff(
      jsonl(xg6, u86),
      jsonl(xg6, {
        ...u86,
        status: "closed",
        closed_at: "2026-07-26T13:00:00Z",
      }),
    );
    expect(d.significantCount).toBe(1);
    expect(d.changed[0].id).toBe("meal-planner-8u6");
    expect(d.changed[0].significant).toEqual([
      { field: "status", before: "in_progress", after: "closed" },
      { field: "closed_at", before: null, after: "2026-07-26T13:00:00Z" },
    ]);
  });

  it("flags a status REGRESSION — the shape of the incident this fixes", () => {
    // Committed export says in_progress; Dolt says closed. Discarding the
    // working tree here is what lost real status on 2026-07-26.
    const committed = jsonl(xg6, u86);
    const dolt = jsonl({ ...u86, status: "closed" }, xg6);
    const d = semanticDiff(committed, dolt);
    expect(d.significantCount).toBe(1);
    expect(d.changed[0].significant).toEqual([
      { field: "status", before: "in_progress", after: "closed" },
    ]);
  });

  it("treats a bare updated_at bump as metadata-only, not significant", () => {
    const d = semanticDiff(
      jsonl(xg6),
      jsonl({ ...xg6, updated_at: "2026-07-26T14:00:00Z" }),
    );
    expect(d.significantCount).toBe(0);
    expect(d.changed[0].metadata).toEqual(["updated_at"]);
  });

  it("compares labels as a set, so label order is not a change", () => {
    const a = jsonl({ ...xg6, labels: ["tooling", "ops"] });
    const b = jsonl({ ...xg6, labels: ["ops", "tooling"] });
    expect(semanticDiff(a, b).significantCount).toBe(0);
  });

  it("flags an actual label change as significant", () => {
    const a = jsonl({ ...xg6, labels: ["tooling"] });
    const b = jsonl({ ...xg6, labels: ["tooling", "ops"] });
    expect(semanticDiff(a, b).significantCount).toBe(1);
  });

  it("reports added and removed issues", () => {
    const d = semanticDiff(jsonl(xg6), jsonl(xg6, u86));
    expect(d.added).toEqual(["meal-planner-8u6"]);
    expect(d.removed).toEqual([]);
    expect(d.significantCount).toBe(1);

    const d2 = semanticDiff(jsonl(xg6, u86), jsonl(xg6));
    expect(d2.removed).toEqual(["meal-planner-8u6"]);
    expect(d2.significantCount).toBe(1);
  });

  it("surfaces one real delta hidden among many moved lines", () => {
    const filler = Array.from({ length: 20 }, (_, n) => ({
      ...xg6,
      id: `meal-planner-f${n}`,
    }));
    const before = jsonl(...filler, u86);
    const after = jsonl(u86dash(), ...filler.slice().reverse());
    function u86dash() {
      return { ...u86, status: "closed" };
    }
    const d = semanticDiff(before, after);
    expect(d.significantCount).toBe(1);
    expect(d.changed[0].id).toBe("meal-planner-8u6");
    expect(d.moved).toBeGreaterThan(0);
  });

  it("ignores blank lines and surfaces unparseable ones", () => {
    const d = semanticDiff(`${jsonl(xg6)}\n`, `${jsonl(xg6)}not json\n`);
    expect(d.significantCount).toBe(0);
    expect(d.malformed.after).toBe(1);
    expect(d.malformed.before).toBe(0);
  });
});

describe("formatReport", () => {
  it("renders significant deltas with a before -> after arrow", () => {
    const d = semanticDiff(jsonl(u86), jsonl({ ...u86, status: "closed" }));
    const out = formatReport(d);
    expect(out).toContain("meal-planner-8u6");
    expect(out).toContain("status");
    expect(out).toContain("in_progress -> closed");
  });

  it("says so explicitly when the only difference is line order", () => {
    const d = semanticDiff(jsonl(xg6, u86), jsonl(u86, xg6));
    expect(formatReport(d)).toContain("order-only");
  });

  it("renders nothing to worry about when the exports match", () => {
    const d = semanticDiff(jsonl(xg6), jsonl(xg6));
    expect(formatReport(d)).toContain("identical");
  });
});
