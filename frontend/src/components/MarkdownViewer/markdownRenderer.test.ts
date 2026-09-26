import { describe, expect, it } from 'vitest';
import { buildMarkdown, sanitizeMermaidSVG, stripAnimationKeyframes } from './markdownRenderer';
import { findHeadingElement } from '../../utils/markdownHeadings';
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

  // The rendered document shares a document with the rest of the app, so a
  // stylesheet smuggled through Markdown can restyle or hide application UI —
  // including the approval panel. These are the payloads that survived the
  // default DOMPurify profile.
  it('strips document-wide styles and overlays out of Markdown', () => {
    const payloads = [
      // A bare <style> only survives DOMPurify's default profile when it is not
      // the first element, so both positions are pinned here.
      '<style>.cli-panel-group-critical{display:none}</style><p>ok</p>',
      '<p>ok</p><style>.cli-panel-group-critical{display:none}</style>',
      '<svg><style>.cli-panel-group-critical{display:none}</style></svg>',
      '<div style="position:fixed;inset:0;z-index:999999">cover</div>',
      '<div popover id="p">popover</div>',
      '<button popovertarget="p">open</button>',
      '<form action="https://evil.example"><input name="a"></form>',
      '<dialog open>hi</dialog>',
    ];
    for (const payload of payloads) {
      const { html } = buildMarkdown(payload);
      const root = document.createElement('div');
      root.innerHTML = html;

      expect(root.querySelector('style, form, dialog'), payload).toBeNull();
      for (const element of Array.from(root.querySelectorAll('*'))) {
        for (const attribute of ['style', 'popover', 'popovertarget']) {
          expect(element.hasAttribute(attribute), `${payload} -> <${element.tagName.toLowerCase()} ${attribute}>`).toBe(false);
        }
      }
    }
  });

  // A heading whose slug is a property of `document` (`## Scripts`) used to
  // lose its id to DOMPurify's clobbering guard, so the outline entry and any
  // hand-written `[jump](#scripts)` link scrolled nowhere. The renderer now
  // prefixes the DOM id and keeps the plain slug in data-md-heading.
  it('keeps a heading whose slug would clobber a DOM property addressable', () => {
    const names = ['Scripts', 'Title', 'Name', 'Body', 'Location', 'Images', 'Forms', 'Cookie', 'Length', 'Attributes', 'Open', 'Close', 'Head', 'Children', 'Style'];
    const rendered = buildMarkdown(names.map((name) => `## ${name}`).join('\n\n'));
    const root = document.createElement('div');
    root.innerHTML = rendered.html;

    for (const name of names) {
      const slug = name.toLowerCase();
      const heading = root.querySelector<HTMLElement>(`[data-md-heading="${slug}"]`);
      expect(heading, `${name} lost its data-md-heading`).not.toBeNull();
      expect(heading!.id, `${name} lost its DOM id`).toBe(`md-${slug}`);
      expect(findHeadingElement(root, slug), `${name} cannot be resolved by slug`).toBe(heading);
      // The heading's own anchor carries the slug, which is what a
      // hand-written fragment and the outline both use.
      expect(heading!.querySelector('a.md-heading-anchor')?.getAttribute('href')).toBe(`#${slug}`);
      expect(rendered.toc.some((item) => item.id === slug)).toBe(true);
    }

    // Why the prefix is needed: DOMPurify drops a bare clobbering id, so a
    // plain `#scripts` lookup finds nothing. Should this ever start passing,
    // the sanitizer changed and the prefix is merely belt-and-braces — every
    // assertion above still holds.
    expect(root.querySelector('#scripts')).toBeNull();
  });

  it('still renders the Markdown that needs those tags', () => {
    // GFM task lists are <input type="checkbox">, so `input` must stay allowed.
    const { html } = buildMarkdown('- [x] done\n- [ ] todo');
    expect(html).toContain('<input');
    expect(html).toContain('checked');

    // Code blocks keep their copy button, and images keep their metadata.
    const rendered = buildMarkdown('```json\n{"a":1}\n```\n\n![D](d.png)');
    expect(rendered.html).toContain('data-code-copy');
    expect(rendered.html).toContain('data-md-src="d.png"');
  });

  it('labels the code copy control in the requested locale', () => {
    const markdown = '```json\n{"a":1}\n```';
    // The copy control is UI chrome inside generated HTML, so the locale has to
    // travel with the render — a plain English assertion would pass either way.
    const zh = buildMarkdown(markdown, 'zh-CN').html;
    expect(zh).toContain('aria-label="复制代码"');
    expect(zh).toContain('<span>复制</span>');

    const en = buildMarkdown(markdown, 'en').html;
    expect(en).toContain('aria-label="Copy code"');
    expect(en).toContain('<span>Copy</span>');
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

  // Mermaid wraps every generated selector in `#<svg-id>`, but it emits
  // keyframe names verbatim and an animation name is global to the document —
  // so `@keyframes` is the one part of a diagram's stylesheet that can reach
  // application UI. A diagram is free to define an animation the app uses.
  it('removes Mermaid keyframes so a diagram cannot redefine an app animation', () => {
    const svg = sanitizeMermaidSVG(`<svg xmlns="http://www.w3.org/2000/svg">
      <style>#gx-md-mermaid-1{fill:#333;}@keyframes gxProbeAnim{to{opacity:0;}}#gx-md-mermaid-1 .node{fill:red;}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}</style>
      <circle cx="4" cy="4" r="2"/>
    </svg>`);

    expect(svg).not.toContain('@keyframes');
    expect(svg).not.toContain('gxProbeAnim');
    // The scoped rules around it have to survive, or diagrams lose their theme.
    expect(svg).toContain('#gx-md-mermaid-1 .node{fill:red;}');
    expect(svg).toContain('fill:#333;');
    expect(svg).toContain('<circle');
  });

  it('keeps a stylesheet intact when it has no keyframes', () => {
    const svg = sanitizeMermaidSVG('<svg xmlns="http://www.w3.org/2000/svg"><style>#a .b{fill:red;}</style><path d="M0,0"/></svg>');
    expect(svg).toContain('#a .b{fill:red;}');
  });

  it('handles nested keyframe bodies and vendor prefixes', () => {
    expect(stripAnimationKeyframes('a{color:red}@keyframes x{0%{opacity:1}50%{opacity:.5}100%{opacity:0}}b{color:blue}'))
      .toBe('a{color:red}b{color:blue}');
    expect(stripAnimationKeyframes('@-webkit-keyframes y{to{opacity:0}}z{}')).toBe('z{}');
    expect(stripAnimationKeyframes('@keyframes unclosed{to{opacity:0}')).toBe('');
    expect(stripAnimationKeyframes('no keyframes here')).toBe('no keyframes here');
  });
});
