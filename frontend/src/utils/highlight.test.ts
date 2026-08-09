import { describe, expect, it } from "vitest";
import { findHighlightMatches } from "./highlight";

describe("findHighlightMatches", () => {
  it("returns display ranges without modifying terminal text", () => {
    const text = "service failed but retry succeeded";
    const matches = findHighlightMatches(text, "basic");

    expect(matches.map((item) => text.slice(item.start, item.end))).toEqual(["failed", "succeeded"]);
    expect(text).toBe("service failed but retry succeeded");
  });

  it("does not return overlapping ranges from multiple rules", () => {
    const text = "docker service is running";
    const matches = findHighlightMatches(text, "full");

    for (let index = 1; index < matches.length; index += 1) {
      expect(matches[index].start).toBeGreaterThanOrEqual(matches[index - 1].end);
    }
  });

  it("is disabled when highlighting is off", () => {
    expect(findHighlightMatches("fatal error", "off")).toEqual([]);
  });
});
