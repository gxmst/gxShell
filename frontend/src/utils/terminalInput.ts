import type { types } from "../../wailsjs/go/models";

export type TerminalCompatibilityKey = "Backspace" | "Delete";

export function terminalCompatibilityKey(event: KeyboardEvent): TerminalCompatibilityKey | null {
  if (event.type !== "keydown" || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  return event.key === "Backspace" || event.key === "Delete" ? event.key : null;
}

export function terminalKeyData(key: TerminalCompatibilityKey, settings?: types.TerminalSettings): string {
  if (key === "Backspace") return settings?.backspaceKey === "ctrl-h" ? "\x08" : "\x7f";
  if (settings?.deleteKey === "ctrl-h") return "\x08";
  return settings?.deleteKey === "del" ? "\x7f" : "\x1b[3~";
}

// Bridge messages stay well below the backend's 1 MiB input queue, with no
// surrogate pair split between JSON messages (which would become two U+FFFDs).
export function* splitTerminalInput(value: string): Generator<string> {
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + 64 * 1024);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    yield value.slice(offset, end);
    offset = end;
  }
}
