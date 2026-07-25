import { z } from "zod";

/**
 * Zod schemas for the Todoist MCP server (bd meal-planner-iu7.1, ratified
 * meal-planner-9kd, ADR-0006 D2/D3).
 *
 * Thin transport: these mirror the official Todoist REST/Sync v1 field names
 * (verified against https://developer.todoist.com/openapi.json, tag "Tasks")
 * directly — no renaming/aggregation beyond narrowing each response down to
 * the fields this contract actually needs. `project_id` is accepted as a
 * plain string input (never resolved from a name here): per ADR-0006 D3, the
 * config-driven project name -> id mapping is a C5 concern, out of scope for
 * this thin server.
 *
 * Zod schemas are the single source of truth; TS types are derived via
 * `z.infer` (matches the convention in `recipe-mcp/schema.ts`).
 */

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

export const CreateTaskInputSchema = z.object({
  /** Todoist project id (config-resolved by the caller; never a name here). */
  project_id: z.string().min(1),
  /** Task title. */
  content: z.string().min(1),
  /** Carries the caller-composed `mp:rid=<id>` marker (ADR-0006 D2); passed through verbatim. */
  description: z.string().optional(),
  /** ISO due date (`yyyy-MM-dd`), e.g. the meal's `day` (ADR 0005) or a prep unit's `prep_date`. */
  due_date: z.string().min(1).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = z.object({
  /** The Todoist task id to update in place (ADR-0006 D4 soft-commit re-commit). */
  task_id: z.string().min(1),
  content: z.string().min(1).optional(),
  description: z.string().optional(),
  due_date: z.string().min(1).optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const ListCompletedInputSchema = z.object({
  /** Start of the completion-date range, inclusive (RFC 3339 datetime; required by the Todoist endpoint). */
  since: z.string().min(1),
  /** End of the completion-date range, exclusive (RFC 3339 datetime; required by the Todoist endpoint). */
  until: z.string().min(1),
  project_id: z.string().optional(),
  /** Opaque pagination cursor from a previous call's `next_cursor`. */
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
export type ListCompletedInput = z.infer<typeof ListCompletedInputSchema>;

// ---------------------------------------------------------------------------
// Response shapes (narrowed to what ADR-0006 needs: id for persistence
// (D4), description for the mp:rid round-trip (D2), content/project_id/
// due_date/completed_at for recency + display)
// ---------------------------------------------------------------------------

export const TodoistTaskSchema = z.object({
  id: z.string(),
  content: z.string(),
  description: z.string(),
  project_id: z.string(),
  due_date: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type TodoistTask = z.infer<typeof TodoistTaskSchema>;

export const ListCompletedResultSchema = z.object({
  items: z.array(TodoistTaskSchema),
  nextCursor: z.string().nullable(),
});
export type ListCompletedResult = z.infer<typeof ListCompletedResultSchema>;
