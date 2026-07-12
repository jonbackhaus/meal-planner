import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";

/**
 * Durable per-week session storage (ADR 0002 "Session schema"). This module
 * is storage + CRUD ONLY: it does not encode the state machine's allowed
 * transitions, week_key computation, generateForWeek, or startup catch-up
 * (those are later tasks layered on top of this store).
 *
 * Backed by `better-sqlite3`, matching the conventions in
 * src/recipe-mcp/vector-store.ts (open/migrate on construction, prepared
 * statements, `:memory:` for tests).
 *
 * Clock policy: this store NEVER calls `Date.now()` / `new Date()`. Every
 * timestamp (`created_at`, `updated_at`) is an ISO string supplied by the
 * caller (the daemon owns the clock). This keeps the store deterministic and
 * trivially testable, and keeps "what time is it" a single decision made by
 * the orchestrator rather than smeared across the storage layer.
 */

export const sessionStatusSchema = z.enum([
  "generating",
  "suggested",
  "under_revision",
  "committed",
  "failed",
  "expired",
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * The working plan is stored as opaque JSON TEXT in SQLite. We intentionally
 * type it as `unknown` here rather than importing the planner's
 * `EnrichedWeekPlan` type, to avoid coupling the storage layer to the
 * planner's shape — callers narrow/validate on read as needed.
 */
export type WorkingPlan = unknown;

export interface Session {
  week_key: string;
  status: SessionStatus;
  thread_ts: string | null;
  working_plan: WorkingPlan | null;
  turn_count: number;
  token_spend: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface InsertSessionRow {
  week_key: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  thread_ts?: string | null;
  working_plan?: WorkingPlan | null;
  turn_count?: number;
  token_spend?: number;
  cost_usd?: number;
}

export type SessionPatch = Partial<
  Pick<
    Session,
    | "status"
    | "thread_ts"
    | "working_plan"
    | "turn_count"
    | "token_spend"
    | "cost_usd"
    | "updated_at"
  >
>;

export interface SessionStoreOptions {
  /** Database file path. Use ":memory:" for an ephemeral store (tests). */
  path: string;
}

interface SessionRow {
  week_key: string;
  status: string;
  thread_ts: string | null;
  working_plan: string | null;
  turn_count: number;
  token_spend: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    week_key: row.week_key,
    status: sessionStatusSchema.parse(row.status),
    thread_ts: row.thread_ts,
    working_plan:
      row.working_plan === null ? null : JSON.parse(row.working_plan),
    turn_count: row.turn_count,
    token_spend: row.token_spend,
    cost_usd: row.cost_usd,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SessionStore {
  private readonly db: Database.Database;

  constructor(options: SessionStoreOptions) {
    const { path } = options;
    if (path !== ":memory:") {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        week_key     TEXT PRIMARY KEY,
        status       TEXT NOT NULL,
        thread_ts    TEXT,
        working_plan TEXT,
        turn_count   INTEGER NOT NULL DEFAULT 0,
        token_spend  INTEGER NOT NULL DEFAULT 0,
        cost_usd     REAL    NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_thread_ts ON session(thread_ts);
    `);
  }

  /**
   * Insert a new session row. Throws (SQLite primary-key constraint) if
   * `week_key` already exists — the idempotency GATE deciding whether to
   * insert at all belongs to a later task; this is just the primitive.
   */
  insert(row: InsertSessionRow): void {
    const workingPlan =
      row.working_plan === undefined || row.working_plan === null
        ? null
        : JSON.stringify(row.working_plan);

    this.db
      .prepare(
        `INSERT INTO session
          (week_key, status, thread_ts, working_plan, turn_count, token_spend, cost_usd, created_at, updated_at)
         VALUES (@week_key, @status, @thread_ts, @working_plan, @turn_count, @token_spend, @cost_usd, @created_at, @updated_at)`,
      )
      .run({
        week_key: row.week_key,
        status: row.status,
        thread_ts: row.thread_ts ?? null,
        working_plan: workingPlan,
        turn_count: row.turn_count ?? 0,
        token_spend: row.token_spend ?? 0,
        cost_usd: row.cost_usd ?? 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
  }

  get(week_key: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM session WHERE week_key = ?")
      .get(week_key) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /** Reverse lookup via idx_session_thread_ts (v3.0 listener scoping). */
  getByThreadTs(thread_ts: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM session WHERE thread_ts = ?")
      .get(thread_ts) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Updates mutable fields on an existing row. Serializes `working_plan` to JSON.
   * Only the keys present in `patch` are touched (partial `SET`) — omitted
   * fields are left untouched, never clobbered.
   *
   * Updating a non-existent `week_key` is a silent no-op (standard SQL
   * `UPDATE` semantics: zero rows match, zero rows change) — checking
   * existence before calling is the caller's concern (e.g. bd6.3's
   * write-before-post ordering).
   */
  update(week_key: string, patch: SessionPatch): void {
    const fields: string[] = [];
    const params: Record<string, unknown> = { week_key };

    if (patch.status !== undefined) {
      fields.push("status = @status");
      params.status = patch.status;
    }
    if (patch.thread_ts !== undefined) {
      fields.push("thread_ts = @thread_ts");
      params.thread_ts = patch.thread_ts;
    }
    if (patch.working_plan !== undefined) {
      fields.push("working_plan = @working_plan");
      params.working_plan =
        patch.working_plan === null ? null : JSON.stringify(patch.working_plan);
    }
    if (patch.turn_count !== undefined) {
      fields.push("turn_count = @turn_count");
      params.turn_count = patch.turn_count;
    }
    if (patch.token_spend !== undefined) {
      fields.push("token_spend = @token_spend");
      params.token_spend = patch.token_spend;
    }
    if (patch.cost_usd !== undefined) {
      fields.push("cost_usd = @cost_usd");
      params.cost_usd = patch.cost_usd;
    }
    if (patch.updated_at !== undefined) {
      fields.push("updated_at = @updated_at");
      params.updated_at = patch.updated_at;
    }

    if (fields.length === 0) {
      return;
    }

    this.db
      .prepare(
        `UPDATE session SET ${fields.join(", ")} WHERE week_key = @week_key`,
      )
      .run(params);
  }

  close(): void {
    this.db.close();
  }
}
