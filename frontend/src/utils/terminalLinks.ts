import type { IBufferLine, IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

// Terminal link providers detect URLs and remote file paths in the rendered
// buffer and make them clickable. This lives in the xterm display layer via
// registerLinkProvider, so it never rewrites the SSH output stream — matching
// the project rule that highlighting must not corrupt vim/top/tmux output.

export type TerminalLinkHandlers = {
  openUrl: (url: string) => void;
  openPath: (path: string) => void;
};

// App-level handlers carry the owning session id so the click can target the
// right SSH session (e.g. open its SFTP panel at the clicked path).
export type TerminalLinkAppHandlers = {
  openUrl: (url: string) => void;
  openPath: (sessionId: string, path: string) => void;
};

// URLs: http/https only. Trailing punctuation that is commonly adjacent to a
// URL in prose (closing brackets, quotes, sentence punctuation) is trimmed off.
const urlRe = /https?:\/\/[^\s"'`<>()[\]{}]+/g;

// Absolute unix paths with at least one more segment, e.g. /etc/nginx/nginx.conf
// or /var/log/syslog. Requires a leading slash and a second slash so bare "/"
// and single-segment roots like "/tmp" alone are ignored (too noisy). Stops at
// whitespace and shell/quote punctuation.
const pathRe = /(?:^|[\s"'`(:=])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._+-]+)+\/?)/g;

const trimTrailing = (value: string): string => {
  // Drop trailing characters that are almost always sentence/markup noise
  // rather than part of the target.
  return value.replace(/[.,;:!?)\]}'"]+$/, "");
};

type Match = { start: number; end: number; value: string; kind: "url" | "path" };

function collectMatches(text: string): Match[] {
  const matches: Match[] = [];

  urlRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const value = trimTrailing(m[0]);
    if (!value) continue;
    matches.push({ start: m.index, end: m.index + value.length, value, kind: "url" });
  }

  pathRe.lastIndex = 0;
  while ((m = pathRe.exec(text)) !== null) {
    const raw = m[1];
    // m.index points at the leading boundary char (when present); offset to the
    // path itself so the clickable range lines up with the slash.
    const offset = m[0].length - raw.length;
    const start = m.index + offset;
    const end = start + raw.length;
    // Skip a path that overlaps an already-matched URL (e.g. the path portion of
    // a URL) so we do not register two links over the same cells.
    if (matches.some((x) => start < x.end && end > x.start)) continue;
    matches.push({ start, end, value: raw, kind: "path" });
  }

  return matches;
}

// Convert a 0-based offset within the logical (possibly wrapped) line into an
// xterm range. xterm rows/cols in ILink are 1-based and rows are viewport-
// relative to the line where provideLinks was invoked.
function toRange(startOffset: number, endOffset: number, cols: number, baseRow: number): IBufferRange {
  const startRow = Math.floor(startOffset / cols);
  const startCol = startOffset % cols;
  const endRow = Math.floor((endOffset - 1) / cols);
  const endCol = ((endOffset - 1) % cols) + 1;
  return {
    start: { x: startCol + 1, y: baseRow + startRow },
    end: { x: endCol + 1, y: baseRow + endRow },
  };
}

// Read the full logical line at bufferRow, following xterm's wrapped-line flag
// so a URL split across the terminal width is still matched as one string.
function readWrappedLine(term: Terminal, bufferRow: number): { text: string; firstRow: number } {
  const buffer = term.buffer.active;
  let first = bufferRow;
  // Walk back over continuation rows to find the logical line start.
  while (first > 0) {
    const line = buffer.getLine(first);
    if (line && line.isWrapped) {
      first -= 1;
    } else {
      break;
    }
  }
  let text = "";
  let row = first;
  // Concatenate this row and any wrapped continuation rows.
  while (true) {
    const line: IBufferLine | undefined = buffer.getLine(row);
    if (!line) break;
    text += line.translateToString(false);
    const next = buffer.getLine(row + 1);
    if (next && next.isWrapped) {
      row += 1;
    } else {
      break;
    }
  }
  return { text, firstRow: first };
}

export function createLinkProvider(term: Terminal, handlers: TerminalLinkHandlers, isEnabled?: () => boolean): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      // Read the toggle lazily so turning clickable links off in settings takes
      // effect immediately without re-registering the provider per terminal.
      if (isEnabled && !isEnabled()) {
        callback(undefined);
        return;
      }
      // bufferLineNumber is 1-based within the viewport.
      const buffer = term.buffer.active;
      const absoluteRow = buffer.viewportY + bufferLineNumber - 1;
      const line = buffer.getLine(absoluteRow);
      if (!line) {
        callback(undefined);
        return;
      }
      // Only build links from the logical start row to avoid duplicating work on
      // each wrapped continuation row.
      if (line.isWrapped) {
        callback(undefined);
        return;
      }

      const { text } = readWrappedLine(term, absoluteRow);
      const matches = collectMatches(text);
      if (!matches.length) {
        callback(undefined);
        return;
      }

      const cols = term.cols;
      // The viewport row (1-based) for the first buffer row of this logical line
      // is bufferLineNumber since we start at the non-wrapped row.
      const links: ILink[] = matches.map((match) => ({
        range: toRange(match.start, match.end, cols, bufferLineNumber),
        text: match.value,
        activate: (event: MouseEvent) => {
          event.preventDefault();
          if (match.kind === "url") handlers.openUrl(match.value);
          else handlers.openPath(match.value);
        },
      }));

      callback(links);
    },
  };
}
