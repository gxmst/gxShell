import { describe, expect, it } from 'vitest';
import { findPreviewRanges, findTextMatches, MAX_SEARCH_MATCHES } from './previewSearch';

describe('rendered document search', () => {
  it('finds prose and SVG labels while excluding styles and diagram controls', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>证据与回答</p><div data-md-search-ignore>证据</div><button>证据</button><pre hidden>证据</pre><svg><style>.证据{fill:red}</style><foreignObject><div>检索证据</div></foreignObject><text>证据引用</text></svg>';
    const matches = findPreviewRanges(root, '证据');
    expect(matches).toHaveLength(3);
    expect(matches.every((range) => range.toString() === '证据')).toBe(true);
  });

  it('matches literal punctuation and preserves Unicode offsets', () => {
    const root = document.createElement('div');
    root.textContent = 'İx A[0] a[0] 中文😀';
    expect(findPreviewRanges(root, 'x').map((range) => range.toString())).toEqual(['x']);
    expect(findPreviewRanges(root, 'a[0]').map((range) => range.toString())).toEqual(['A[0]', 'a[0]']);
    expect(findPreviewRanges(root, '中文😀').map((range) => range.toString())).toEqual(['中文😀']);
  });

  it('finds original source offsets for Unicode and literal regular-expression characters', () => {
    const source = 'İx A[0] a[0] 中文😀 . * $ {value}';
    for (const query of ['x', 'a[0]', '中文😀', '. * $', '{value}']) {
      const { offsets, limited } = findTextMatches(source, query);
      expect(limited).toBe(false);
      const found = Array.from({ length: offsets.length / 2 }, (_, index) => source.slice(offsets[index * 2], offsets[index * 2 + 1]));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((match) => match.toLowerCase() === query.toLowerCase())).toBe(true);
    }
  });

  it('searches offscreen text and bounds match storage for repetitive large files', () => {
    const source = 'line\n'.repeat(400000) + 'end-of-document';
    const tail = findTextMatches(source, 'end-of-document');
    expect(tail.offsets[0]).toBe(source.indexOf('end-of-document'));
    const many = findTextMatches(source, 'line');
    expect(many.offsets.length).toBe(MAX_SEARCH_MATCHES * 2);
    expect(many.limited).toBe(true);
    expect(findTextMatches('a '.repeat(MAX_SEARCH_MATCHES), 'a').limited).toBe(false);
  });
});
