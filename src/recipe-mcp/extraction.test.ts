import { describe, expect, it, vi } from "vitest";
import { CostCapExceededError } from "../cost/cost-cap-exceeded-error.js";
import type { LlmClient, LlmResult } from "../llm/llm-client.js";
import {
  ExtractedFieldsSchema,
  ExtractionError,
  extractRecipeFields,
} from "./extraction.js";
import type { RawNote } from "./notes-reader.js";

function note(overrides: Partial<RawNote> = {}): RawNote {
  return {
    id: "note-1",
    title: "Weeknight Chili",
    body: "Ground beef, beans, chili powder. Takes about 20-25 min.",
    modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function validFields() {
  return {
    time: { active: 20, total: 45, prep: 10, confidence: 0.8 },
    ingredients: [
      {
        raw: "1 lb ground beef",
        name: "ground beef",
        quantity: { kind: "scalar", value: 1 },
        unit: "lb",
        optional: false,
        confidence: 0.9,
        needs_review: false,
      },
    ],
    veg_status: "contains_meat",
  };
}

function llmResult(text: string): LlmResult {
  return { text, usage: { inputTokens: 1, outputTokens: 1 } };
}

function makeFakeLlm(...responses: string[]): LlmClient {
  const runQuery = vi.fn();
  for (const response of responses) {
    runQuery.mockResolvedValueOnce(llmResult(response));
  }
  return { runQuery };
}

describe("ExtractedFieldsSchema", () => {
  it("parses a well-formed object", () => {
    const result = ExtractedFieldsSchema.safeParse(validFields());
    expect(result.success).toBe(true);
  });

  it("rejects an unknown top-level key (strict)", () => {
    const result = ExtractedFieldsSchema.safeParse({
      ...validFields(),
      hallucinated_field: "oops",
    });
    expect(result.success).toBe(false);
  });
});

describe("extractRecipeFields", () => {
  it("does NOT ask the LLM for quality/season/effort (tags own those — bd tag-slim)", async () => {
    const llm = makeFakeLlm(JSON.stringify(validFields()));

    await extractRecipeFields(note(), llm);

    const prompt = (llm.runQuery as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .prompt as string;
    expect(prompt).not.toContain("season_tags");
    expect(prompt).not.toContain("effort_tags");
    expect(prompt).not.toContain("quality");
    // still extracts the body-derived fields
    expect(prompt).toContain("veg_status");
    expect(prompt).toContain("ingredients");
  });

  it("parses a well-formed mocked LLM JSON response into ExtractedFields", async () => {
    const llm = makeFakeLlm(JSON.stringify(validFields()));

    const fields = await extractRecipeFields(note(), llm);

    expect(fields).toEqual(validFields());
    expect(llm.runQuery).toHaveBeenCalledTimes(1);
  });

  it("extracts JSON from a fenced ```json code block", async () => {
    const llm = makeFakeLlm(
      `Here you go:\n\`\`\`json\n${JSON.stringify(validFields())}\n\`\`\``,
    );

    const fields = await extractRecipeFields(note(), llm);

    expect(fields).toEqual(validFields());
  });

  it("does ONE bounded repair re-prompt on a strict-schema violation (unknown key), then succeeds", async () => {
    const badResponse = JSON.stringify({
      ...validFields(),
      hallucinated_field: "oops",
    });
    const goodResponse = JSON.stringify(validFields());
    const llm = makeFakeLlm(badResponse, goodResponse);

    const fields = await extractRecipeFields(note(), llm);

    expect(fields).toEqual(validFields());
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("does ONE bounded repair re-prompt on a bad shape, then succeeds", async () => {
    const badResponse = JSON.stringify({
      ...validFields(),
      veg_status: "definitely-not-a-status",
    });
    const goodResponse = JSON.stringify(validFields());
    const llm = makeFakeLlm(badResponse, goodResponse);

    const fields = await extractRecipeFields(note(), llm);

    expect(fields).toEqual(validFields());
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("throws ExtractionError if the repair attempt is still invalid (bounded to one retry)", async () => {
    const badResponse = JSON.stringify({
      ...validFields(),
      hallucinated_field: "oops",
    });
    const stillBadResponse = JSON.stringify({
      ...validFields(),
      another_bad_field: "still oops",
    });
    const llm = makeFakeLlm(badResponse, stillBadResponse);

    await expect(extractRecipeFields(note(), llm)).rejects.toThrow(
      ExtractionError,
    );
    expect(llm.runQuery).toHaveBeenCalledTimes(2);
  });

  it("throws ExtractionError (not a raw parse error) when the LLM never returns JSON at all", async () => {
    const llm = makeFakeLlm("I cannot help with that.", "Still no JSON here.");

    await expect(extractRecipeFields(note(), llm)).rejects.toThrow(
      ExtractionError,
    );
  });

  it("ExtractionError message includes the note id but not the note body", async () => {
    const llm = makeFakeLlm("nope", "nope again");
    const theNote = note({ id: "note-42", body: "SECRET_BODY_TEXT" });

    await expect(extractRecipeFields(theNote, llm)).rejects.toMatchObject({
      message: expect.stringContaining("note-42"),
    });
    await expect(extractRecipeFields(theNote, llm)).rejects.not.toMatchObject({
      message: expect.stringContaining("SECRET_BODY_TEXT"),
    });
  });

  it("rethrows a CostCapExceededError UNWRAPPED (not as ExtractionError) so sync can abort the batch", async () => {
    // The metered llm (SPEC §9.3) throws CostCapExceededError once the per-run
    // cap is tripped. If runLlm wrapped it in ExtractionError like an ordinary
    // failure, sync.ts's `instanceof CostCapExceededError` abort check could
    // never fire -- so it must propagate untouched.
    const llm: LlmClient = {
      runQuery: vi.fn(async () => {
        throw new CostCapExceededError(3, 2);
      }),
    };

    await expect(extractRecipeFields(note(), llm)).rejects.toBeInstanceOf(
      CostCapExceededError,
    );
  });
});
