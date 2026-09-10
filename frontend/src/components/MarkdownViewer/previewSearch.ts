// CSS, diagram controls and hidden source text are not document search results.
const IGNORED = 'script, style, button, [hidden], [aria-hidden="true"], [data-md-search-ignore]';

export function findPreviewRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  // Matching against the original string keeps Range offsets correct when
  // Unicode lowercasing would change the number of UTF-16 code units (e.g. İ).
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(IGNORED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const ranges: Range[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    pattern.lastIndex = 0;
    for (const match of (node.textContent || '').matchAll(pattern)) {
      const range = document.createRange();
      range.setStart(node, match.index!);
      range.setEnd(node, match.index! + match[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}
