import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { sanitizeRenderedHtml } from '../../utils/sanitizeHtml';
import { headingDomId } from '../../utils/markdownHeadings';

export type TocItem = { id: string; text: string; depth: number };
export type RenderedMarkdown = { html: string; toc: TocItem[] };

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)([#?].*)?$/i;

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('go', go);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdownLanguage);
hljs.registerLanguage('md', markdownLanguage);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('ps1', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function stripInlineMarkdown(value: string) {
  return value
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text: string, seen: Record<string, number>) {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
  const count = seen[base] || 0;
  seen[base] = count + 1;
  return count ? `${base}-${count + 1}` : base;
}

function firstLang(value?: string) {
  return (value || '').trim().split(/\s+/)[0] || '';
}

function isExternalHref(href: string) {
  return /^(https?:|mailto:|data:|blob:|#)/i.test(href) || href.startsWith('//');
}

function isMarkdownHref(href: string) {
  if (!href || isExternalHref(href)) return false;
  const withoutFragment = href.split('#')[0].split('?')[0];
  return /\.md$/i.test(withoutFragment);
}

function isRelativeImageHref(href: string) {
  return !!href && !isExternalHref(href) && IMAGE_EXT_RE.test(href);
}

function highlightCode(code: string, lang: string) {
  const language = firstLang(lang);
  if (language && hljs.getLanguage(language)) {
    try {
      return { html: hljs.highlight(code, { language }).value, label: language };
    } catch {}
  }
  try {
    // Keep unlabeled-block detection bounded; checking every registered
    // language becomes expensive for large documents.
    const result = hljs.highlightAuto(code, ['bash', 'json', 'yaml', 'python', 'javascript']);
    return { html: result.value, label: language || result.language || 'text' };
  } catch {
    return { html: escapeHtml(code), label: language || 'text' };
  }
}

export function buildMarkdown(markdown: string): RenderedMarkdown {
  const renderer = new marked.Renderer();
  const toc: TocItem[] = [];
  const seen: Record<string, number> = {};

  renderer.heading = function heading(token: any) {
    const depth = token.depth || 1;
    const rawText = stripInlineMarkdown(token.text || '');
    const id = slugify(rawText, seen);
    toc.push({ id, text: rawText || id, depth });
    const inner = this.parser.parseInline(token.tokens || []);
    // The DOM id is prefixed so a heading whose slug is a DOM property name
    // (`## Scripts`, `## Title`, `## Name`) survives sanitizing — DOMPurify
    // drops such an id to prevent clobbering, which left the outline and the
    // fragment links pointing at nothing. `data-md-heading` keeps the plain
    // slug: the outline, the active-heading tracker, and hand-written
    // `[jump](#scripts)` fragments all address headings by slug.
    return `<h${depth} id="${escapeAttr(headingDomId(id))}" data-md-heading="${escapeAttr(id)}"><a class="md-heading-anchor" href="#${escapeAttr(id)}">#</a>${inner}</h${depth}>\n`;
  };

  renderer.code = function code(token: any) {
    const lang = firstLang(token.lang || '');
    const text = token.text || '';
    if (lang.toLowerCase() === 'mermaid') {
      // XML-safe sanitization rejects literal --> inside attribute values.
      // URI encoding preserves Mermaid arrows and Chinese labels in metadata.
      return `<div class="md-mermaid" data-mermaid-source="${escapeAttr(encodeURIComponent(text))}">${escapeHtml(text)}</div>`;
    }
    const highlighted = highlightCode(text, lang);
    const label = highlighted.label || lang || 'text';
    return [
      '<div class="md-code-block">',
      '<div class="md-code-header">',
      `<span>${escapeHtml(label)}</span>`,
      '<button type="button" class="md-code-copy" data-code-copy="true" aria-label="Copy code">',
      '<span>Copy</span>',
      '</button>',
      '</div>',
      `<pre><code class="hljs language-${escapeAttr(label)}">${highlighted.html}</code></pre>`,
      '</div>\n',
    ].join('');
  };

  renderer.link = function link(token: any) {
    const href = token.href || '';
    const label = this.parser.parseInline(token.tokens || []);
    const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
    if (isMarkdownHref(href)) {
      return `<a href="#" data-md-link="${escapeAttr(href)}"${title}>${label}</a>`;
    }
    const external = isExternalHref(href) && !href.startsWith('#');
    const attrs = external ? ' target="_blank" rel="noreferrer noopener"' : '';
    return `<a href="${escapeAttr(href)}"${title}${attrs}>${label}</a>`;
  };

  renderer.image = function image(token: any) {
    const href = token.href || '';
    const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
    const alt = escapeAttr(token.text || '');
    if (isRelativeImageHref(href)) {
      return `<img data-md-src="${escapeAttr(href)}" alt="${alt}"${title} class="md-image-loading">`;
    }
    return `<img src="${escapeAttr(href)}" alt="${alt}"${title}>`;
  };

  const rawHtml = marked.parse(markdown, { renderer, gfm: true, breaks: false }) as string;
  // The document shares a document with the rest of the app — the approval
  // panel included — so the shared policy in utils/sanitizeHtml.ts strips the
  // stylesheet and overlay vectors. This call only widens the allow-list with
  // the attributes the viewer's own controls rely on.
  const html = sanitizeRenderedHtml(rawHtml, {
    ADD_ATTR: ['target', 'rel', 'data-md-link', 'data-md-src', 'data-mermaid-source', 'data-md-heading', 'data-code-copy', 'aria-label'],
    ADD_TAGS: ['button'],
  });
  return { html, toc };
}

export function sanitizeMermaidSVG(svg: string) {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Mermaid measures and renders HTML labels inside SVG foreignObject.
    // Retain that small text vocabulary without enabling arbitrary HTML.
    // `style=` has to stay: Mermaid writes it on its own nodes (a flowchart
    // emits a couple of dozen), so forbidding it would flatten every diagram.
    // Diagram *text* cannot reach it — labels are escaped, and htmlLabels is
    // pinned by the `secure` list in mermaidRenderer.
    ADD_TAGS: ['foreignObject', 'div', 'span', 'p', 'br', 'b', 'i', 'strong', 'em', 'code', 's', 'sub', 'sup'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
  // Then drop the one thing a Mermaid stylesheet does not scope to its diagram.
  return clean.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, open: string, css: string, close: string) => open + stripAnimationKeyframes(css) + close,
  );
}

// Remove every @keyframes block from a stylesheet.
//
// Mermaid wraps each generated selector in `#<svg-id>`, so an ordinary rule
// cannot reach outside its own diagram — but it emits keyframe *names*
// verbatim, and an animation name is global to the document. A diagram could
// therefore define `@keyframes` for a name the application animates and, being
// defined later, win: an entrance animation could be turned into one that ends
// at `opacity: 0`.
//
// Nothing here needs those keyframes. Mermaid emits them for animated edges,
// which these documents do not use, and an `animation` whose name has no
// `@keyframes` simply does not run. Removing them means no animation name can
// come from a diagram at all, so no future styling choice in the app has to
// stay clear of a name an attacker could guess.
export function stripAnimationKeyframes(css: string): string {
  const start = /@(?:-\w+-)?keyframes\b/;
  let out = '';
  let index = 0;
  while (index < css.length) {
    const match = start.exec(css.slice(index));
    if (!match || match.index === undefined) {
      out += css.slice(index);
      break;
    }
    const at = index + match.index;
    out += css.slice(index, at);
    const open = css.indexOf('{', at);
    if (open < 0) break;
    // Keyframe bodies nest (`100% { ... }`), so the block ends at the brace
    // that closes the at-rule, not at the first one.
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') {
        depth -= 1;
        if (depth === 0) { end += 1; break; }
      }
    }
    index = end;
  }
  return out;
}
