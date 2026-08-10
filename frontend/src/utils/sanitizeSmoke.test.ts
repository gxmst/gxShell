// Sanity check for the Markdown sanitization path.
//
// MarkdownViewer renders Markdown fetched over SSH, so DOMPurify is what stands
// between a remote file and script execution in the webview. Nothing else in the
// suite touches it, which meant a DOMPurify upgrade could change that behaviour
// with every test still green. These assertions are deliberately about the
// guarantee the viewer relies on, not about DOMPurify's internals.
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';

describe('DOMPurify sanitization', () => {
  it('strips script elements', () => {
    const html = DOMPurify.sanitize('<p>ok</p><script>window.pwned = 1</script>');
    expect(html).toContain('ok');
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('strips inline event handlers', () => {
    const html = DOMPurify.sanitize('<img src="x" onerror="window.pwned = 1">');
    expect(html.toLowerCase()).not.toContain('onerror');
  });

  it('strips javascript: URLs', () => {
    const html = DOMPurify.sanitize('<a href="javascript:window.pwned = 1">click</a>');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('keeps ordinary Markdown output intact', () => {
    const html = DOMPurify.sanitize(
      '<h1>Title</h1><p><strong>bold</strong> and <a href="https://example.com">link</a></p>',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
  });

  it('keeps svg through the profile the Mermaid path uses', () => {
    const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>';
    const html = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    expect(html).toContain('<svg');
    expect(html).toContain('<circle');
  });

  it('strips script from svg through that same profile', () => {
    const svg = '<svg><script>window.pwned = 1</script><circle r="1"></circle></svg>';
    const html = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    expect(html.toLowerCase()).not.toContain('<script');
  });
});
