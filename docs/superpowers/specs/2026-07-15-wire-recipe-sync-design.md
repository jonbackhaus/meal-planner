# Design — Wire recipe sync into the daemon (`meal-planner-q95.8`)

## Problem

`syncNotes` (`src/recipe-mcp/sync.ts`) has no non-test caller. The daemon's
trigger path (`composeDaemon` → `buildPlanFor` → `composePools`/`search`) queries
the vector store directly and never syncs from Apple Notes first. On a fresh
machine the recipe index (`./data/*.sqlite`) is empty, so the planner has nothing
to select from. SPEC's weekly flow requires "sync recipes via Recipe MCP →
generate plan."

Everything `SyncDeps` needs already exists and is already constructed in
`main()`: `readNotes` (notes-reader), `TransformersEmbedder`, `VectorStore`
(satisfies `SyncStore`), `StructuredStore` (satisfies `SyncStructuredStore`), and
a metered, cost-capped `llm`.

## Decisions (ratified with user)

1. **Both entrypoints** — auto-sync in the weekly generation path AND a standalone
   `pnpm sync` command for initial corpus load / manual refresh.
2. **Proceed + alert** on a whole-sync failure in the weekly path — a slightly
   stale plan beats skipping the week.

## Design

### 1. Shared sync assembly — `src/recipe-mcp/sync-runner.ts`

A thin factory that runs one `syncNotes` pass from already-constructed
collaborators, so the daemon and the CLI share one wiring point:

```ts
export interface RunSyncDeps {
  readNotes: (opts?: { folderName?: string }) => Promise<RawNote[]>;
  embedder: Embedder;
  vectorStore: SyncStore;
  structuredStore: SyncStructuredStore;
  llm: LlmClient;
}
export interface RunSyncOptions { folderName?: string }

export function runSync(deps: RunSyncDeps, opts?: RunSyncOptions): Promise<SyncResult>;
```

- Binds `readNotes` with `opts.folderName` and calls `syncNotes({...})`.
- New optional env var `MP_RECIPES_FOLDER` (default `"Recipes"`, matching
  `notes-reader`'s `DEFAULT_RECIPES_FOLDER`) is resolved by the *callers* and
  passed in as `folderName` — `sync-runner` itself stays env-free and unit-testable.

### 2. Auto-sync in the generation path — `src/index.ts`

`buildPlanFor(weekKey)` gains a sync step *before* `buildPlan`:

```ts
const buildPlanFor = (weekKey: string) => async () => {   // (illustrative)
  try {
    const r = await runSync({ readNotes, embedder, vectorStore, structuredStore, llm },
                            { folderName });
    console.log(`[sync] total=${r.total} processed=${r.processed} skipped=${r.skipped} extractionFailures=${r.extractionFailures}`);
  } catch (e) {
    console.warn(`recipe sync failed before generating week ${weekKey}: ${String(e)}`);
    await alert(`recipe sync failed before generating week ${weekKey}: ${String(e)}`);
    // proceed: plan against the existing (possibly stale) index
  }
  return buildPlan({ ... });   // unchanged
};
```

- `buildPlanFor` is only ever called from inside `generateForWeek` (via the
  injected `buildPlan` dep), so sync runs exactly once per *real* generation —
  after the idempotency gate has passed and the `generating` row is written. A
  double-fire / restart that hits the gate never syncs.
- **No changes to `generate.ts` or `compose.ts`.** The sync lives entirely in the
  `index.ts` composition closure.
- **Proceed + alert**: a whole-sync failure alerts (via the `alert` closure
  already built in `main()`) but does not abort. If the index is empty,
  `composePools` yields empty pools → `selectValidatedPlan` fails validation →
  `generateForWeek` marks the week `failed` and alerts (existing path). So an
  empty-index run still fails loudly; a stale-but-populated index still plans.
- Uses the **same metered, cost-capped `llm`** the planner uses. Extraction spend
  counts against the run and its `$` cap; extraction is hash-gated → ~$0 steady
  state.
- `alert` must be constructed before `buildPlanFor` in `main()` (today it's built
  a few lines later) — reorder so the closure can capture it.

### 3. Standalone `pnpm sync` — `src/sync-cli.ts`

A thin entry mirroring `main()`'s boot shape:

```ts
export async function runSyncCli(deps): Promise<SyncResult>  // testable core
async function main(): Promise<void>                          // boot wrapper
```

- Boot: `loadConfig()` (for the metered `llm`: model + rates + cap), `loadSecrets()`
  with the same 15s timeout, `applySecretsToEnv(secrets)`.
- Construct `VectorStore`, `StructuredStore`, `TransformersEmbedder`, and a metered
  `llm` (`meteredLlmClient(createLlmClient(config), meter, { capUsd: config.generationDollarCap })`).
- Call `runSync(...)`, print the `SyncResult` and total token/$ spend from the
  meter, exit `0`; on error print + exit `1`.
- Writes to the **same** recipe index files the daemon reads (default
  `VectorStore`/`StructuredStore` paths — the recipe corpus is not profile-split
  like the session DB, so no dev/prod divergence here).
- `package.json`: add `"sync": "tsx src/sync-cli.ts"` (dev) — build path is
  `node dist/sync-cli.js`.

## Testing

- `sync-runner.test.ts` — deps wired to `syncNotes` correctly; `folderName`
  passthrough to `readNotes`; returns the `SyncResult` unchanged. Fakes for all
  edges.
- `index.test.ts` (or a focused `build-plan-for` unit) — the sync-failure branch:
  `runSync` throws → `alert` called with a week-scoped message, `buildPlan` still
  runs; happy path → sync summary logged, `buildPlan` runs. Injected fakes.
- `sync-cli.test.ts` — `runSyncCli` core calls `runSync` and surfaces the
  `SyncResult` + spend; error path returns non-zero. Keep the `main()` boot wrapper
  thin (same pattern as `index.ts`).

## Out of scope (YAGNI / tracked elsewhere)

- Retry/backoff on sync failure — that's `meal-planner-q95.7`.
- Scheduling the CLI (user runs it or crons it).
- Making the recipe-index path configurable / profile-split — corpus is shared.
