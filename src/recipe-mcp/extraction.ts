import { z } from "zod";
import type { LlmClient } from "../llm/llm-client.js";
import type { RawNote } from "./notes-reader.js";
import {
  IngredientSchema,
  QualitySchema,
  TimeFieldsSchema,
  VegStatusSchema,
} from "./schema.js";

/**
 * Ingest-time LLM extraction pass (ADR 0001 D1): turns one recipe note's
 * free text into the frozen structured fields (schema.ts), cached beside
 * the vector by sync.ts and gated on content hash + extractor version (see
 * structured-store.ts).
 *
 * `ExtractedFields` is COMPOSED from the existing frozen `schema.ts` pieces
 * (`TimeFieldsSchema`, `IngredientSchema`, `VegStatusSchema`,
 * `QualitySchema`) — it does not redefine them. Unlike the schema.ts object
 * schemas (which are deliberately non-strict, per the schema review), this
 * top-level schema IS `.strict()`: it validates raw LLM output, so an
 * unknown/hallucinated/drifted key must fail loudly rather than being
 * silently dropped.
 */
export const ExtractedFieldsSchema = z
  .object({
    time: TimeFieldsSchema,
    ingredients: z.array(IngredientSchema),
    veg_status: VegStatusSchema,
    effort_tags: z.array(z.string()),
    season_tags: z.array(z.string()),
    quality: QualitySchema.optional(),
  })
  .strict();

export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

/**
 * Thrown when a note's extraction cannot be completed (LLM query failure,
 * unparseable response, or schema validation still failing after the one
 * bounded repair attempt). Deliberately carries only the note id and a
 * short reason — never the note body or the raw LLM response — so it's
 * safe to log. Callers (sync.ts) catch this per-note and continue the
 * batch; see sync.ts's `needs_review` handling.
 */
export class ExtractionError extends Error {
  constructor(noteId: string, reason: string) {
    super(`extraction failed for note "${noteId}": ${reason}`);
    this.name = "ExtractionError";
  }
}

const MAX_REPAIR_ATTEMPTS = 1;

function buildExtractionPrompt(note: RawNote): string {
  return `You are extracting structured recipe data from a free-form recipe note.

Return ONLY a single JSON object (no markdown code fences, no commentary before or after) matching EXACTLY this shape and no other keys:

{
  "time": { "active": number|null, "total": number|null, "prep": number|null, "confidence": number (0..1) },
  "ingredients": [
    {
      "raw": string,
      "name": string,
      "prep": string,
      "quantity": { "kind": "scalar", "value": number } | { "kind": "range", "min": number, "max": number } | { "kind": "none" },
      "unit": string|null,
      "optional": boolean,
      "alternatives": string[],
      "group": string,
      "confidence": number (0..1),
      "needs_review": boolean
    }
  ],
  "veg_status": "vegetarian" | "contains_meat" | "unknown",
  "effort_tags": string[],
  "season_tags": string[],
  "quality": 3 | 4 | 5 | "untested"
}

Field rules:
- "raw" on every ingredient is the ORIGINAL ingredient line, verbatim, untouched — always keep it, even when you also fill in the parsed fields.
- "prep", "unit", "alternatives", "group", and "quality" are optional — omit the key entirely rather than using null/empty when not applicable ("unit" may be explicit null when there truly is no unit).
- Times are in MINUTES. Convert messy phrasing precisely and reflect uncertainty in "confidence":
  - "20-25 min" -> a single best-estimate number (e.g. 22 or 25) with confidence around 0.7-0.9.
  - "an hour and a half" -> 90.
  - "overnight" -> a large estimate (e.g. 480) with LOW confidence (e.g. 0.2-0.3), since it is not a precise duration.
- "veg_status" is deterministic given the ingredients you extracted: "contains_meat" if any ingredient is meat, poultry, fish, or gelatin; "vegetarian" if none are; "unknown" only when you truly cannot tell.
- Do not invent keys beyond the ones listed above — the schema is strict and unknown keys will be rejected.

Note title: ${note.title}

Note body:
${note.body}`;
}

function buildRepairPrompt(
  previousResponse: string,
  errorSummary: string,
): string {
  return `Your previous response failed schema validation.

Previous response:
${previousResponse}

Validation errors:
${errorSummary}

Return ONLY a corrected JSON object fixing every listed error, matching the exact same schema as before. No markdown code fences, no commentary.`;
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/** Pulls a JSON object out of raw LLM text, tolerating a ```json fenced block or surrounding prose. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
      throw new Error("no JSON object found in LLM response");
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

async function runLlm(
  noteId: string,
  llm: LlmClient,
  prompt: string,
  step: "extraction" | "repair",
): Promise<string> {
  try {
    const result = await llm.runQuery({ prompt });
    return result.text;
  } catch (error) {
    throw new ExtractionError(
      noteId,
      `LLM ${step} query failed: ${(error as Error).message}`,
    );
  }
}

/**
 * Runs the extraction pass for one note: prompts the LLM for structured
 * JSON, strict-validates it against `ExtractedFieldsSchema`, and — on a
 * parse or validation failure — makes ONE bounded repair re-prompt (feeding
 * back the concrete errors) before giving up. Throws `ExtractionError` if
 * the note still can't be extracted; never hangs and never retries more
 * than once. Callers are responsible for per-note isolation (see sync.ts).
 */
export async function extractRecipeFields(
  note: RawNote,
  llm: LlmClient,
): Promise<ExtractedFields> {
  let responseText = await runLlm(
    note.id,
    llm,
    buildExtractionPrompt(note),
    "extraction",
  );

  for (let attempt = 0; ; attempt += 1) {
    const isLastAttempt = attempt === MAX_REPAIR_ATTEMPTS;

    let candidate: unknown;
    try {
      candidate = extractJsonObject(responseText);
    } catch (error) {
      if (isLastAttempt) {
        throw new ExtractionError(
          note.id,
          `could not parse JSON from LLM response: ${(error as Error).message}`,
        );
      }
      responseText = await runLlm(
        note.id,
        llm,
        buildRepairPrompt(responseText, (error as Error).message),
        "repair",
      );
      continue;
    }

    const parsed = ExtractedFieldsSchema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }

    if (isLastAttempt) {
      throw new ExtractionError(
        note.id,
        `schema validation failed: ${summarizeZodError(parsed.error)}`,
      );
    }
    responseText = await runLlm(
      note.id,
      llm,
      buildRepairPrompt(responseText, summarizeZodError(parsed.error)),
      "repair",
    );
  }
}
