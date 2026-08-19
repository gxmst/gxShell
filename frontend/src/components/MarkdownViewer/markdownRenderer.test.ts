import { describe, expect, it } from 'vitest';
import { buildMarkdown, sanitizeMermaidSVG } from './markdownRenderer';

describe('markdownRenderer', () => {
  it('preserves headings, code highlighting, links, and relative image metadata', () => {
    const rendered = buildMarkdown([
      '# Intro',
      '',
      '[Next](next.md)',
      '',
      '![Diagram](diagram.png)',
      '',
      '```json',
      '{"ready": true}',
      '```',
    ].join('\n'));

    expect(rendered.toc).toEqual([{ id: 'intro', text: 'Intro', depth: 1 }]);
    expect(rendered.html).toContain('data-md-link="next.md"');
    expect(rendered.html).toContain('data-md-src="diagram.png"');
    expect(rendered.html).toContain('language-json');
    expect(rendered.html).toContain('hljs-attr');
  });

  it('sanitizes Markdown HTML and Mermaid SVG', () => {
    const rendered = buildMarkdown('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(rendered.html).not.toContain('onerror');
    expect(rendered.html).not.toContain('<script');

    const svg = sanitizeMermaidSVG('<svg><script>alert(1)</script><circle cx="4" cy="4" r="2" /></svg>');
    expect(svg).toContain('<circle');
    expect(svg).not.toContain('<script');
  });
});
