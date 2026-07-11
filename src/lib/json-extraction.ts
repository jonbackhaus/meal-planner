/**
 * Shared helper for pulling a single JSON object out of raw LLM response
 * text. LLMs are asked to emit ONLY a JSON object, but in practice may wrap
 * it in a ```json fenced code block or surround it with prose — this
 * tolerates both before falling back to a raw `{...}` slice scan.
 *
 * Originally lived only in `recipe-mcp/extraction.ts`; factored out here so
 * `planner/select.ts` can reuse the exact same tolerant-extraction behavior
 * instead of re-implementing it.
 */
export function extractJsonObject(text: string): unknown {
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
