// Line-ending fidelity for the document editor.
//
// A `<textarea>` normalizes its value to LF per the HTML spec, so a CRLF file
// loaded into the editor comes back out as LF and saving it silently rewrites
// every line ending in the file. The editor therefore keeps its draft in LF
// (the only form the DOM will give us) and remembers the file's original
// ending, re-applying it on the way back to disk.

export type Eol = 'crlf' | 'lf';

/**
 * The dominant line ending in `text`. CRLF wins on a tie because a file with
 * mixed endings on Windows is almost always a CRLF file that picked up a few
 * LF-only lines, and normalizing toward CRLF is the less surprising repair.
 * Lone CR (classic Mac) is not detected: it does not survive a textarea either
 * way, and treating it as a third case would promise fidelity we cannot keep.
 */
export function detectEol(text: string, fallback: Eol = 'lf'): Eol {
  const crlf = (text.match(/\r\n/g) || []).length;
  if (crlf === 0) {
    // No CRLF at all: LF if there are any newlines, otherwise undecidable and
    // the caller's platform default applies.
    return text.includes('\n') ? 'lf' : fallback;
  }
  const total = (text.match(/\n/g) || []).length;
  return crlf * 2 >= total ? 'crlf' : 'lf';
}

/** Collapse CRLF and lone CR to LF — the form the editor works in. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Re-apply `eol` to an LF-normalized string. */
export function applyEol(text: string, eol: Eol): string {
  const lf = toLf(text);
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

export function eolLabel(eol: Eol): string {
  return eol === 'crlf' ? 'CRLF' : 'LF';
}
