const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/g;

/**
 * Word count for the editor status bar.
 *
 * CJK writing has no inter-word spaces, so a plain `split(/\s+/)` reports a
 * 500-character Chinese document as one word. Each ideograph/kana/hangul
 * syllable counts as a word, and the remaining runs are counted normally.
 */
export function countWords(text: string): number {
  const cjk = (text.match(CJK_RE) || []).length;
  const rest = text.replace(CJK_RE, ' ').trim();
  return cjk + (rest ? rest.split(/\s+/).length : 0);
}
