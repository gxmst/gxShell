/** xterm accepts line heights only in this range. Keep the same contract for
 * settings loaded from older or hand-edited configuration files. */
export const DEFAULT_LINE_HEIGHT = 1.25;
export const MIN_LINE_HEIGHT = 1;
export const MAX_LINE_HEIGHT = 2.5;
export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 30;
export const DEFAULT_SCROLLBACK_LINES = 5000;
export const MIN_SCROLLBACK_LINES = 500;
export const MAX_SCROLLBACK_LINES = 200000;

export function normalizeLineHeight(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_LINE_HEIGHT || parsed > MAX_LINE_HEIGHT) {
    return DEFAULT_LINE_HEIGHT;
  }
  return parsed;
}

export function normalizeFontSize(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_FONT_SIZE || parsed > MAX_FONT_SIZE) {
    return DEFAULT_FONT_SIZE;
  }
  return parsed;
}

export function normalizeScrollbackLines(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_SCROLLBACK_LINES || parsed > MAX_SCROLLBACK_LINES) {
    return DEFAULT_SCROLLBACK_LINES;
  }
  return parsed;
}
