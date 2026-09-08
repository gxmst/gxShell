import { describe, it, expect } from "vitest";
import type { types } from "../../wailsjs/go/models";
import { findHighlightMatches, highlightRuleError } from "./highlight";

const rule = (pattern: string, patch: Partial<types.HighlightRule> = {}): types.HighlightRule => ({ id: "r1", pattern, mode: "regex", color: "#123456", enabled: true, caseSensitive: false, ...patch });

describe("custom terminal highlighting", () => {
  it("matches UTF-16 cell offsets and gives the first user rule priority", () => {
    expect(findHighlightMatches("😀中文 ERROR", "full", [rule("中文"), rule("ERROR", { color: "#abcdef" })])).toEqual([{ start: 2, end: 4, color: "#123456" }, { start: 5, end: 10, color: "#abcdef" }]);
  });
  it("treats literal patterns as text and applies case sensitivity", () => {
    expect(findHighlightMatches("[OK] [ok]", "off", [rule("[OK]", { mode: "literal", caseSensitive: true })])).toEqual([{ start: 0, end: 4, color: "#123456" }]);
  });
  it("ignores malformed, disabled and empty matches without crashing", () => {
    expect(highlightRuleError(rule("["))).not.toBe("");
    expect(findHighlightMatches("ERROR", "off", [rule("["), rule("ERROR", { enabled: false }), rule("a*")])).toEqual([]);
  });
  it("bounds dense matches and handles nested repetition on long input", () => {
    expect(findHighlightMatches("a".repeat(8000)+"!", "off", [rule("(a+)+$")])).toEqual([]);
    expect(findHighlightMatches("x".repeat(8000), "off", [rule("x")])).toHaveLength(128);
  });
});
