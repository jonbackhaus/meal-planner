import { describe, expect, it, vi } from "vitest";
import {
  type FetchResponseLike,
  TodoistApiError,
  TodoistClient,
} from "./todoist-client.js";

/**
 * `TodoistClient` (bd meal-planner-iu7.1): thin fetch wrapper over the
 * official Todoist REST/Sync v1 API. Every test mocks the fetch
 * implementation (DI, mirroring `weather/weather.test.ts`) — no real network
 * calls. Asserts each method builds the right request (endpoint, auth
 * header, body/query) and correctly parses both the success and error shapes
 * confirmed against https://developer.todoist.com/openapi.json.
 */

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const RAW_ITEM = {
  id: "6XGgmFVcrG5RRjVr",
  content: "Tomato Soup",
  description: "mp:rid=note-1",
  project_id: "6XGgm6PHrGgMpCFX",
  due: { date: "2026-08-02", is_recurring: false, lang: "en", string: "" },
  completed_at: null,
};

describe("TodoistClient.createTask", () => {
  it("POSTs to /tasks with the Bearer auth header and the exact body fields", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, RAW_ITEM),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await client.createTask({
      project_id: "6XGgm6PHrGgMpCFX",
      content: "Tomato Soup",
      description: "mp:rid=note-1",
      due_date: "2026-08-02",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.todoist.com/api/v1/tasks");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      project_id: "6XGgm6PHrGgMpCFX",
      content: "Tomato Soup",
      description: "mp:rid=note-1",
      due_date: "2026-08-02",
    });
  });

  it("parses the created task, returning the Todoist-assigned id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, RAW_ITEM));
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    const task = await client.createTask({
      project_id: "6XGgm6PHrGgMpCFX",
      content: "Tomato Soup",
    });

    expect(task).toEqual({
      id: "6XGgmFVcrG5RRjVr",
      content: "Tomato Soup",
      description: "mp:rid=note-1",
      project_id: "6XGgm6PHrGgMpCFX",
      due_date: "2026-08-02",
      completed_at: null,
    });
  });

  it("omits optional fields from the request body when not provided", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, RAW_ITEM),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await client.createTask({
      project_id: "6XGgm6PHrGgMpCFX",
      content: "Tomato Soup",
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      project_id: "6XGgm6PHrGgMpCFX",
      content: "Tomato Soup",
    });
  });

  it("throws TodoistApiError with the parsed message/status/tag on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: "Required argument is missing",
        error_code: 19,
        error_tag: "ARGUMENT_MISSING",
      }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await expect(
      client.createTask({ project_id: "p1", content: "" }),
    ).rejects.toMatchObject({
      name: "TodoistApiError",
      message: "Required argument is missing",
      status: 400,
      errorTag: "ARGUMENT_MISSING",
    });
  });

  it("throws TodoistApiError without leaking the token when auth fails", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, {
        error: "Invalid token",
        error_tag: "AUTH_INVALID_TOKEN",
      }),
    );
    const client = new TodoistClient({ apiToken: "secret-token", fetchImpl });

    let thrown: TodoistApiError | undefined;
    try {
      await client.createTask({ project_id: "p1", content: "x" });
      expect.fail("expected createTask to throw");
    } catch (error) {
      thrown = error as TodoistApiError;
    }

    expect(thrown).toBeInstanceOf(TodoistApiError);
    expect(thrown?.status).toBe(401);
    expect(thrown?.message).not.toContain("secret-token");
  });
});

describe("TodoistClient.updateTask", () => {
  it("POSTs to /tasks/{task_id} with only the provided fields", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { ...RAW_ITEM, content: "Tomato Soup (v2)" }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await client.updateTask({
      task_id: "6XGgmFVcrG5RRjVr",
      content: "Tomato Soup (v2)",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.todoist.com/api/v1/tasks/6XGgmFVcrG5RRjVr");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      content: "Tomato Soup (v2)",
    });
  });

  it("parses the updated task", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...RAW_ITEM, description: "mp:rid=note-2" }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    const task = await client.updateTask({
      task_id: "6XGgmFVcrG5RRjVr",
      description: "mp:rid=note-2",
    });

    expect(task.description).toBe("mp:rid=note-2");
  });

  it("throws TodoistApiError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, {
        error: "Item not found",
        error_tag: "ITEM_NOT_FOUND",
      }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await expect(
      client.updateTask({ task_id: "missing", content: "x" }),
    ).rejects.toMatchObject({ status: 404, errorTag: "ITEM_NOT_FOUND" });
  });
});

describe("TodoistClient.listCompletedByCompletionDate", () => {
  it("GETs /tasks/completed/by_completion_date with since/until as required query params", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { items: [RAW_ITEM], next_cursor: null }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await client.listCompletedByCompletionDate({
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-25T00:00:00Z",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.todoist.com/api/v1/tasks/completed/by_completion_date?since=2026-07-01T00%3A00%3A00Z&until=2026-07-25T00%3A00%3A00Z",
    );
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("includes optional project_id/cursor/limit in the query string when provided", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { items: [], next_cursor: null }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await client.listCompletedByCompletionDate({
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-25T00:00:00Z",
      project_id: "6XGgm6PHrGgMpCFX",
      cursor: "abc.def",
      limit: 50,
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("project_id=6XGgm6PHrGgMpCFX");
    expect(url).toContain("cursor=abc.def");
    expect(url).toContain("limit=50");
  });

  it("parses items and next_cursor (camelCased) from the response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        items: [RAW_ITEM],
        next_cursor: "14540000435w8hj8pXXwPQJJch.X9DBH8ya2Xenok55",
      }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    const result = await client.listCompletedByCompletionDate({
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-25T00:00:00Z",
    });

    expect(result.items).toEqual([
      {
        id: "6XGgmFVcrG5RRjVr",
        content: "Tomato Soup",
        description: "mp:rid=note-1",
        project_id: "6XGgm6PHrGgMpCFX",
        due_date: "2026-08-02",
        completed_at: null,
      },
    ]);
    expect(result.nextCursor).toBe(
      "14540000435w8hj8pXXwPQJJch.X9DBH8ya2Xenok55",
    );
  });

  it("defaults nextCursor to null and items to [] when the response omits them", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    const result = await client.listCompletedByCompletionDate({
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-25T00:00:00Z",
    });

    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it("throws TodoistApiError when since/until are rejected by the API", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: "Required argument is missing",
        error_tag: "ARGUMENT_MISSING",
      }),
    );
    const client = new TodoistClient({ apiToken: "test-token", fetchImpl });

    await expect(
      client.listCompletedByCompletionDate({ since: "", until: "" }),
    ).rejects.toMatchObject({ status: 400, errorTag: "ARGUMENT_MISSING" });
  });
});

describe("TodoistClient timeout", () => {
  it("aborts the request once timeoutMs elapses", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<FetchResponseLike>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const client = new TodoistClient({
      apiToken: "test-token",
      fetchImpl,
      timeoutMs: 10,
    });

    await expect(
      client.createTask({ project_id: "p1", content: "x" }),
    ).rejects.toThrow(/aborted/i);
  });
});
