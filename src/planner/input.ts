import type { RecipeCandidate } from "../recipe-mcp/schema.js";
import { DEFAULT_MAX_PAIRED_SIDES, type Pools } from "./pools.js";

/**
 * Assembles the typed selection-call input and renders the PROMPT the
 * orchestrator sends to the planner LLM (ADR 0003 D2 "signals enter the LLM
 * by mechanism"; "Prompt skeleton").
 *
 * This module makes NO LLM call and does no parsing of an LLM response —
 * that's the next task (the `WeekPlan` schema + the actual selection call).
 * It only:
 *   1. assembles `PlannerInput` from the already-composed pools
 *      (`composePools`, ADR 0003 D1) + config slot counts + a caller-supplied
 *      household prose string + an optional season, and
 *   2. renders that `PlannerInput` into the selection prompt string.
 *
 * Per ADR 0003 D2, signals reach the LLM through four DIFFERENT mechanisms,
 * and this module is where that split becomes concrete:
 *   - structured soft signals (time/quality/season_tags/veg_status) ride as
 *     explicit DATA fields on each rendered candidate line (see
 *     `renderCandidate`);
 *   - parameters + weighting (slot counts, season bias, time penalty,
 *     variety) are PROMPT INSTRUCTIONS (the SLOTS + RULES sections);
 *   - picky-youngest/kid-friendliness/vegetarian-daughter is PROSE — the
 *     caller-supplied `household` string, rendered verbatim;
 *   - untested injection is retrieval-level (already done by `composePools`
 *     before this module ever sees the pools) — this module only tells the
 *     planner it MAY pick <=1 untested "try this?", and only when
 *     `untested_present`.
 */
export interface PlannerInput {
  week_key: string;
  slots: { constrained: number; relaxed: number };
  pools: Pools;
  /**
   * Household prose: vegetarian daughter (HARD, every night), picky-youngest
   * likes/dislikes, smaller appetites, cook-nights cadence, etc. This is
   * FAMILY-SPECIFIC config, not something this module (or any planner code)
   * hardcodes — the caller (the orchestrator / a later E3 task) is
   * responsible for sourcing it from config/env and passing it in here.
   */
  household: string;
  /** Seasonality soft signal (v1.0 tag-based bias against `season_tags`). */
  current_season?: string;
  /** Did retrieval (composePools) inject any `quality: "untested"` candidate this week? */
  untested_present: boolean;
  /**
   * Hard ceiling on paired sides this week (bd meal-planner-8zs.8), surfaced in
   * the RULES clause. Optional so partial `PlannerInput` literals stay valid;
   * defaults to `DEFAULT_MAX_PAIRED_SIDES` when omitted.
   */
  max_paired_sides?: number;
}

export interface BuildPlannerInputArgs {
  weekKey: string;
  slots: { constrained: number; relaxed: number };
  pools: Pools;
  /** Caller-supplied household prose — see `PlannerInput.household` doc above. */
  household: string;
  currentSeason?: string;
  /** Hard ceiling on paired sides this week (bd meal-planner-8zs.8); defaults to `DEFAULT_MAX_PAIRED_SIDES`. */
  maxPairedSides?: number;
}

/**
 * Assembles `PlannerInput` from the composed pools + config slots + a
 * caller-supplied household prose string + optional season.
 * `untested_present` is computed by scanning BOTH pools for any
 * `quality === "untested"` candidate.
 */
export function buildPlannerInput(args: BuildPlannerInputArgs): PlannerInput {
  const { weekKey, slots, pools, household, currentSeason, maxPairedSides } =
    args;

  const untestedPresent = [...pools.weeknight, ...pools.weekend].some(
    (candidate) => candidate.quality === "untested",
  );

  return {
    week_key: weekKey,
    slots,
    pools,
    household,
    ...(currentSeason !== undefined ? { current_season: currentSeason } : {}),
    untested_present: untestedPresent,
    ...(maxPairedSides !== undefined
      ? { max_paired_sides: maxPairedSides }
      : {}),
  };
}

/** Renders a Minutes value (nullable) for the compact candidate line. */
function renderMinutes(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

/**
 * Renders one candidate as a compact, single-line structured entry exposing
 * the soft-signal fields as DATA the model can read and reference by `id`:
 * `id`, `title`, `time` (active/total), `quality`, `season_tags`,
 * `veg_status`. Deliberately excludes ingredients — `RecipeCandidate` (the
 * "lightweight" tier) never carries an ingredient block, and the prompt
 * doesn't need one for selection.
 */
function renderCandidate(candidate: RecipeCandidate): string {
  const time = `active=${renderMinutes(candidate.time.active)}/total=${renderMinutes(candidate.time.total)}`;
  const quality = candidate.quality ?? "unrated";
  const seasonTags =
    candidate.season_tags.length > 0 ? candidate.season_tags.join(",") : "none";

  return (
    `- id=${candidate.id} | title="${candidate.title}" | time(${time}) | ` +
    `quality=${quality} | season_tags=[${seasonTags}] | veg_status=${candidate.veg_status}`
  );
}

function renderPool(name: string, candidates: RecipeCandidate[]): string {
  if (candidates.length === 0) {
    return `${name} pool (0 candidates): none.`;
  }
  const lines = candidates.map(renderCandidate).join("\n");
  return `${name} pool (${candidates.length} candidates):\n${lines}`;
}

/**
 * Renders the LLM selection prompt from an assembled `PlannerInput`, per
 * ADR 0003's prompt skeleton: TASK / HOUSEHOLD / SLOTS / CANDIDATES / RULES
 * / OUTPUT. Wording is this module's own; the section structure + the
 * specific content called out in the ADR (hard veg constraint stated
 * explicitly, exact slot counts, candidate ids/soft-signal fields as data,
 * the HARD/SOFT/POOL rule tiers, single-JSON-object output) are load-bearing.
 *
 * The untested POOL clause is included ONLY when `input.untested_present`;
 * the season SOFT clause is included ONLY when `input.current_season` is
 * set.
 */
export function buildSelectionPrompt(input: PlannerInput): string {
  const sections: string[] = [];

  sections.push(
    "TASK\n" +
      "Select a week of family dinners from the candidate pools below. " +
      "You are choosing WHICH recipes to cook this week — not assigning " +
      "them to specific days.",
  );

  sections.push(
    "HOUSEHOLD\n" +
      `${input.household}\n` +
      "The vegetarian daughter is a HARD constraint that applies EVERY NIGHT, " +
      "with no exceptions: every single selected meal must be satisfiable by her.",
  );

  sections.push(
    "SLOTS\n" +
      `Select exactly ${input.slots.constrained} weeknight meals (slot_type "constrained") ` +
      `+ ${input.slots.relaxed} weekend meals (slot_type "relaxed"). Do NOT assign days — ` +
      "slot-to-day scheduling happens later, outside this selection.",
  );

  const sidePool = input.pools.sides ?? [];
  const hasSides = sidePool.length > 0;

  const candidateBlocks = [
    renderPool("Weeknight", input.pools.weeknight),
    renderPool("Weekend", input.pools.weekend),
  ];
  if (hasSides) {
    candidateBlocks.push(renderPool("Sides", sidePool));
  }
  sections.push(
    `CANDIDATES\n${candidateBlocks.join("\n\n")}\n\n` +
      "Reference candidates ONLY by their `id` field above; do not invent ids.",
  );

  const ruleLines: string[] = [
    "HARD:",
    "- Every meal must be veg-satisfiable for the vegetarian daughter, every night, no exceptions. " +
      "STATE the path for each meal: either the dish is inherently vegetarian/separable, or, " +
      "if a meat dish is not cleanly separable, add a second_dish — a vegetarian recipe_id drawn " +
      "from one of the pools above — to cover her.",
    "- No recipe may be repeated within the week (each selected recipe_id, including any " +
      "second_dish, appears at most once).",
    "SOFT:",
    "- Bias toward higher-quality candidates (prefer a higher numeric quality rating, all else equal).",
  ];
  if (input.current_season !== undefined) {
    ruleLines.push(
      `- Respect the current season ("${input.current_season}"): prefer candidates whose ` +
        "season_tags include it.",
    );
  }
  ruleLines.push(
    "- Penalize heavy total time on constrained (weeknight) slots.",
    "- Maximize variety within the week across protein, cuisine, and technique — avoid repeats " +
      "of the same protein/cuisine/technique night after night.",
    "POOL:",
  );
  if (input.untested_present) {
    ruleLines.push(
      '- You MAY include at most one "try this?" untested candidate (quality "untested") this week.',
    );
  }
  if (hasSides) {
    const maxSides = input.max_paired_sides ?? DEFAULT_MAX_PAIRED_SIDES;
    ruleLines.push(
      "- You MAY OPTIONALLY attach ONE side dish to a main via its `side` field, " +
        "chosen ONLY from the Sides pool above (each main gets at most one side). " +
        "This is optional: usually attach 0-1 sides across the WHOLE week, and " +
        `NEVER more than ${maxSides}. A paired side MUST be vegetarian so the ` +
        "vegetarian daughter can eat it too. A `side` is a shared accompaniment " +
        "for everyone — distinct from a veg `second_dish` (her substitute main); " +
        "a meal may have both.",
    );
  }
  ruleLines.push(
    "- Flag any selected meal that is a do-ahead (can be prepped in advance).",
  );

  sections.push(`RULES\n${ruleLines.join("\n")}`);

  const sideShapeLine = hasSides
    ? '      "side": { "recipe_id": "<a Sides-pool id>", "title": "<its title>" },   (OPTIONAL — omit entirely when no side)\n'
    : "";
  const optionalKeysNote = hasSides
    ? 'except "summary" and the OPTIONAL "side"'
    : 'except "summary"';

  sections.push(
    "OUTPUT\n" +
      "Emit a SINGLE JSON object and nothing else — no prose, no markdown fences. It must " +
      "have EXACTLY these keys and no others (this is the shape, not the values):\n" +
      "{\n" +
      `  "week_key": "${input.week_key}",\n` +
      '  "meals": [\n' +
      "    {\n" +
      '      "slot_type": "constrained" | "relaxed",\n' +
      '      "recipe_id": "<an id from a pool above>",\n' +
      '      "title": "<that recipe\'s title>",\n' +
      '      "day": null,\n' +
      '      "veg": { "kind": "inherent" }\n' +
      '            | { "kind": "separable", "note": "<how she is served meat-free>" }\n' +
      '            | { "kind": "second_dish", "recipe_id": "<a vegetarian id from a pool>", "title": "<its title>" },\n' +
      '      "flags": ["<tag>"],\n' +
      sideShapeLine +
      '      "rationale": "<one sentence: why this meal>"\n' +
      "    }\n" +
      "  ],\n" +
      '  "summary": "<optional: one short line about the week>"\n' +
      "}\n" +
      `Emit exactly ${input.slots.constrained} meals with slot_type "constrained" and ` +
      `${input.slots.relaxed} with slot_type "relaxed" — one object per selected meal. Do NOT ` +
      `wrap the object in any outer key (no "week_plan" envelope). Every key shown is required ` +
      `${optionalKeysNote}; "flags" is [] when none apply; "day" is always null.`,
  );

  return sections.join("\n\n");
}
