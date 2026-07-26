import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withTimeout } from "../daemon/with-timeout.js";
import { loadSecrets } from "../secrets/secrets.js";
import { createTodoistMcpServer } from "./server.js";
import { TodoistClient } from "./todoist-client.js";

/**
 * Standalone entrypoint for the Todoist MCP server (bd meal-planner-iu7.1):
 * boots `TodoistClient` from the loaded secrets, wires it into
 * `createTodoistMcpServer`, and connects over stdio — spawnable as a
 * `StdioMcpServerSpec` (`llm/agent-sdk-client.ts`) `command`, e.g.
 * `node dist/todoist-mcp/index.js`. Wiring that spec into the harness/config
 * is a later Epic C issue (C1/C2); this binary only needs to run standalone.
 *
 * Boot logs go to stderr — stdout is reserved for the MCP JSON-RPC framing
 * once the stdio transport is connected.
 */

/** Same 15s boot secret-load timeout used by the daemon (`index.ts`) and `sync-cli.ts`. */
const SECRETS_LOAD_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const secrets = await withTimeout(loadSecrets(), {
    timeoutMs: SECRETS_LOAD_TIMEOUT_MS,
    message: `Timed out loading secrets after ${SECRETS_LOAD_TIMEOUT_MS}ms (the \`op\` CLI may be hung; check 1Password service account connectivity)`,
  });

  if (!secrets.todoistApiToken) {
    throw new Error(
      "todoist-mcp: no Todoist API token loaded (set MP_OP_TODOIST_TOKEN_REF or MP_TODOIST_API_TOKEN).",
    );
  }

  const todoistClient = new TodoistClient({
    apiToken: secrets.todoistApiToken,
  });
  const server = createTodoistMcpServer({ todoistClient });

  await server.connect(new StdioServerTransport());
  console.error("[todoist-mcp] connected over stdio");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
