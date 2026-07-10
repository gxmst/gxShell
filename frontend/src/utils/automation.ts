import type { AutomationActivityEvent } from "../types";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const SOURCE_COLORS = {
  ai: "\x1b[38;5;45m",
  cli: "\x1b[38;5;141m",
} as const;

function safeLabel(value: string) {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g, "").trim();
}

function terminalNewlines(value: string) {
  return value.replace(/\r?\n/g, "\r\n");
}

function durationLabel(durationMs = 0) {
  if (durationMs <= 0) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

export function formatAutomationTerminalEvent(event: AutomationActivityEvent) {
  const source = event.source === "cli" ? "CLI" : "AI";
  const color = SOURCE_COLORS[event.source] || SOURCE_COLORS.ai;
  const tool = safeLabel(event.tool || "operation").replace(/_/g, " ");

  if (event.phase === "started") {
    const command = terminalNewlines(safeLabel(event.command || ""));
    return [
      "\r\n",
      `${color}\x1b[1m[${source}]${RESET} ${DIM}${tool}${RESET}\r\n`,
      command ? `${color}❯${RESET} ${command}\r\n` : "",
    ].join("");
  }

  const output = event.output ? terminalNewlines(event.output) : "";
  const needsBreak = output && !output.endsWith("\r\n") ? "\r\n" : "";
  const duration = durationLabel(event.durationMs);
  const suffix = duration ? ` · ${duration}` : "";
  if (event.phase === "failed") {
    const error = safeLabel(event.error || (event.exitCode ? `exit ${event.exitCode}` : "failed"));
    return `${output}${needsBreak}\x1b[38;5;203m[${source} ×]${RESET} ${DIM}${error}${suffix}${RESET}\r\n`;
  }
  return `${output}${needsBreak}\x1b[38;5;84m[${source} ✓]${RESET}${DIM}${suffix}${RESET}\r\n`;
}
