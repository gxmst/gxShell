import { describe, expect, it } from "vitest";
import { splitTerminalInput, terminalCompatibilityKey } from "./terminalInput";

describe("physical terminal keys", () => {
  it("leaves composition, modifiers and non-keyboard input alone", () => {
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      for (const key of ["Backspace", "Delete"]) expect(terminalCompatibilityKey(new KeyboardEvent("keydown", { key, ...init }))).toBeNull();
    }
    expect(terminalCompatibilityKey(new KeyboardEvent("keyup", { key: "Backspace" }))).toBeNull();
    expect(terminalCompatibilityKey(new KeyboardEvent("keydown", { key: "c" }))).toBeNull();
  });
});

describe("terminal bridge input chunks", () => {
  it("keeps supplementary characters valid in every independently encoded message", () => {
    const input = "x".repeat(65535) + "😀" + "中".repeat(65533) + "𠀀" + "\r";
    const chunks = [...splitTerminalInput(input)];
    expect(chunks.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(chunks.map((part) => decoder.decode(encoder.encode(part))).join("")).toBe(input);
    expect(chunks.every((part) => part.length <= 65536)).toBe(true);
  });
});
