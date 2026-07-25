import type {
  CreateTaskInput,
  ListCompletedInput,
  ListCompletedResult,
  TodoistTask,
  UpdateTaskInput,
} from "./schema.js";

/**
 * Thin fetch wrapper over the official Todoist REST/Sync v1 API (bd
 * meal-planner-iu7.1, ratified meal-planner-9kd, ADR-0006 D2/D3).
 *
 * Endpoints (verified 2026-07-25 against
 * https://developer.todoist.com/openapi.json, tag "Tasks" — exact operation
 * ids in parens):
 *  - `POST /api/v1/tasks` (create_task_api_v1_tasks_post) — create.
 *  - `POST /api/v1/tasks/{task_id}` (update_task_api_v1_tasks__task_id__post)
 *    — update-in-place (ADR-0006 D4 soft-commit re-commit).
 *  - `GET /api/v1/tasks/completed/by_completion_date`
 *    (tasks_completed_by_completion_date_...) — completed-task read for
 *    recency (§6.3), `since`/`until` REQUIRED RFC 3339 datetimes,
 *    cursor-paginated.
 *
 * Auth: personal API token, `Authorization: Bearer <token>` (no OAuth —
 * ratified 9kd rejected the OAuth-only official MCP for this headless
 * launchd daemon).
 *
 * DI style mirrors `weather/weather.ts`: an injectable fetch implementation
 * (production defaults to the global `fetch`) so tests never make a live
 * network call, plus an AbortController-bounded timeout so a hung request
 * can't stall a caller indefinitely. Unlike weather's SILENT degrade, a
 * Todoist call is a real write (or the recency read it depends on) — any
 * failure here THROWS a `TodoistApiError`/`Error` rather than degrading to a
 * default; the caller decides how to handle it.
 */

const TODOIST_API_BASE = "https://api.todoist.com/api/v1";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Minimal shape this module needs from a fetch `Response` (real or stubbed). */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** Injectable fetch signature — production defaults to the global `fetch`. */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<FetchResponseLike>;

/** Thrown for any non-2xx Todoist API response. Never carries the API token. */
export class TodoistApiError extends Error {
  readonly status: number;
  readonly errorTag?: string;

  constructor(message: string, status: number, errorTag?: string) {
    super(message);
    this.name = "TodoistApiError";
    this.status = status;
    this.errorTag = errorTag;
  }
}

export interface TodoistClientOptions {
  /** Todoist personal API token (never logged; carried only in the Authorization header). */
  apiToken: string;
  /** Injected so tests never make a live Todoist call; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Override for tests; defaults to the real Todoist API base URL. */
  baseUrl?: string;
  /** Abort deadline for each call, ms. Default 10s. */
  timeoutMs?: number;
}

interface TodoistErrorBody {
  error?: unknown;
  error_tag?: unknown;
}

interface RawDue {
  date?: unknown;
}

/** The subset of Todoist's `ItemSyncView` (create/update/completed-list responses) this server carries through. */
interface RawItem {
  id: unknown;
  content: unknown;
  description?: unknown;
  project_id: unknown;
  due?: RawDue | null;
  completed_at?: unknown;
}

interface RawCompletedListResponse {
  items?: RawItem[];
  next_cursor?: unknown;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const { error } = body as TodoistErrorBody;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
  }
  return `Todoist API returned HTTP ${status}`;
}

function extractErrorTag(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const { error_tag: errorTag } = body as TodoistErrorBody;
    if (typeof errorTag === "string" && errorTag.length > 0) {
      return errorTag;
    }
  }
  return undefined;
}

function toTodoistTask(raw: RawItem): TodoistTask {
  return {
    id: String(raw.id),
    content: String(raw.content),
    description: typeof raw.description === "string" ? raw.description : "",
    project_id: String(raw.project_id),
    due_date: raw.due && typeof raw.due.date === "string" ? raw.due.date : null,
    completed_at:
      typeof raw.completed_at === "string" ? raw.completed_at : null,
  };
}

export class TodoistClient {
  private readonly apiToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: TodoistClientOptions) {
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.baseUrl = options.baseUrl ?? TODOIST_API_BASE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new TodoistApiError(
          extractErrorMessage(json, response.status),
          response.status,
          extractErrorTag(json),
        );
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** `POST /api/v1/tasks` — creates a task, returning its Todoist-assigned id (ADR-0006 D3). */
  async createTask(input: CreateTaskInput): Promise<TodoistTask> {
    const body = await this.request("/tasks", {
      method: "POST",
      body: {
        project_id: input.project_id,
        content: input.content,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.due_date !== undefined ? { due_date: input.due_date } : {}),
      },
    });
    return toTodoistTask(body as RawItem);
  }

  /** `POST /api/v1/tasks/{task_id}` — updates a task in place (ADR-0006 D4 soft-commit re-commit). */
  async updateTask(input: UpdateTaskInput): Promise<TodoistTask> {
    const body = await this.request(`/tasks/${input.task_id}`, {
      method: "POST",
      body: {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.due_date !== undefined ? { due_date: input.due_date } : {}),
      },
    });
    return toTodoistTask(body as RawItem);
  }

  /** `GET /api/v1/tasks/completed/by_completion_date` — completed-task read for recency (§6.3). */
  async listCompletedByCompletionDate(
    input: ListCompletedInput,
  ): Promise<ListCompletedResult> {
    const params = new URLSearchParams({
      since: input.since,
      until: input.until,
    });
    if (input.project_id !== undefined) {
      params.set("project_id", input.project_id);
    }
    if (input.cursor !== undefined) {
      params.set("cursor", input.cursor);
    }
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    const body = (await this.request(
      `/tasks/completed/by_completion_date?${params.toString()}`,
      { method: "GET" },
    )) as RawCompletedListResponse;
    return {
      items: (body.items ?? []).map(toTodoistTask),
      nextCursor:
        typeof body.next_cursor === "string" ? body.next_cursor : null,
    };
  }
}
