/**
 * Pure mapping from a note's Apple Notes hashtags to the recipe metadata the
 * planner consumes (bd — NoteStore tags feature). No I/O: the NoteStore read
 * lives in `notes-tags.ts`; this module just interprets the tag strings.
 *
 * The user's tags are the authoritative source for course/quality/season/
 * effort/diet (SPEC §5.2). Times + ingredients still come from the LLM
 * extraction pass (they live in the note body, not the tags).
 */

/** Courses that are NOT standalone dinners — a recipe carrying any of these is excluded from the main-dinner pools. */
const COURSE_EXCLUDE = new Set(["side", "dessert", "breakfast", "appetizer"]);
const SEASONS = new Set(["fall", "summer", "winter", "spring"]);
const EFFORTS = new Set(["quick", "do-ahead"]);
const VEG = new Set(["vegetarian", "vegan"]);

/**
 * Normalizes one raw hashtag (e.g. Apple Notes `ZALTTEXT` "#Side") to a stable
 * key: strips a leading `#`, lowercases, trims, and folds the hyphen variants
 * seen in the real corpus (`doahead`→`do-ahead`, `{3,4,5}stars`→`{n}-stars`).
 * Returns `null` for empty or letterless/malformed tags ("", "#", "#5-").
 */
export function normalizeTag(raw: string): string | null {
  let t = raw.trim().replace(/^#/, "").trim().toLowerCase();
  // Drops "", "#", "5-", and other numeric/punctuation-only noise.
  if (!/[a-z]/.test(t)) {
    return null;
  }
  if (t === "doahead") {
    t = "do-ahead";
  }
  const stars = t.match(/^([345])stars$/);
  if (stars) {
    t = `${stars[1]}-stars`;
  }
  return t;
}

export interface TagMetadata {
  /** All of the note's hashtags, normalized + deduped. */
  tags: string[];
  /** Carries the `#side` tag (retained for future side-with-main pairing). */
  is_side: boolean;
  /** False when any excluded-course tag is present (side/dessert/breakfast/appetizer). */
  main_dinner_eligible: boolean;
  /** From the quality tags; undefined when the note has none (leave existing behavior). */
  quality?: 3 | 4 | 5 | "untested";
  season_tags: string[];
  effort_tags: string[];
  /** `#vegetarian`/`#vegan` → a positive veg override; undefined otherwise (absence must NOT imply meat). */
  veg_from_tags?: "vegetarian";
}

function qualityFrom(tags: Set<string>): TagMetadata["quality"] {
  if (tags.has("5-stars")) return 5;
  if (tags.has("4-stars")) return 4;
  if (tags.has("3-stars")) return 3;
  if (tags.has("untested")) return "untested";
  return undefined;
}

/**
 * Interprets a note's hashtags into planner metadata. Defensively re-normalizes
 * its input, so it's correct whether given raw or already-normalized tags.
 */
export function tagMetadata(rawTags: readonly string[]): TagMetadata {
  const normalized = new Set<string>();
  for (const raw of rawTags) {
    const t = normalizeTag(raw);
    if (t !== null) {
      normalized.add(t);
    }
  }

  const has = (t: string) => normalized.has(t);
  return {
    tags: [...normalized],
    is_side: has("side"),
    main_dinner_eligible: ![...COURSE_EXCLUDE].some(has),
    quality: qualityFrom(normalized),
    season_tags: [...normalized].filter((t) => SEASONS.has(t)),
    effort_tags: [...normalized].filter((t) => EFFORTS.has(t)),
    veg_from_tags: [...VEG].some(has) ? "vegetarian" : undefined,
  };
}
