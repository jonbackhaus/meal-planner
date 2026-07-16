import { describe, expect, it } from "vitest";
import { normalizeTag, tagMetadata } from "./tag-metadata.js";

describe("normalizeTag", () => {
  it("strips the leading # and lowercases", () => {
    expect(normalizeTag("#Side")).toBe("side");
    expect(normalizeTag("#DINNER")).toBe("dinner");
  });

  it("folds the hyphen variants observed in the real corpus", () => {
    expect(normalizeTag("#doahead")).toBe("do-ahead");
    expect(normalizeTag("#do-ahead")).toBe("do-ahead");
    expect(normalizeTag("#5stars")).toBe("5-stars");
    expect(normalizeTag("#4stars")).toBe("4-stars");
    expect(normalizeTag("#5-stars")).toBe("5-stars");
  });

  it("drops empty and letterless/malformed tags", () => {
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("#")).toBeNull();
    expect(normalizeTag("#5-")).toBeNull();
    expect(normalizeTag("   ")).toBeNull();
  });
});

describe("tagMetadata", () => {
  it("flags #side and marks it not main-dinner-eligible", () => {
    const m = tagMetadata(["#side", "#summer", "#5stars"]);
    expect(m.is_side).toBe(true);
    expect(m.main_dinner_eligible).toBe(false);
  });

  it("keeps #dinner and untagged recipes main-dinner-eligible", () => {
    expect(tagMetadata(["#dinner", "#quick"]).main_dinner_eligible).toBe(true);
    expect(tagMetadata([]).main_dinner_eligible).toBe(true);
    expect(tagMetadata(["#lunch"]).main_dinner_eligible).toBe(true);
  });

  it("excludes dessert/breakfast/appetizer from dinners too", () => {
    expect(tagMetadata(["#dessert"]).main_dinner_eligible).toBe(false);
    expect(tagMetadata(["#breakfast"]).main_dinner_eligible).toBe(false);
    expect(tagMetadata(["#appetizer"]).main_dinner_eligible).toBe(false);
  });

  it("maps quality tags with 5>4>3>untested precedence", () => {
    expect(tagMetadata(["#5-stars"]).quality).toBe(5);
    expect(tagMetadata(["#4stars"]).quality).toBe(4);
    expect(tagMetadata(["#3-stars"]).quality).toBe(3);
    expect(tagMetadata(["#untested"]).quality).toBe("untested");
    expect(tagMetadata(["#3-stars", "#5-stars"]).quality).toBe(5);
    expect(tagMetadata(["#side"]).quality).toBeUndefined();
  });

  it("collects season and effort tags from the known sets only", () => {
    const m = tagMetadata(["#fall", "#winter", "#quick", "#do-ahead", "#kids"]);
    expect(m.season_tags.sort()).toEqual(["fall", "winter"]);
    expect(m.effort_tags.sort()).toEqual(["do-ahead", "quick"]);
  });

  it("treats #vegetarian/#vegan as a positive veg override (else undefined)", () => {
    expect(tagMetadata(["#vegetarian"]).veg_from_tags).toBe("vegetarian");
    expect(tagMetadata(["#vegan"]).veg_from_tags).toBe("vegetarian");
    expect(tagMetadata(["#dinner"]).veg_from_tags).toBeUndefined();
  });

  it("returns normalized, deduped tags", () => {
    const m = tagMetadata(["#Side", "#side", "#doahead", "#5-", ""]);
    expect(m.tags.sort()).toEqual(["do-ahead", "side"]);
  });
});
