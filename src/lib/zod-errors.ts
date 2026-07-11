import type { z } from "zod";

/**
 * Shared helper for turning a `ZodError` into a short, human-readable,
 * newline-joined summary (`- path.to.field: message` per issue). Used
 * everywhere raw LLM output is schema-validated (`recipe-mcp/extraction.ts`,
 * `planner/select.ts`, `planner/validate.ts`) so the summary format — and the
 * "never log the raw payload" discipline around it — stays consistent in one
 * place instead of being re-implemented per call site.
 */
export function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
