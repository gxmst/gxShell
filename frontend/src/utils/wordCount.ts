const WHITESPACE_RE = /\s/;

/**
 * Word count for the editor status bar.
 *
 * CJK writing has no inter-word spaces, so a plain `split(/\s+/)` reports a
 * 500-character Chinese document as one word. Each ideograph/kana/hangul
 * syllable counts as a word, and the remaining runs are counted normally.
 */
export function countWords(text: string): number {
  // A 20 MiB Chinese document can contain millions of characters. Count in
  // one pass instead of allocating a match array, a replacement and a split.
  let words = 0;
  let inWord = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const cjk = (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af);
    if (cjk) { words++; inWord = false; continue; }
    const space = code === 32 || (code >= 9 && code <= 13) || (code > 127 && WHITESPACE_RE.test(text[index]));
    if (space) inWord = false;
    else if (!inWord) { words++; inWord = true; }
  }
  return words;
}
