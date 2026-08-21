import { describe, expect, it } from "vitest";
import { analyzeTerminalPaste, sameTerminalPasteTargets, terminalPasteTargets } from "./terminalPaste";

describe("analyzeTerminalPaste", () => {
  it("allows ordinary single-line terminal paste", () => {
    expect(analyzeTerminalPaste("echo hello")).toBeNull();
  });

  it("guards multiline and large shell paste", () => {
    expect(analyzeTerminalPaste("echo one\necho two")).toMatchObject({ reason: "multiline", lines: 2 });
    expect(analyzeTerminalPaste("x".repeat(1001))).toMatchObject({ reason: "large", characters: 1001 });
  });

  // Selecting a whole line in a browser or an editor includes its newline, so
  // treating a trailing newline as a second command put a confirmation in front
  // of the single most common paste there is.
  it("allows one command that carries a trailing newline", () => {
    expect(analyzeTerminalPaste("echo hello\n")).toBeNull();
    expect(analyzeTerminalPaste("ls -la\r\n")).toBeNull();
    expect(analyzeTerminalPaste("docker ps\n\n")).toBeNull();
    expect(analyzeTerminalPaste("\n  systemctl status nginx  \n")).toBeNull();
  });

  it("counts commands rather than raw lines", () => {
    expect(analyzeTerminalPaste("echo one\n\necho two\n")).toMatchObject({ reason: "multiline", lines: 2 });
  });

  it("does not interrupt paste inside an alternate-screen application", () => {
    expect(analyzeTerminalPaste("one\ntwo", true)).toBeNull();
  });

  it("freezes and compares exact broadcast targets", () => {
    expect(terminalPasteTargets("one", { enabled: true, targets: ["one", "two", "two"] })).toEqual(["one", "two"]);
    expect(terminalPasteTargets("local", { enabled: true, targets: ["one", "two"] })).toEqual(["local"]);
    expect(sameTerminalPasteTargets(["one", "two"], ["two", "one"])).toBe(true);
    expect(sameTerminalPasteTargets(["one", "two"], ["one", "three"])).toBe(false);
  });
});
