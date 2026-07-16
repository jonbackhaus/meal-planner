# Design — NoteStore hashtags as authoritative recipe metadata

## Problem

SPEC §5.2 designs the planner around "existing, human-maintained tags" (Season,
Effort, Quality). The v1.0 build never reads them — the ingest LLM *re-infers*
season/effort/quality/veg from recipe text, which is less accurate than the
user's ground truth and is blind to course tags like `#side`. Consequence: a
side dish (Honey Mustard Potato Salad, tagged `#side`) was selected as a
standalone weeknight dinner.

Apple Notes hashtags are **not** reachable via osascript (a note exposes only
`container/body/id/name/plaintext/dates/shared/passwordProtected`; the tag is in
none of `plaintext()`/`body()`). They live in `NoteStore.sqlite` as inline-text
attachments. Verified readable: note `Z_PK 10474` ("Honey Mustard Potato Salad",
= osascript id `…/ICNote/p10474`) → tags `#summer #side #doahead #fall #spring
#5stars` via `ZNOTE1`.

## Decisions (ratified)

- **Full**: make tags authoritative for course/quality/season/effort/diet.
- Read `NoteStore.sqlite` **only** for the hashtag table (flat, stable columns) —
  a deliberate, scoped exception to the "never parse NoteStore" rule, which was
  about the fragile gzip'd-protobuf note *body*, not this.
- Course exclusion set: exclude `#side`,`#dessert`,`#breakfast`,`#appetizer` from
  the dinner pools; keep `#dinner`,`#lunch`, and untagged eligible.
- Veg = tag **positive-override** (`#vegetarian`/`#vegan` → `vegetarian`) + LLM
  fallback (absence of tag must NOT imply meat).

## Corpus tag taxonomy (observed)

course: dinner, lunch, dessert, side, breakfast, appetizer · quality: untested,
{3,4,5}-stars · season: fall, summer, winter, spring · effort: quick, do-ahead ·
diet: vegetarian, vegan · other: kids, entertaining, technique, clean, smoker,
slowcooker, holidays, thanksgiving, emma, charlotte…

Alias-folding required: `doahead`→`do-ahead`, `{3,4,5}stars`→`{n}-stars`. Ignore
empty and malformed (`#5-`).

## Components

### 1. NoteStore hashtag reader — `src/recipe-mcp/notes-tags.ts`

```ts
export interface NotesTagsOptions { storePath?: string; storeUuid?: string }
export function readNoteTags(opts?: NotesTagsOptions): Promise<Map<string, string[]>>
```

- Read-only open (`file:<path>?mode=ro&immutable=1`); default path
  `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.
- Query: `SELECT ZNOTE1, ZALTTEXT FROM ZICCLOUDSYNCINGOBJECT
  WHERE ZTYPEUTI1='com.apple.notes.inlinetextattachment.hashtag' AND ZNOTE1 IS NOT NULL`.
- Reconstruct the osascript-shaped note id: `x-coredata://<storeUuid>/ICNote/p<ZNOTE1>`.
  Derive `storeUuid` from the note ids we already have (osascript `readNotes`
  returns full ids), OR read `Z_UUID`/store identifier. Simpler: return keyed by
  the numeric `p<Z_PK>` suffix and let the merge match on the id suffix — avoids
  needing the store uuid. **Chosen:** key by the trailing `p<N>` of the id.
- Normalize each tag via `normalizeTag` (strip `#`, lowercase, alias-fold); drop
  empties.
- Fail soft: missing/locked/unreadable DB or absent table → empty map + one
  `console.warn` (never throw; sync must survive a Notes-DB hiccup). Pure aside
  from the read.

`normalizeTag(raw): string | null` — exported, unit-tested against the observed
variants.

### 2. Tag → metadata mapping — `src/recipe-mcp/tag-metadata.ts`

Pure, no I/O:

```ts
export interface TagMetadata {
  tags: string[];                 // normalized, deduped
  is_side: boolean;
  main_dinner_eligible: boolean;  // !(side|dessert|breakfast|appetizer)
  quality?: 3 | 4 | 5 | "untested";
  season_tags: string[];          // subset of the 4 seasons
  effort_tags: string[];          // subset of {quick, do-ahead}
  veg_from_tags: "vegetarian" | undefined; // #vegetarian/#vegan positive override
}
export function tagMetadata(tags: string[]): TagMetadata
```

Quality precedence: 5 > 4 > 3 > untested; default (no quality tag) `undefined`
(let existing behavior stand rather than forcing `untested`). Season/effort =
intersection with the known sets.

### 3. Store + candidate schema

`structured-store` gains persisted `tags` (JSON array), `is_side`, and
`main_dinner_eligible` alongside `fields_json`. `RecipeCandidate`
(`recipe-mcp/schema.ts`) and the `search_recipes` projection gain `is_side` /
`main_dinner_eligible` / `tags`. Additive columns; no removal of existing fields.

### 4. Merge in sync — `sync.ts`

- Once per sync: `const tagsByNote = await readNoteTags()` (cheap; ~one query).
- Per note: `const tm = tagMetadata(tagsByNote.get(idSuffix) ?? [])`.
- Build the stored structured record = **LLM extraction** (times, ingredients,
  veg fallback) **overlaid** with tag-derived fields:
  - `quality` ← `tm.quality ?? llm.quality`
  - `season_tags` ← `tm.season_tags` (authoritative; fall back to llm only if empty)
  - `effort_tags` ← `tm.effort_tags` (authoritative; fall back if empty)
  - `veg_status` ← `tm.veg_from_tags ?? llm.veg_status`
  - `tags`, `is_side`, `main_dinner_eligible` ← from `tm`
- **Gating:** LLM extraction stays body-hash-gated (unchanged, expensive). The
  tag read + merge runs every sync (cheap) so a hashtag edit updates metadata
  without re-extraction. Requires the structured record's "up to date" check to
  re-merge tags even when the body hash matches — i.e. always re-write the
  tag-derived portion. Keep it simple: recompute + upsert the merged record each
  sync; skip only the LLM call on hash match.

### 5. Planner — `pools.ts`

Deterministic hard filter (ADR 0003): drop `main_dinner_eligible === false`
candidates from both weeknight/weekend pools *before* the LLM sees them. Sides
remain in the store/index (future pairing), just never offered as a main.
`search_recipes` filters gain an optional `main_dinner_only` predicate the pool
composer sets.

## Testing

- `normalizeTag` / `tagMetadata`: pure unit tests over the real observed variants
  (doahead, 5stars, #5-, empty, multi-tag, veg override, course exclusion).
- `readNoteTags`: unit-test against a tiny fixture SQLite built in the test (create
  a temp DB with the two relevant columns + rows) — no dependency on the real
  Notes DB in CI. Plus a soft-fail test (missing file → empty map, no throw).
- `sync` merge: extend sync tests — a note with tags gets tag-derived fields;
  body-hash-skip still re-merges tags.
- `pools`: side/non-dinner candidates are filtered out.
- Live (local only, not CI): `readNoteTags()` returns `#side` for `p10474`;
  re-sync the 50-note index; a generated plan no longer selects a `#side` recipe
  as a main.

## Out of scope (follow-ups)

- Slimming the LLM extraction prompt to stop inferring quality/season/effort now
  that tags own them (a cost win) — deferred to avoid an extractor-version bump +
  full re-extraction here.
- Pairing a side with a main (burgers + potato salad) — the `is_side` data is
  captured now so this is additive later.
- Using non-planning tags (`#kids`, `#entertaining`, `#technique`) as soft signals.
