import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPaletteMru,
  parsePaletteQuery,
  rememberPaletteResult,
  searchPaletteResults,
} from "./paletteSearch";

const action = () => undefined;
const result = (type: string, title: string, extra: Record<string, unknown> = {}) => ({ type, title, action, ...extra });

// searchPaletteResults reads the MRU straight from window.localStorage, which is
// not writable in this test environment. Back it with a map so the MRU
// assertions below exercise the ranking instead of falling through to the
// alphabetical tiebreak.
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

afterEach(() => {
  clearPaletteMru(window.localStorage);
  vi.unstubAllGlobals();
});

describe("paletteSearch", () => {
  it("parses Oxide-style mode prefixes", () => {
    expect(parsePaletteQuery("  > restart")).toEqual({ mode: "commands", query: "restart" });
    expect(parsePaletteQuery("@ prod ")).toEqual({ mode: "sessions", query: "prod " });
    expect(parsePaletteQuery("# web")).toEqual({ mode: "connections", query: "web" });
    expect(parsePaletteQuery("plain")).toEqual({ mode: "all", query: "plain" });
  });

  it("filters by mode and ranks title matches above fuzzy matches", () => {
    const matches = searchPaletteResults([
      result("server", "production-web"),
      result("command", "Restart service"),
      result("command", "Rebuild workspace"),
    ], "> restart");
    expect(matches.map((match) => match.result.title)).toEqual(["Restart service"]);
    expect(matches[0].highlights.length).toBeGreaterThan(0);
  });

  it("supports unicode title highlighting without losing character positions", () => {
    const matches = searchPaletteResults([result("area", "打开设置")], "设置");
    expect(matches[0].highlights).toEqual([2, 3]);
  });

  it("finds a subsequence match that a substring filter would drop", () => {
    const matches = searchPaletteResults([
      result("command", "Docker prune", { keywords: "docker system prune 容器" }),
      result("command", "Restart nginx"),
    ], "dkr");
    expect(matches.map((match) => match.result.title)).toEqual(["Docker prune"]);
  });

  it("keeps the caller's suggestion order when there is no query", () => {
    const matches = searchPaletteResults([
      result("server", "zulu"),
      result("server", "alpha"),
    ], "");
    expect(matches.map((match) => match.result.title)).toEqual(["zulu", "alpha"]);
  });

  it("remembers and prioritizes recently used results when the query is empty", () => {
    const storage = window.localStorage;
    const first = result("server", "first", { mruKey: "first" });
    const second = result("server", "second", { mruKey: "second" });
    rememberPaletteResult(second, storage);
    rememberPaletteResult(first, storage);
    expect(searchPaletteResults([second, first], "").map((match) => match.result.title)).toEqual(["first", "second"]);
  });
});

