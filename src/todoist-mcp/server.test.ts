import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateTaskInput,
  ListCompletedInput,
  ListCompletedResult,
  TodoistTask,
  UpdateTaskInput,
} from "./schema.js";
import { createTodoistMcpServer, type TodoistClientLike } from "./server.js";
import { TodoistApiError } from "./todoist-client.js";

/**
 * `createTodoistMcpServer` (bd meal-planner-iu7.1): exercises the full MCP
 * protocol round-trip (real `Client` <-> real `McpServer`, wired over
 * `InMemoryTransport` so no subprocess/stdio is needed) against a fake
 * `TodoistClientLike` — asserting each of the 3 tools is registered,
 * forwards its parsed input to the client, and surfaces both the success and
 * API-error paths as MCP tool results.
 */

const SAMPLE_TASK: TodoistTask = {
  id: "6XGgmFVcrG5RRjVr",
  content: "Tomato Soup",
  description: "mp:rid=note-1",
  project_id: "6XGgm6PHrGgMpCFX",
  due_date: "2026-08-02",
  completed_at: null,
};

function makeFakeClient(): TodoistClientLike & {
  createTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  listCompletedByCompletionDate: ReturnType<typeof vi.fn>;
} {
  return {
    createTask: vi.fn(async (_input: CreateTaskInput) => SAMPLE_TASK),
    updateTask: vi.fn(async (_input: UpdateTaskInput) => SAMPLE_TASK),
    listCompletedByCompletionDate: vi.fn(
      async (_input: ListCompletedInput): Promise<ListCompletedResult> => ({
        items: [SAMPLE_TASK],
        nextCursor: null,
      }),
    ),
  };
}

async function connectedClient(todoistClient: TodoistClientLike) {
  const server = createTodoistMcpServer({ todoistClient });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function firstText(result: unknown): string {
  const content = (
    result as { content?: Array<{ type: string; text: string }> }
  ).content;
  return content?.[0]?.text ?? "";
}

describe("createTodoistMcpServer", () => {
  let fakeClient: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    fakeClient = makeFakeClient();
  });

  it("registers exactly the three tools: create_task, update_task, list_completed", async () => {
    const client = await connectedClient(fakeClient);

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_task",
      "list_completed",
      "update_task",
    ]);
  });

  it("create_task forwards the parsed input to TodoistClient.createTask and returns the created task", async () => {
    const client = await connectedClient(fakeClient);

    const result = await client.callTool({
      name: "create_task",
      arguments: {
        project_id: "6XGgm6PHrGgMpCFX",
        content: "Tomato Soup",
        description: "mp:rid=note-1",
        due_date: "2026-08-02",
      },
    });

    expect(fakeClient.createTask).toHaveBeenCalledWith({
      project_id: "6XGgm6PHrGgMpCFX",
      content: "Tomato Soup",
      description: "mp:rid=note-1",
      due_date: "2026-08-02",
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(SAMPLE_TASK);
  });

  it("update_task forwards task_id + only the provided fields to TodoistClient.updateTask", async () => {
    const client = await connectedClient(fakeClient);

    const result = await client.callTool({
      name: "update_task",
      arguments: { task_id: "6XGgmFVcrG5RRjVr", content: "Tomato Soup v2" },
    });

    expect(fakeClient.updateTask).toHaveBeenCalledWith({
      task_id: "6XGgmFVcrG5RRjVr",
      content: "Tomato Soup v2",
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(SAMPLE_TASK);
  });

  it("list_completed forwards since/until to TodoistClient.listCompletedByCompletionDate and returns items+nextCursor", async () => {
    const client = await connectedClient(fakeClient);

    const result = await client.callTool({
      name: "list_completed",
      arguments: {
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-25T00:00:00Z",
      },
    });

    expect(fakeClient.listCompletedByCompletionDate).toHaveBeenCalledWith({
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-25T00:00:00Z",
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({
      items: [SAMPLE_TASK],
      nextCursor: null,
    });
  });

  it("rejects a call missing a required field (e.g. list_completed without until) without reaching TodoistClient", async () => {
    const client = await connectedClient(fakeClient);

    const result = await client.callTool({
      name: "list_completed",
      arguments: { since: "2026-07-01T00:00:00Z" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("until");
    expect(fakeClient.listCompletedByCompletionDate).not.toHaveBeenCalled();
  });

  it("surfaces a TodoistApiError from the client as an MCP tool error result (isError: true)", async () => {
    fakeClient.createTask.mockRejectedValueOnce(
      new TodoistApiError(
        "Required argument is missing",
        400,
        "ARGUMENT_MISSING",
      ),
    );
    const client = await connectedClient(fakeClient);

    const result = await client.callTool({
      name: "create_task",
      arguments: { project_id: "p1", content: "x" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Required argument is missing");
    expect(firstText(result)).toContain("400");
    expect(firstText(result)).toContain("ARGUMENT_MISSING");
  });
});
