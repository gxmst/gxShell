export type TerminalPasteRisk = {
  characters: number;
  lines: number;
  preview: string;
  reason: "multiline" | "large";
};

export function terminalPasteTargets(sessionId: string, broadcast?: { enabled: boolean; targets: string[] }): string[] {
  const broadcastActive = broadcast?.enabled && broadcast.targets.includes(sessionId);
  const targets = broadcastActive ? [sessionId, ...broadcast.targets] : [sessionId];
  return Array.from(new Set(targets.filter(Boolean)));
}

export function sameTerminalPasteTargets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

const MAX_PREVIEW_CHARACTERS = 1200;
const LARGE_PASTE_CHARACTERS = 1000;

export function analyzeTerminalPaste(text: string, alternateScreen = false): TerminalPasteRisk | null {
  if (!text || alternateScreen) return null;
  const normalized = text.replace(/\r\n?/g, "\n");
  // Count the lines that actually carry a command. Selecting one whole line
  // in a browser or a document almost always includes its trailing newline,
  // and blank separator lines do not run anything either: treating those as
  // "multiple commands" would put a confirmation in front of the single most
  // common paste there is.
  const commandLines = normalized.split("\n").filter((line) => line.trim().length > 0);
  const hasMultipleCommands = commandLines.length > 1;
  if (!hasMultipleCommands && normalized.length <= LARGE_PASTE_CHARACTERS) return null;

  const clipped = normalized.slice(0, MAX_PREVIEW_CHARACTERS);
  return {
    characters: normalized.length,
    lines: commandLines.length || 1,
    preview: clipped + (clipped.length < normalized.length ? "\n..." : ""),
    reason: hasMultipleCommands ? "multiline" : "large",
  };
}
