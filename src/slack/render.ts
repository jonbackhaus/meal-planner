import type { EnrichedMeal, EnrichedWeekPlan } from "../planner/enrich.js";

/**
 * WeekPlan -> Slack markdown render (ADR 0003 D3, bd meal-planner-bj1.2):
 * selection and presentation are separate steps, and the LLM never writes
 * the post. `selectValidatedPlan`/`enrichPlan` produce the structured
 * `EnrichedWeekPlan`; this module turns that data into the Slack-flavored
 * markdown (mrkdwn: `*bold*`, `_italic_`, `` `code` ``, `•` bullets) that the
 * family reviews and approves. Posting the render (`chat.postMessage`, the
 * Slack client/token, thread ts) is explicitly OUT of scope here — see
 * bj1.3.
 *
 * `renderPlan` is a PURE function: `EnrichedWeekPlan` in, markdown string
 * out. No Slack SDK calls, no I/O, and nothing time- or randomness-derived,
 * so the same plan always renders to the exact same string (required for
 * the daemon to diff/re-render deterministically and for this module to be
 * unit-testable without mocking a clock).
 */

const SLOT_SECTIONS: Array<{
  slot_type: EnrichedMeal["slot_type"];
  heading: string;
}> = [
  { slot_type: "constrained", heading: "Weeknights" },
  { slot_type: "relaxed", heading: "Weekend" },
];

/**
 * Collapses any internal newlines (and the run of whitespace around them)
 * into a single space, then trims. Recipe/meal titles are our own data in
 * v1.0 (not user-injected), so this isn't an XSS/escaping concern — it's
 * purely a layout guard: this render is one-bullet-per-meal, and a title
 * containing a raw `\n` would otherwise split into extra bare lines Slack
 * would render as if they were separate bullets/paragraphs.
 */
function collapseNewlines(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * Renders the per-meal veg-coverage text from `meal.veg`, per `VegPath`
 * kind (ADR 0003 selection output):
 *  - `inherent`: the dish itself is vegetarian.
 *  - `separable`: surfaces the human-authored `note` verbatim (e.g. "hold
 *    the chicken; she has pasta + sauce") — that note IS the coverage
 *    explanation, so there's nothing to add.
 *  - `second_dish`: names the extra vegetarian dish added just for her,
 *    preferring the enriched `secondDishRecipe.title` (the authoritative,
 *    freshly-fetched recipe title) and falling back to `veg.title` (the
 *    title the LLM/selection step captured at selection time) only if
 *    `secondDishRecipe` is absent — which the current `enrichPlan` never
 *    produces for a `second_dish` meal, but `EnrichedMeal`'s type leaves it
 *    optional, so this render doesn't assume it's always set.
 */
function renderVegCoverage(meal: EnrichedMeal): string {
  switch (meal.veg.kind) {
    case "inherent":
      return "🌱 vegetarian";
    case "separable":
      return collapseNewlines(meal.veg.note);
    case "second_dish": {
      const title = meal.secondDishRecipe?.title ?? meal.veg.title;
      return `+ second dish: ${collapseNewlines(title)}`;
    }
  }
}

/** Renders `flags` as small inline-code tags, e.g. `` `do-ahead` `untested` ``. */
function renderFlags(flags: readonly string[]): string {
  if (flags.length === 0) {
    return "";
  }
  return ` ${flags.map((flag) => `\`${flag}\``).join(" ")}`;
}

/**
 * Renders a plain source hint from `recipe.source_note_id` — the note id,
 * not a URL (there is no note URL in v1.0). This is deliberately a low-key,
 * single extra line rather than a link, so a reviewer who wants provenance
 * can find it but it doesn't compete visually with the title/coverage/
 * rationale. (Documented alternative: omit it entirely as noise — kept in
 * because the family reviewing the draft may want to jump to the source
 * note, and it costs one quiet line per meal.)
 */
function renderSourceHint(meal: EnrichedMeal): string {
  return `    (source note: ${meal.recipe.source_note_id})`;
}

/** Renders one meal as a bullet block: title + coverage + flags, rationale, source hint. */
function renderMeal(meal: EnrichedMeal): string {
  const title = collapseNewlines(meal.title);
  const coverage = renderVegCoverage(meal);
  const flags = renderFlags(meal.flags);
  const rationale = collapseNewlines(meal.rationale);

  return [
    `• *${title}* — ${coverage}${flags}`,
    `    _${rationale}_`,
    renderSourceHint(meal),
  ].join("\n");
}

/** Renders one `*Heading*` section with its meals, in their given array order, or `undefined` if empty. */
function renderSection(
  heading: string,
  meals: EnrichedMeal[],
): string | undefined {
  if (meals.length === 0) {
    return undefined;
  }
  return [`*${heading}*`, ...meals.map(renderMeal)].join("\n\n");
}

/**
 * Renders the full plan to Slack mrkdwn: a header naming `week_key`, the
 * optional `summary` as a short intro line, then one section per
 * `slot_type` (`constrained` -> "Weeknights", `relaxed` -> "Weekend"), each
 * with one bullet block per meal in the plan's own array order (stable,
 * deterministic — no re-sorting). A section with no meals is omitted
 * entirely rather than rendered empty.
 */
export function renderPlan(plan: EnrichedWeekPlan): string {
  const blocks: string[] = [`*Meal plan for the week of ${plan.week_key}*`];

  if (plan.summary !== undefined) {
    blocks.push(collapseNewlines(plan.summary));
  }

  for (const { slot_type, heading } of SLOT_SECTIONS) {
    const meals = plan.meals.filter((meal) => meal.slot_type === slot_type);
    const section = renderSection(heading, meals);
    if (section !== undefined) {
      blocks.push(section);
    }
  }

  return blocks.join("\n\n");
}
