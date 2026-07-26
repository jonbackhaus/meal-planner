import type { SocketModeClient } from "@slack/socket-mode";
import { describe, expect, it, vi } from "vitest";
import { openSocketModeConnection } from "./socket-connection.js";

/** A minimal fake standing in for `SocketModeClient` -- only `start`/`disconnect` are called by this module. */
function fakeClient(overrides: Partial<SocketModeClient> = {}) {
  return {
    start: vi.fn(async () => ({})),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  } as unknown as SocketModeClient;
}

describe("openSocketModeConnection", () => {
  it("starts the injected client and returns a handle exposing it (the attach seam for the inbound event router)", async () => {
    const client = fakeClient();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const handle = await openSocketModeConnection({
      appToken: "xapp-fake",
      client,
      logger,
    });

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(handle.client).toBe(client);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("connection opened"),
    );
  });

  it("disconnect() calls the underlying client's disconnect()", async () => {
    const client = fakeClient();
    const handle = await openSocketModeConnection({
      appToken: "xapp-fake",
      client,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handle.disconnect();

    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("propagates a rejection from client.start() (no swallowing -- the caller decides how to handle a failed boot-time connection)", async () => {
    const client = fakeClient({
      start: vi.fn(async () => {
        throw new Error("apps.connections.open failed: invalid_auth");
      }),
    });

    await expect(
      openSocketModeConnection({ appToken: "xapp-fake", client }),
    ).rejects.toThrow(/invalid_auth/);
  });
});
