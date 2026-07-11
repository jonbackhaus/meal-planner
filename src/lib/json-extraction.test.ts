import { describe, expect, it } from "vitest";
import { extractJsonObject } from "./json-extraction.js";

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("extracts JSON from a ```json fenced code block", () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```';
    expect(extractJsonObject(text)).toEqual({ a: 1 });
  });

  it("extracts JSON from an unlabeled fenced code block", () => {
    const text = '```\n{"a":1}\n```';
    expect(extractJsonObject(text)).toEqual({ a: 1 });
  });

  it("extracts JSON surrounded by prose with no fences", () => {
    const text = 'Sure thing! Here is the plan: {"a":1} Hope that helps.';
    expect(extractJsonObject(text)).toEqual({ a: 1 });
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractJsonObject("I cannot help with that.")).toThrow(
      "no JSON object found in LLM response",
    );
  });
});
