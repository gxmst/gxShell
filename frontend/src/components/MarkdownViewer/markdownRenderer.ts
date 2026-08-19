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
    return `<h${depth} id="${escapeAttr(id)}" data-md-heading="${escapeAttr(id)}"><a class="md-heading-anchor" href="#${escapeAttr(id)}">#</a>${inner}</h${depth}>\n`;
  };

  renderer.code = function code(token: any) {
    const lang = firstLang(token.lang || '');
    const text = token.text || '';
    if (lang.toLowerCase() === 'mermaid') {
      return `<div class="md-mermaid" data-source="${escapeAttr(text)}">${escapeHtml(text)}</div>`;
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
  const html = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel', 'data-md-link', 'data-md-src', 'data-source', 'data-md-heading', 'data-code-copy', 'aria-label'],
    ADD_TAGS: ['button'],
  });
  return { html, toc };
}

export function sanitizeMermaidSVG(svg: string) {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}
