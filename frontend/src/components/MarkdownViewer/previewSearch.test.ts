import { describe, expect, it } from 'vitest';
import { findPreviewRanges } from './previewSearch';

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
});
