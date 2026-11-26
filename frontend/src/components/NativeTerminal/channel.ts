import type { Tab } from "../../types";
import type { TerminalSnapshot, TerminalViewSettings } from "../../hooks/useTerminal";

export type ViewInfo = { title: string; state: Tab["state"]; settings: TerminalViewSettings };
export type TerminalMessage =
  | { kind: "ready"; client: string }
  | { kind: "screen"; snapshot: TerminalSnapshot; info: ViewInfo }
  | { kind: "info"; info: ViewInfo }
  | { kind: "output"; data: string }
  | { kind: "grid"; cols: number; rows: number };

export function terminalChannel(id: string) {
  return new BroadcastChannel("gx:terminal-window:" + id);
}
