import { DateTime } from "luxon";
import type {
  Capacity,
  NightCapacitySchedule,
} from "../calendar/night-schedule.js";
import type { EnrichedMeal, EnrichedWeekPlan } from "../planner/enrich.js";
import type { PrepUnit } from "../planner/select.js";

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
 * `renderPlan` is a PURE function: `EnrichedWeekPlan` (+ optional
 * `RenderPlanOptions`) in, markdown string out. No Slack SDK calls, no I/O,
 * and nothing time- or randomness-derived, so the same plan always renders
 * to the exact same string (required for the daemon to diff/re-render
 * deterministically and for this module to be unit-testable without mocking
 * a clock).
 *
 * ADR 0005 D4 dual-mode render: when at least one meal carries a non-null
 * `day` (ISO date, ADR 0005 D2), the render groups meals into day-ordered
 * sections Monday->Sunday, each annotated with its `NightCapacitySchedule`
 * capacity (when supplied) and any matching prep note (ADR 0004 D5). When
 * every meal has `day: null` (a v1.0 plan, or the ADR 0004 D6 degraded
 * no-calendar path), the render falls back UNCHANGED to the v1.0 unordered
 * `slot_type`-sectioned render below — this fallback must never crash or
 * render blank days.
 */

/**
 * Optional day-ordered-render inputs (ADR 0005 D4). Both are optional so a
 * caller can render a day-ordered plan without a `NightCapacitySchedule`
 * (capacity annotations are simply omitted) and/or without prep units (no
 * prep notes). `nightSchedule` is the COMPACT, PII-free per-night capacity
 * view (date/weekday/capacity only — see `calendar/night-schedule.ts`'s
 * `NightCapacity`; no `blocking_events` event titles, bd meal-planner-0v7.8)
 * since this render never needed event titles in the first place.
 * `nightSchedule`/`prep` are read-only inputs threaded in by the caller (the
 * orchestrator/build-plan integration owns actually wiring these) — this
 * module never fetches or derives them itself.
 */
export interface RenderPlanOptions {
  nightSchedule?: NightCapacitySchedule;
  prep?: PrepUnit[];
}

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

/**
 * Renders the optional paired side line (bd meal-planner-8zs.8), or `undefined`
 * when the meal has no side. A `side` is a shared accompaniment for everyone —
 * DISTINCT from `veg.second_dish` (the daughter's substitute main, rendered by
 * `renderVegCoverage`) — so both can appear on one meal. Prefers the enriched
 * `sideRecipe.title` (authoritative, freshly fetched), falling back to
 * `side.title` (captured at selection time) when `sideRecipe` is absent.
 */
function renderSide(meal: EnrichedMeal): string | undefined {
  if (!meal.side) {
    return undefined;
  }
  const title = meal.sideRecipe?.title ?? meal.side.title;
  return `    + side: ${collapseNewlines(title)}`;
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

/** Renders one meal as a bullet block: title + coverage + flags, optional side, rationale, source hint. */
function renderMeal(meal: EnrichedMeal): string {
  const title = collapseNewlines(meal.title);
  const coverage = renderVegCoverage(meal);
  const flags = renderFlags(meal.flags);
  const rationale = collapseNewlines(meal.rationale);

  const lines = [`• *${title}* — ${coverage}${flags}`];
  const side = renderSide(meal);
  if (side !== undefined) {
    lines.push(side);
  }
  lines.push(`    _${rationale}_`, renderSourceHint(meal));
  return lines.join("\n");
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
 * Monday-first weekday index (0=Monday..6=Sunday) for an ISO calendar date
 * (`YYYY-MM-DD`), used only to ORDER day sections Monday->Sunday (ADR 0005
 * D4) — not tied to any particular timezone, since a date-only ISO string
 * has no time component to shift across a zone boundary. Luxon's own
 * `weekday` getter is already Monday=1..Sunday=7, so this is a direct
 * reindex.
 */
function mondayFirstIndex(isoDate: string): number {
  return DateTime.fromISO(isoDate).weekday - 1;
}

/** Full weekday name (e.g. `"Monday"`) derived from an ISO calendar date. */
function weekdayLabel(isoDate: string): string {
  return DateTime.fromISO(isoDate).toFormat("cccc");
}

/** Abbreviated weekday name (e.g. `"Mon"`) derived from an ISO calendar date. */
function abbreviatedWeekday(isoDate: string): string {
  return DateTime.fromISO(isoDate).toFormat("ccc");
}

/**
 * Renders a night's capacity as a short inline annotation (ADR 0005 D4: "a
 * capacity annotation, e.g. a 'quick'/'leftovers' marker" — exact wording is
 * an open presentation item both ADR 0004 and ADR 0005 explicitly leave
 * open). `undefined` for `FULL` (the common case; no annotation needed).
 */
function renderCapacityAnnotation(capacity: Capacity): string | undefined {
  switch (capacity) {
    case "FULL":
      return undefined;
    case "QUICK":
      return "_(quick night)_";
    case "NONE":
      return "_(no cook — leftovers)_";
  }
}

/**
 * Renders one placed prep unit as a "prep Sun -> serve Tue" note (ADR 0004
 * D5 / ADR 0005 D4), indented as a bullet continuation line. Returns
 * `undefined` when `prep_date` is still `null` (not yet placed) — nothing to
 * show.
 */
function renderPrepNote(unit: PrepUnit): string | undefined {
  if (unit.prep_date === null) {
    return undefined;
  }
  const description = collapseNewlines(unit.description);
  const prepDay = abbreviatedWeekday(unit.prep_date);
  const serveDay = abbreviatedWeekday(unit.serve_date);
  return `    ↳ ${description} — prep ${prepDay} → serve ${serveDay}`;
}

/** One Monday->Sunday-ordered day section's merged rendering inputs. */
interface DaySectionInput {
  date: string;
  weekday: string;
  capacity: Capacity | undefined;
  meal: EnrichedMeal | undefined;
}

/**
 * Builds the Monday->Sunday-ordered list of day sections (ADR 0005 D4) by
 * merging `plan.meals` (keyed by their `day`) with `nightSchedule` (when
 * supplied — the capacity/weekday-name source of truth). Every date that
 * has either a placed meal or a `nightSchedule` entry is a candidate; a
 * `nightSchedule` night with no meal is kept ONLY when its capacity is
 * `NONE` (so a plain "no cook — leftovers" line can show) — a capacity-
 * having night with no meal otherwise is dropped rather than rendered
 * blank. When `nightSchedule` is absent, only meal days are known/rendered,
 * with no capacity annotation.
 */
function buildDaySections(
  plan: EnrichedWeekPlan,
  nightSchedule: NightCapacitySchedule | undefined,
): DaySectionInput[] {
  const mealsByDay = new Map<string, EnrichedMeal>();
  for (const meal of plan.meals) {
    if (meal.day !== null) {
      mealsByDay.set(meal.day, meal);
    }
  }

  const entries = new Map<string, DaySectionInput>();

  for (const night of nightSchedule ?? []) {
    const meal = mealsByDay.get(night.date);
    if (meal === undefined && night.capacity !== "NONE") {
      continue;
    }
    entries.set(night.date, {
      date: night.date,
      weekday: night.weekday,
      capacity: night.capacity,
      meal,
    });
  }

  for (const [date, meal] of mealsByDay) {
    if (!entries.has(date)) {
      entries.set(date, {
        date,
        weekday: weekdayLabel(date),
        capacity: undefined,
        meal,
      });
    }
  }

  return [...entries.values()].sort(
    (a, b) => mondayFirstIndex(a.date) - mondayFirstIndex(b.date),
  );
}

/** Renders one day section: `*Weekday* annotation`, then the meal bullet + any prep note. */
function renderDaySection(
  entry: DaySectionInput,
  prepByServeDate: Map<string, PrepUnit>,
): string {
  const annotation =
    entry.capacity !== undefined
      ? renderCapacityAnnotation(entry.capacity)
      : undefined;
  const heading =
    annotation !== undefined
      ? `*${entry.weekday}* ${annotation}`
      : `*${entry.weekday}*`;

  if (entry.meal === undefined) {
    return heading;
  }

  let mealBlock = renderMeal(entry.meal);
  const prepUnit = prepByServeDate.get(entry.date);
  const prepLine =
    prepUnit !== undefined ? renderPrepNote(prepUnit) : undefined;
  if (prepLine !== undefined) {
    mealBlock = `${mealBlock}\n${prepLine}`;
  }

  return [heading, mealBlock].join("\n\n");
}

/**
 * Renders the day-ordered (Monday->Sunday) blocks (ADR 0005 D4). Returns one
 * block string per day section, in Monday->Sunday order; the caller joins
 * them (and the header/summary) the same way the v1.0 slot-sectioned render
 * does.
 */
function renderDayOrderedBlocks(
  plan: EnrichedWeekPlan,
  options: RenderPlanOptions,
): string[] {
  const prepByServeDate = new Map(
    (options.prep ?? []).map((unit) => [unit.serve_date, unit] as const),
  );

  return buildDaySections(plan, options.nightSchedule).map((entry) =>
    renderDaySection(entry, prepByServeDate),
  );
}

/**
 * Renders the full plan to Slack mrkdwn: a header naming `week_key`, the
 * optional `summary` as a short intro line, then either:
 *
 * - **Day-ordered mode** (ADR 0005 D4) — when at least one meal has a
 *   non-null `day`: one section per day, Monday->Sunday, each with its
 *   weekday label, a capacity annotation (from `options.nightSchedule` when
 *   supplied), the meal, and any matching prep note (from `options.prep`).
 * - **v1.0 fallback** (unchanged) — when every meal has `day: null` (a
 *   legacy v1.0 plan, or the ADR 0004 D6 degraded no-calendar path): one
 *   section per `slot_type` (`constrained` -> "Weeknights", `relaxed` ->
 *   "Weekend"), each with one bullet block per meal in the plan's own array
 *   order (stable, deterministic — no re-sorting). A section with no meals
 *   is omitted entirely rather than rendered empty.
 */
export function renderPlan(
  plan: EnrichedWeekPlan,
  options: RenderPlanOptions = {},
): string {
  const blocks: string[] = [`*Meal plan for the week of ${plan.week_key}*`];

  if (plan.summary !== undefined) {
    blocks.push(collapseNewlines(plan.summary));
  }

  const dayOrdered = plan.meals.some((meal) => meal.day !== null);

  if (dayOrdered) {
    blocks.push(...renderDayOrderedBlocks(plan, options));
  } else {
    for (const { slot_type, heading } of SLOT_SECTIONS) {
      const meals = plan.meals.filter((meal) => meal.slot_type === slot_type);
      const section = renderSection(heading, meals);
      if (section !== undefined) {
        blocks.push(section);
      }
    }
  }

  return blocks.join("\n\n");
}
