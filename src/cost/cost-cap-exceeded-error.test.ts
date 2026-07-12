import { describe, expect, it } from "vitest";
import { CostCapExceededError } from "./cost-cap-exceeded-error.js";

describe("CostCapExceededError", () => {
  it("names the cost and cap in its message", () => {
    const error = new CostCapExceededError(2.5, 2);
    expect(error.message).toBe("cost cap exceeded: $2.50 spent > $2.00 cap");
  });

  it("carries costUsd and capUsd as fields", () => {
    const error = new CostCapExceededError(2.5, 2);
    expect(error.costUsd).toBe(2.5);
    expect(error.capUsd).toBe(2);
  });

  it("is a real Error instance with a distinct name", () => {
    const error = new CostCapExceededError(2.5, 2);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CostCapExceededError");
  });

  it("never includes secret-shaped content -- only the two numbers", () => {
    const error = new CostCapExceededError(3.5, 2);
    expect(error.message).not.toMatch(/prompt|api[_-]?key|token(?!s)/i);
  });
});
