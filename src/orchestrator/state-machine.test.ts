import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  IllegalTransitionError,
  transition,
} from "./state-machine.js";

function makeStore() {
  return new SessionStore({ path: ":memory:" });
}

let store: SessionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("ALLOWED_TRANSITIONS", () => {
  it("encodes the ADR 0002 state machine table", () => {
    expect(ALLOWED_TRANSITIONS.generating).toEqual(
      expect.arrayContaining(["suggested", "failed"]),
    );
    expect(ALLOWED_TRANSITIONS.generating).toHaveLength(2);

    expect(ALLOWED_TRANSITIONS.suggested).toEqual(
      expect.arrayContaining(["under_revision", "committed", "expired"]),
    );
    expect(ALLOWED_TRANSITIONS.suggested).toHaveLength(3);

    expect(ALLOWED_TRANSITIONS.under_revision).toEqual(
      expect.arrayContaining(["committed", "expired"]),
    );
    expect(ALLOWED_TRANSITIONS.under_revision).toHaveLength(2);

    // v3.0 soft-commit self-loop.
    expect(ALLOWED_TRANSITIONS.committed).toEqual(["committed"]);

    // Terminal states (other than committed's self-loop): no outgoing edges.
    expect(ALLOWED_TRANSITIONS.failed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.expired).toEqual([]);
  });
});

describe("canTransition", () => {
  it("returns true for allowed edges", () => {
    expect(canTransition("generating", "suggested")).toBe(true);
    expect(canTransition("generating", "failed")).toBe(true);
    expect(canTransition("suggested", "expired")).toBe(true);
    expect(canTransition("committed", "committed")).toBe(true);
  });

  it("returns false for disallowed edges", () => {
    expect(canTransition("committed", "generating")).toBe(false);
    expect(canTransition("failed", "suggested")).toBe(false);
    expect(canTransition("expired", "generating")).toBe(false);
    expect(canTransition("generating", "under_revision")).toBe(false);
  });
});

describe("transition", () => {
  it("applies an allowed transition, patching status + updated_at + extra fields", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "generating",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    transition(
      store,
      "2026-07-12",
      "suggested",
      { thread_ts: "1234.5678", working_plan: { meals: [] } },
      "2026-07-12T06:01:00.000Z",
    );

    const row = store.get("2026-07-12");
    expect(row?.status).toBe("suggested");
    expect(row?.thread_ts).toBe("1234.5678");
    expect(row?.working_plan).toEqual({ meals: [] });
    expect(row?.updated_at).toBe("2026-07-12T06:01:00.000Z");
  });

  it("throws IllegalTransitionError for a disallowed edge and does not mutate the row", () => {
    store = makeStore();
    store.insert({
      week_key: "2026-07-12",
      status: "committed",
      created_at: "2026-07-12T06:00:00.000Z",
      updated_at: "2026-07-12T06:00:00.000Z",
    });

    expect(() =>
      transition(
        store as SessionStore,
        "2026-07-12",
        "generating",
        {},
        "2026-07-12T06:05:00.000Z",
      ),
    ).toThrow(IllegalTransitionError);

    const row = store.get("2026-07-12");
    expect(row?.status).toBe("committed");
    expect(row?.updated_at).toBe("2026-07-12T06:00:00.000Z");
  });

  it("throws IllegalTransitionError when the week_key has no row", () => {
    store = makeStore();
    expect(() =>
      transition(
        store as SessionStore,
        "2026-99-99",
        "suggested",
        {},
        "2026-07-12T06:05:00.000Z",
      ),
    ).toThrow(IllegalTransitionError);
  });
});
