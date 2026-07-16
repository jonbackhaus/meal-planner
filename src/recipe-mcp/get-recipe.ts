import { type Recipe, RecipeSchema } from "./schema.js";
import type { StructuredStore } from "./structured-store.js";
import { tagMetadata } from "./tag-metadata.js";
import type { StoredNote } from "./vector-store.js";

/**
 * Full-tier `get_recipe` retrieval (ADR 0001 D2, bd meal-planner-q95.5).
 *
 * Per ADR 0003 D1 (same as `search.ts`), v1.0's orchestrator calls this
 * DETERMINISTICALLY — it is a directly-callable async function, not an MCP
 * stdio server.
 *
 * Unlike `searchRecipes` (the cheap tier, no ingredient block, called for
 * every candidate), `getRecipe` is the EXPENSIVE tier: it composes the note
 * metadata (title/body, via the store that owns the `notes` table) with the
 * cached structured fields (time/veg/tags/quality/ingredients) to assemble
 * the COMPLETE `Recipe`, including the ingredient block. It is called only
 * for the ~5-6 CHOSEN recipes, after selection.
 */

/** The minimal note-metadata surface `getRecipe` needs — satisfied by `VectorStore.getNote`. */
export interface NoteStore {
  getNote(id: string): StoredNote | null;
}

export interface GetRecipeDeps {
  noteStore: NoteStore;
  structuredStore: StructuredStore;
}

/**
 * Assembles the full `Recipe` for `id`, or `null` when it can't be
 * assembled:
 *  - no stored note for `id` at all, OR
 *  - the note exists but has no successful structured extraction yet
 *    (`getStructured` returns null, or a `needs_review` record with
 *    `fields: null`).
 *
 * The not-ready case is treated as "not found" rather than synthesized with
 * empty/default fields: the orchestrator only calls `get_recipe` for
 * recipes it already selected FROM `searchRecipes` results, which by
 * definition had a successful structured extraction (an unextracted
 * candidate can only surface from an UNFILTERED search — see
 * `search.ts`'s `assembleCandidate` — and even then should not be
 * presentable as a complete recipe with a real ingredient list).
 *
 * The assembled object is validated against `RecipeSchema` before being
 * returned (belt-and-suspenders): a malformed assembly throws rather than
 * silently returning a shape that doesn't match the frozen schema.
 */
export async function getRecipe(
  id: string,
  deps: GetRecipeDeps,
): Promise<Recipe | null> {
  const note = deps.noteStore.getNote(id);
  if (!note) {
    return null;
  }

  const record = deps.structuredStore.getStructured(id);
  const fields = record?.fields ?? null;
  if (!fields) {
    return null;
  }

  // Tags are authoritative for course/quality/season/effort (SPEC §5.2),
  // merged over the body-derived extraction here just as `searchRecipes` does,
  // so the enriched Recipe matches the candidate it was selected from.
  const tm = tagMetadata(record?.tags ?? []);

  const recipe: Recipe = {
    id: note.id,
    title: note.title,
    time: fields.time,
    effort_tags: tm.effort_tags,
    season_tags: tm.season_tags,
    quality: tm.quality,
    veg_status: tm.veg_from_tags ?? fields.veg_status,
    ingredients: fields.ingredients,
    body: note.body,
    source_note_id: note.id,
    tags: tm.tags,
    is_side: tm.is_side,
    main_dinner_eligible: tm.main_dinner_eligible,
  };

  return RecipeSchema.parse(recipe);
}
