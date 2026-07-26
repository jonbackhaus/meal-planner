#!/usr/bin/env node
/**
 * Semantic diff for `.beads/issues.jsonl` (bead meal-planner-p2p).
 *
 * bd's JSONL export is not sorted by any stable key, so rewriting a row can
 * move its line. A `git diff` of the export therefore mixes meaningless line
 * movement with real status transitions, and the two look identical — which is
 * how a genuine `closed` was mistaken for churn and discarded on 2026-07-26.
 *
 * This compares two exports by issue id instead of by line, and separates:
 *   - line movement and metadata bumps (benign)
 *   - status / priority / label / membership changes (significant)
 *
 * Dolt is authoritative. Always reconcile TOWARD `bd export`, never away.
 *
 * Usage:
 *   node scripts/beads-diff.mjs                 # HEAD's export vs. live `bd export`
 *   node scripts/beads-diff.mjs --staged        # staged export vs. live `bd export`
 *   node scripts/beads-diff.mjs <before> <after>  # two files ("-" reads git HEAD)
 *
 * Exits 1 when there are significant deltas, 0 otherwise.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Fields whose change means real issue state moved, not serialization noise. */
const SIGNIFICANT_FIELDS = [
  "status",
  "closed_at",
  "close_reason",
  "priority",
  "issue_type",
  "title",
  "owner",
  "labels",
  "dependencies",
];

/** Fields compared as unordered sets — bd does not guarantee their order. */
const SET_FIELDS = new Set(["labels", "dependencies"]);

/**
 * Parse a JSONL export into a Map keyed by issue id, preserving line position.
 * @returns {{ issues: Map<string, object>, order: string[], malformed: number }}
 */
function parseJsonl(text) {
  const issues = new Map();
  const order = [];
  let malformed = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (!parsed || typeof parsed.id !== "string") {
      malformed += 1;
      continue;
    }
    issues.set(parsed.id, parsed);
    order.push(parsed.id);
  }

  return { issues, order, malformed };
}

function sameValue(field, before, after) {
  if (SET_FIELDS.has(field)) {
    const a = [...(before ?? [])].map(String).sort();
    const b = [...(after ?? [])].map(String).sort();
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}

/**
 * Compare two exports by issue id.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {{
 *   added: string[], removed: string[],
 *   changed: Array<{ id: string, significant: Array<{field: string, before: unknown, after: unknown}>, metadata: string[] }>,
 *   moved: number, significantCount: number,
 *   malformed: { before: number, after: number },
 * }}
 */
export function semanticDiff(beforeText, afterText) {
  const before = parseJsonl(beforeText);
  const after = parseJsonl(afterText);

  const added = [...after.issues.keys()].filter((id) => !before.issues.has(id));
  const removed = [...before.issues.keys()].filter((id) => !after.issues.has(id));

  const changed = [];
  for (const [id, afterIssue] of after.issues) {
    const beforeIssue = before.issues.get(id);
    if (!beforeIssue) continue;

    const significant = [];
    const metadata = [];
    const fields = new Set([...Object.keys(beforeIssue), ...Object.keys(afterIssue)]);
    for (const field of fields) {
      if (sameValue(field, beforeIssue[field], afterIssue[field])) continue;
      if (SIGNIFICANT_FIELDS.includes(field)) {
        significant.push({ field, before: beforeIssue[field] ?? null, after: afterIssue[field] ?? null });
      } else {
        metadata.push(field);
      }
    }
    if (significant.length === 0 && metadata.length === 0) continue;

    // Report significant fields in a stable, human-meaningful order.
    significant.sort(
      (a, b) => SIGNIFICANT_FIELDS.indexOf(a.field) - SIGNIFICANT_FIELDS.indexOf(b.field),
    );
    metadata.sort();
    changed.push({ id, significant, metadata });
  }

  // Line movement among issues present in both exports: benign by definition,
  // but worth counting so a reordered diff can be explained rather than feared.
  let moved = 0;
  const beforePos = new Map(before.order.map((id, i) => [id, i]));
  const afterPos = new Map(after.order.map((id, i) => [id, i]));
  for (const [id, pos] of afterPos) {
    if (beforePos.has(id) && beforePos.get(id) !== pos) moved += 1;
  }

  const significantCount =
    added.length + removed.length + changed.filter((c) => c.significant.length > 0).length;

  return {
    added,
    removed,
    changed,
    moved,
    significantCount,
    malformed: { before: before.malformed, after: after.malformed },
  };
}

/** Render a diff as human- and hook-readable lines. */
export function formatReport(diff) {
  const lines = [];

  for (const id of diff.added) lines.push(`  + ${id}  (present in Dolt, absent from the export)`);
  for (const id of diff.removed) lines.push(`  - ${id}  (in the export, absent from Dolt)`);

  for (const entry of diff.changed) {
    if (entry.significant.length === 0) continue;
    for (const { field, before, after } of entry.significant) {
      lines.push(`  ~ ${entry.id}  ${field}: ${render(before)} -> ${render(after)}`);
    }
  }

  if (diff.malformed.before > 0 || diff.malformed.after > 0) {
    lines.push(
      `  ! unparseable lines — before: ${diff.malformed.before}, after: ${diff.malformed.after}`,
    );
  }

  const metadataOnly = diff.changed.filter((c) => c.significant.length === 0).length;

  if (diff.significantCount === 0) {
    if (diff.moved === 0 && metadataOnly === 0) {
      lines.push("  exports are semantically identical");
    } else {
      const parts = [];
      if (diff.moved > 0) parts.push(`${diff.moved} order-only line moves`);
      if (metadataOnly > 0) parts.push(`${metadataOnly} metadata-only bumps`);
      lines.push(`  no status changes — ${parts.join(", ")} (benign)`);
    }
  } else {
    lines.push(
      `  ${diff.significantCount} significant change(s); ${diff.moved} order-only line moves`,
    );
  }

  return lines.join("\n");
}

function render(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return String(value);
}

// ---------------------------------------------------------------- CLI

function readGitBlob(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function liveExport() {
  // Explicit export, not the file on disk: the on-disk copy is written by an
  // asynchronous exporter and may lag the database it claims to represent.
  return execFileSync("bd", ["export"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main(argv) {
  const exportPath = ".beads/issues.jsonl";
  const positional = argv.filter((a) => !a.startsWith("--"));

  let before;
  let after;
  let label;

  if (positional.length === 2) {
    const read = (p) => (p === "-" ? readGitBlob("HEAD", exportPath) : readFileSync(p, "utf8"));
    before = read(positional[0]);
    after = read(positional[1]);
    label = `${positional[0]} -> ${positional[1]}`;
  } else if (argv.includes("--staged")) {
    before = readGitBlob("", exportPath); // `git show :path` reads the index
    after = liveExport();
    label = "staged export -> Dolt";
  } else {
    before = readGitBlob("HEAD", exportPath);
    after = liveExport();
    label = "HEAD export -> Dolt";
  }

  const diff = semanticDiff(before, after);
  console.log(`beads export diff (${label}):`);
  console.log(formatReport(diff));
  return diff.significantCount > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
