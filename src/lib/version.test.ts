import { describe, expect, it } from "vitest";
import { getScaffoldVersion } from "./version.js";

describe("getScaffoldVersion", () => {
  it("returns the scaffold version string", () => {
    expect(getScaffoldVersion()).toBe("0.0.0");
  });
});
