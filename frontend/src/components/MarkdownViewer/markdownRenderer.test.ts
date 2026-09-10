import { describe, expect, it } from 'vitest';
import { buildMarkdown, sanitizeMermaidSVG } from './markdownRenderer';
import workflowMarkdown from '../../test/fixtures/mermaid-workflows.md?raw';

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

  it('keeps the reported Chinese Mermaid source intact', () => {
    const rendered = buildMarkdown(workflowMarkdown.replace(/\r?\n/g, '\r\n'));
    expect(rendered.html).toContain('md-mermaid');
    const root = document.createElement('div');
    root.innerHTML = rendered.html;
    const source = decodeURIComponent(root.querySelector<HTMLElement>('.md-mermaid')?.dataset.mermaidSource || '');
    expect(source).toContain('subgraph Indexing[文档入库：资料新增或更新时]');
    expect(source).toContain('H --> I[回答、引用、原文与运行记录]');
    expect(rendered.toc[0].text).toBe('2.2 两条流程要分清');
  });

  it('retains foreignObject labels without allowing active HTML content', () => {
    const svg = sanitizeMermaidSVG(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100">
      <foreignObject width="300" height="80"><div xmlns="http://www.w3.org/1999/xhtml">
        <span class="nodeLabel"><p>选择授权资料<br/><strong>中文说明</strong></p></span>
        <script>alert(1)</script><iframe src="https://example.com"></iframe>
        <input autofocus onfocus="alert(1)"/><img src="x" onerror="alert(1)"/>
        <a href="javascript:alert(1)" onclick="alert(1)">link</a>
      </div></foreignObject><path d="M0,0L5,5"/>
    </svg>`);
    const root = document.createElement('div');
    root.innerHTML = svg;
    expect(root.querySelector('foreignObject .nodeLabel')?.textContent).toContain('选择授权资料中文说明');
    expect(root.querySelector('foreignObject strong')).not.toBeNull();
    expect(root.querySelector('path')).not.toBeNull();
    expect(root.querySelector('script,iframe,input,img,[onclick],[onerror],[onfocus],[autofocus]')).toBeNull();
    expect(svg).not.toContain('javascript:');
  });
});
