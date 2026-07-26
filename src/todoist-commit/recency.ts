import { parseTodoistRidMarker } from "../config/profile.js";
import type { TodoistClient } from "../todoist-mcp/todoist-client.js";

/**
 * Recency read (bd meal-planner-v9v.1, ADR-0006 D2, SPEC §6.3): reads
 * Todoist COMPLETED tasks over a lookback window and resolves each one back
 * to an exact `recipe_id` via the `mp:rid=` marker (bd c47 ratified
 * "completed = signal" — recency reads completed, not scheduled, tasks).
 *
 * This is the READ + PARSE step only. It does not feed `exclude_ids`
 * (v9v.2), does not compute the §6.3 semantic penalty, and is not wired into
 * plan generation (those are the next issues' seams) — it is a pure,
 * injectable-client unit that a future caller composes.
 *
 * A task whose description has no `mp:rid=` marker (a hand-created or
 * pre-marker task) simply does not resolve and is SKIPPED — fail-safe per
 * ADR-0006 D2, not an error.
 *
 * Only the subset of `TodoistClient` this module needs, mirroring
 * `commit.ts`'s `TodoistTaskCreator` / `recommit.ts`'s
 * `TodoistTaskCreatorUpdater` narrowing convention so tests can inject a
 * plain mock.
 */
export type TodoistCompletedTaskReader = Pick<
  TodoistClient,
  "listCompletedByCompletionDate"
>;

/** Default recency lookback window, weeks. Not yet config-driven — no caller
 * consumes this module (v3.x wiring is a later issue), so a fixed default
 * avoids adding config plumbing ahead of a consumer; callers may override via
 * {@link ReadRecentRecipeIdsOptions.lookbackWeeks}. */
export const DEFAULT_RECENCY_LOOKBACK_WEEKS = 8;

export interface ReadRecentRecipeIdsOptions {
  /** Injectable clock for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** How many weeks back (from `now`) to read completed tasks. Default {@link DEFAULT_RECENCY_LOOKBACK_WEEKS}. */
  lookbackWeeks?: number;
  /** Optional Todoist project id to scope the completed-task read. */
  projectId?: string;
}

/** One resolved recipe id, with its (first-seen) completion timestamp. */
export interface ResolvedRecentRecipe {
  recipeId: string;
  completedAt: string | null;
}

export interface RecentRecipeIds {
  /** Deduped, resolved recipe ids — the core deliverable D2 consumes as `exclude_ids`. */
  recipeIds: string[];
  /** Same ids with their completion timestamp, cheap to carry alongside. */
  recipes: ResolvedRecentRecipe[];
}

/**
 * Reads Todoist COMPLETED tasks over the recency window and resolves each to
 * an exact `recipe_id` via {@link parseTodoistRidMarker}. Unmarked tasks are
 * skipped. Ids are deduped (first completion observed wins). Paginates via
 * the client's `nextCursor` until exhausted. Returns an empty result when
 * there are no completed tasks (or none resolve).
 */
export async function readRecentRecipeIds(
  client: TodoistCompletedTaskReader,
  options: ReadRecentRecipeIdsOptions = {},
): Promise<RecentRecipeIds> {
  const now = options.now ?? (() => new Date());
  const lookbackWeeks = options.lookbackWeeks ?? DEFAULT_RECENCY_LOOKBACK_WEEKS;

  const until = now();
  const since = new Date(
    until.getTime() - lookbackWeeks * 7 * 24 * 60 * 60 * 1000,
  );

  const resolved = new Map<string, string | null>();
  let cursor: string | undefined;
  do {
    const page = await client.listCompletedByCompletionDate({
      since: since.toISOString(),
      until: until.toISOString(),
      ...(options.projectId !== undefined
        ? { project_id: options.projectId }
        : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });

    for (const task of page.items) {
      const recipeId = parseTodoistRidMarker(task.description);
      if (recipeId === undefined) {
        continue;
      }
      if (!resolved.has(recipeId)) {
        resolved.set(recipeId, task.completed_at);
      }
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return {
    recipeIds: [...resolved.keys()],
    recipes: [...resolved.entries()].map(([recipeId, completedAt]) => ({
      recipeId,
      completedAt,
    })),
  };
}
