import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CreateTaskInput,
  ListCompletedInput,
  ListCompletedResult,
  TodoistTask,
  UpdateTaskInput,
} from "./schema.js";
import {
  CreateTaskInputSchema,
  ListCompletedInputSchema,
  UpdateTaskInputSchema,
} from "./schema.js";
import { TodoistApiError } from "./todoist-client.js";

/**
 * The Todoist MCP server (bd meal-planner-iu7.1, ratified meal-planner-9kd,
 * ADR-0006 D2/D3): a genuine stdio MCP server (`@modelcontextprotocol/sdk`),
 * unlike `recipe-mcp` (called deterministically in-process, per its own
 * `get-recipe.ts` doc comment) — this server is meant to be spawned as a
 * subprocess and driven over the `StdioMcpServerSpec` plumbing already built
 * in `llm/agent-sdk-client.ts`. Wiring this server into that harness (and
 * into the commit/recency flows) is C1/C2/D1 — out of scope here.
 *
 * Exactly three tools, matching ratified 9kd:
 *  - `create_task`   — ADR-0006 D3 task write.
 *  - `update_task`   — ADR-0006 D4 soft-commit re-commit (update-in-place).
 *  - `list_completed` — §6.3 recency read (completed-task list).
 *
 * Thin transport: each tool handler does nothing but validate input (via the
 * registered zod schema) and delegate to `TodoistClient`. Errors are
 * reported as an MCP tool error result (`isError: true`) rather than
 * thrown, per the SDK convention for exposing a failed API call to the
 * calling model/agent.
 */

/** The minimal `TodoistClient` surface this server needs — satisfied by `TodoistClient` (mirrors `get-recipe.ts`'s `NoteStore` pattern, e.g. for a fake in tests). */
export interface TodoistClientLike {
  createTask(input: CreateTaskInput): Promise<TodoistTask>;
  updateTask(input: UpdateTaskInput): Promise<TodoistTask>;
  listCompletedByCompletionDate(
    input: ListCompletedInput,
  ): Promise<ListCompletedResult>;
}

export interface TodoistMcpServerDeps {
  todoistClient: TodoistClientLike;
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(error: unknown): CallToolResult {
  const message =
    error instanceof TodoistApiError
      ? `Todoist API error (${error.status}${
          error.errorTag ? ` ${error.errorTag}` : ""
        }): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createTodoistMcpServer(deps: TodoistMcpServerDeps): McpServer {
  const server = new McpServer({ name: "todoist-mcp", version: "0.1.0" });

  server.registerTool(
    "create_task",
    {
      title: "Create Todoist task",
      description:
        "Creates a Todoist task in the given project, returning the created task (including its Todoist-assigned id). `description` carries the caller-composed `mp:rid=<recipe_id>` marker (ADR-0006 D2) through verbatim — this tool does not generate it.",
      inputSchema: CreateTaskInputSchema,
    },
    async (args) => {
      try {
        return textResult(await deps.todoistClient.createTask(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Todoist task",
      description:
        "Updates an existing Todoist task in place by id (content/description/due_date, all optional) — enables soft-commit re-commit (ADR-0006 D4).",
      inputSchema: UpdateTaskInputSchema,
    },
    async (args) => {
      try {
        return textResult(await deps.todoistClient.updateTask(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_completed",
    {
      title: "List completed Todoist tasks",
      description:
        "Lists completed Todoist tasks within a completion-date range (`since`/`until`, RFC 3339, both required) — the recency source of truth (§6.3).",
      inputSchema: ListCompletedInputSchema,
    },
    async (args) => {
      try {
        return textResult(
          await deps.todoistClient.listCompletedByCompletionDate(args),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
