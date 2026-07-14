import clsx from 'clsx';
import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
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
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Columns2, ListTree, Pencil, RefreshCw, Save, WrapText, X, ChevronUp, ChevronDown } from 'lucide-react';
import {
  ReadLocalFile,
  ReadLocalMarkdownResourceDataURL,
  ReadRemoteTextFile,
  ReadRemoteMarkdownResourceDataURL,
  ResolveLocalMarkdownLink,
  ResolveRemoteMarkdownLink,
  WriteLocalFile,
  WriteRemoteTextFile,
} from '../../../wailsjs/go/main/App';
import type { MarkdownOpenTarget, MarkdownSource } from '../../types';
import { isMarkdownPath } from '../../utils/textFiles';
import { t } from '../../i18n';
import '../../styles/markdown-viewer.css';

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
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
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

interface MarkdownViewerProps {
  source?: MarkdownSource;
  filePath?: string;
  remotePath?: string;
  sessionId?: string;
  active?: boolean;
  locale?: string;
  onClose: () => void;
  onNotify?: (text: string, tone?: 'info' | 'error' | 'success') => void;
  onOpenMarkdownFile?: (target: MarkdownOpenTarget) => void;
  onDirtyChange?: (dirty: boolean, save: () => Promise<boolean>) => void;
}

type TocItem = { id: string; text: string; depth: number };
type RenderedMarkdown = { html: string; toc: TocItem[] };

const EMPTY_RENDERED_MARKDOWN: RenderedMarkdown = { html: '', toc: [] };
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.2;
const MIN_TOC_WIDTH = 150;
const MAX_TOC_WIDTH = 320;
const DEFAULT_TOC_WIDTH = 210;
const HL_ALL = 'md-search';
const HL_ACTIVE = 'md-search-active';
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)([#?].*)?$/i;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function initialTocWidth() {
  try {
    const stored = Number(localStorage.getItem('gx:markdownTocWidth'));
    return stored ? clamp(stored, MIN_TOC_WIDTH, MAX_TOC_WIDTH) : DEFAULT_TOC_WIDTH;
  } catch {
    return DEFAULT_TOC_WIDTH;
  }
}

function clearHighlights() {
  const reg = (CSS as any).highlights;
  if (!reg) return;
  reg.delete(HL_ALL);
  reg.delete(HL_ACTIVE);
}

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
    const result = hljs.highlightAuto(code);
    return { html: result.value, label: language || result.language || 'text' };
  } catch {
    return { html: escapeHtml(code), label: language || 'text' };
  }
}

function buildMarkdown(markdown: string): RenderedMarkdown {
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

function cssEscape(value: string) {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

export default function MarkdownViewer({
  source = 'local',
  filePath,
  remotePath,
  sessionId,
  active,
  locale = 'en',
  onClose,
  onNotify,
  onOpenMarkdownFile,
  onDirtyChange,
}: MarkdownViewerProps) {
  const [content, setContent] = useState('');
  const lang = locale || 'en';
  const [draft, setDraft] = useState('');
  const [previewDraft, setPreviewDraft] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [tocOpen, setTocOpen] = useState(true);
  const [tocWidth, setTocWidth] = useState(initialTocWidth);
  const [activeHeading, setActiveHeading] = useState('');
  const [wrapCode, setWrapCode] = useState(false);
  const [splitPreview, setSplitPreview] = useState(false);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [current, setCurrent] = useState(0);

  // Idle-fade tier for the floating control bar. It starts fully visible on
  // any interaction, dims to 'idle' after a short pause, then to 'faded' so it
  // stops obscuring the top-right of the document while reading. Hover/focus
  // reveal it via CSS regardless of tier (see .markdown-viewer-float).
  const [floatActivity, setFloatActivity] = useState<'active' | 'idle' | 'faded'>('active');
  const floatTimersRef = useRef<{ idle?: number; faded?: number }>({});

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const splitPreviewRef = useRef<HTMLDivElement>(null);
  const contentRootRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const editMatchesRef = useRef<{ start: number; end: number }[]>([]);
  const pendingScrollRatioRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Register an interaction: reveal the float bar, then re-arm the dim/fade
  // timers. Called on pointer moves, scrolls and key presses over the viewer.
  const noteActivity = useCallback(() => {
    setFloatActivity('active');
    const timers = floatTimersRef.current;
    if (timers.idle) window.clearTimeout(timers.idle);
    if (timers.faded) window.clearTimeout(timers.faded);
    timers.idle = window.setTimeout(() => setFloatActivity('idle'), 2500);
    timers.faded = window.setTimeout(() => setFloatActivity('faded'), 6000);
  }, []);

  // Arm the initial fade and clean up timers on unmount.
  useEffect(() => {
    noteActivity();
    return () => {
      const timers = floatTimersRef.current;
      if (timers.idle) window.clearTimeout(timers.idle);
      if (timers.faded) window.clearTimeout(timers.faded);
    };
  }, [noteActivity]);

  const displayPath = source === 'remote' ? remotePath : filePath;
  const markdownMode = isMarkdownPath(displayPath || '');
  const previewDoc = useMemo(() => (markdownMode ? buildMarkdown(content) : EMPTY_RENDERED_MARKDOWN), [content, markdownMode]);
  const draftDoc = useMemo(
    () => (markdownMode && editing && splitPreview && active ? buildMarkdown(previewDraft) : EMPTY_RENDERED_MARKDOWN),
    [previewDraft, editing, splitPreview, markdownMode, active],
  );
  const visibleDoc = editing && splitPreview ? draftDoc : previewDoc;
  const canShowToc = markdownMode && (!editing || splitPreview) && visibleDoc.toc.length > 0;
  const viewerMainStyle = canShowToc && tocOpen
    ? ({ '--md-outline-width': `${tocWidth}px` } as React.CSSProperties)
    : undefined;

  useEffect(() => {
    try {
      localStorage.setItem('gx:markdownTocWidth', String(Math.round(tocWidth)));
    } catch {}
  }, [tocWidth]);

  const loadFile = useCallback(async () => {
    try {
      setLoading(true);
      const text = source === 'remote'
        ? await ReadRemoteTextFile(sessionId || '', remotePath || '')
        : await ReadLocalFile(filePath || '');
      setContent(text);
      setDraft(text);
      setError('');
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setLoading(false);
    }
  }, [source, filePath, remotePath, sessionId]);

  useEffect(() => {
    setEditing(false);
    setSplitPreview(false);
    loadFile();
  }, [loadFile]);

  const dirty = editing && draft !== content;

  useEffect(() => {
    if (!editing || !splitPreview || !active) return;
    const timer = window.setTimeout(() => setPreviewDraft(draft), 220);
    return () => window.clearTimeout(timer);
  }, [active, draft, editing, splitPreview]);

  useEffect(() => {
    if (editing && splitPreview && active) setPreviewDraft(draft);
    // Only refresh immediately when the preview is opened or becomes visible;
    // keystrokes are handled by the debounced effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, editing, splitPreview]);

  const captureScrollRatio = () => {
    const el = editing ? textareaRef.current : previewRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    pendingScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0;
  };

  useLayoutEffect(() => {
    const ratio = pendingScrollRatioRef.current;
    if (ratio == null) return;
    pendingScrollRatioRef.current = null;
    const el = editing ? textareaRef.current : previewRef.current;
    if (!el) return;
    if (editing) {
      el.focus({ preventScroll: true });
    }
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = max > 0 ? ratio * max : 0;
  }, [editing]);

  const startEdit = () => {
    captureScrollRatio();
    setDraft(content);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (dirty && !window.confirm(t(lang, 'discardChanges'))) return;
    captureScrollRatio();
    setDraft(content);
    setEditing(false);
    setSplitPreview(false);
  };

  const save = async () => {
    try {
      setSaving(true);
      if (source === 'remote') {
        await WriteRemoteTextFile(sessionId || '', remotePath || '', draft);
      } else {
        await WriteLocalFile(filePath || '', draft);
      }
      captureScrollRatio();
      setContent(draft);
      setEditing(false);
      setSplitPreview(false);
      onNotify?.(t(lang, 'fileSaved'), 'success');
      return true;
    } catch (err: any) {
      onNotify?.(err.toString(), 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  useEffect(() => {
    dirtyCallbackRef.current?.(dirty, () => saveRef.current());
  }, [dirty]);

  useEffect(() => () => {
    dirtyCallbackRef.current?.(false, () => Promise.resolve(false));
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setMatchCount(0);
    setCurrent(0);
    rangesRef.current = [];
    editMatchesRef.current = [];
    clearHighlights();
  }, []);

  useEffect(() => {
    if (!active && searchOpen) closeSearch();
  }, [active, searchOpen, closeSearch]);

  useEffect(() => {
    return () => {
      if (activeRef.current) clearHighlights();
    };
  }, []);

  useEffect(() => {
    if (!searchOpen || !active) return;
    const q = query;
    rangesRef.current = [];
    editMatchesRef.current = [];
    clearHighlights();

    if (!q) {
      setMatchCount(0);
      setCurrent(0);
      return;
    }

    if (editing) {
      const hay = draft.toLowerCase();
      const needle = q.toLowerCase();
      const found: { start: number; end: number }[] = [];
      let from = 0;
      for (;;) {
        const idx = hay.indexOf(needle, from);
        if (idx === -1) break;
        found.push({ start: idx, end: idx + needle.length });
        from = idx + needle.length;
      }
      editMatchesRef.current = found;
      setMatchCount(found.length);
      setCurrent(found.length ? 0 : -1);
      return;
    }

    const root = contentRootRef.current;
    const reg = (CSS as any).highlights;
    if (!root || !reg) {
      setMatchCount(0);
      setCurrent(0);
      return;
    }
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const ranges: Range[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || '').toLowerCase();
      let from = 0;
      for (;;) {
        const idx = text.indexOf(needle, from);
        if (idx === -1) break;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        ranges.push(range);
        from = idx + needle.length;
      }
    }
    rangesRef.current = ranges;
    reg.set(HL_ALL, new (window as any).Highlight(...ranges));
    setMatchCount(ranges.length);
    setCurrent(ranges.length ? 0 : -1);
  }, [query, searchOpen, editing, content, draft, active]);

  useEffect(() => {
    if (!searchOpen || !active || current < 0) return;

    if (editing) {
      const m = editMatchesRef.current[current];
      const ta = textareaRef.current;
      if (!m || !ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(m.start, m.end);
      const before = draft.slice(0, m.start);
      const line = before.split('\n').length - 1;
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 2);
      return;
    }

    const reg = (CSS as any).highlights;
    const ranges = rangesRef.current;
    const range = ranges[current];
    if (!reg || !range) return;
    reg.set(HL_ACTIVE, new (window as any).Highlight(range));
    const target = range.startContainer.parentElement;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [current, matchCount, query, searchOpen, editing, active, draft]);

  const goNext = useCallback(() => {
    if (matchCount === 0) return;
    setCurrent((c) => (c + 1) % matchCount);
  }, [matchCount]);

  const goPrev = useCallback(() => {
    if (matchCount === 0) return;
    setCurrent((c) => (c - 1 + matchCount) % matchCount);
  }, [matchCount]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      } else if (e.key === 'Escape' && searchOpen) {
        closeSearch();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, searchOpen, openSearch, closeSearch]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  };

  const syncSplitPreviewScroll = () => {
    if (!splitPreview) return;
    const sourceEl = textareaRef.current;
    const targetEl = splitPreviewRef.current;
    if (!sourceEl || !targetEl) return;
    const maxSource = sourceEl.scrollHeight - sourceEl.clientHeight;
    const maxTarget = targetEl.scrollHeight - targetEl.clientHeight;
    const ratio = maxSource > 0 ? sourceEl.scrollTop / maxSource : 0;
    targetEl.scrollTop = maxTarget > 0 ? ratio * maxTarget : 0;
  };

  const onContentClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!active || !markdownMode) return;
    if (!(e.target instanceof HTMLElement)) return;

    const copyBtn = e.target.closest('[data-code-copy]');
    if (copyBtn) {
      e.preventDefault();
      const code = copyBtn.closest('.md-code-block')?.querySelector('code')?.textContent || '';
      try {
        await navigator.clipboard.writeText(code);
        onNotify?.(t(lang, 'copyToClipboard'), 'success');
      } catch {
        onNotify?.(t(lang, 'copyFailed'), 'error');
      }
      return;
    }

    const anchor = e.target.closest('a[href^="#"]') as HTMLAnchorElement | null;
    if (anchor && !anchor.dataset.mdLink) {
      const id = decodeURIComponent(anchor.getAttribute('href')?.slice(1) || '');
      const el = contentRootRef.current?.querySelector<HTMLElement>(`#${cssEscape(id)}`);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      return;
    }

    const markdownLink = e.target.closest('a[data-md-link]') as HTMLAnchorElement | null;
    const href = markdownLink?.dataset.mdLink;
    if (!href) return;
    e.preventDefault();
    try {
      if (source === 'remote') {
        const resolved = await ResolveRemoteMarkdownLink(remotePath || '', href);
        if (sessionId) onOpenMarkdownFile?.({ source: 'remote', sessionId, path: resolved });
      } else {
        const resolved = await ResolveLocalMarkdownLink(filePath || '', href);
        onOpenMarkdownFile?.({ source: 'local', path: resolved });
      }
    } catch (err: any) {
      onNotify?.(err.toString(), 'error');
    }
  }, [markdownMode, source, filePath, remotePath, sessionId, onOpenMarkdownFile, onNotify]);

  const jumpToHeading = (id: string) => {
    const el = contentRootRef.current?.querySelector<HTMLElement>(`#${cssEscape(id)}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const onTocResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = tocWidth;
    const onMove = (ev: MouseEvent) => {
      setTocWidth(clamp(startWidth + ev.clientX - startX, MIN_TOC_WIDTH, MAX_TOC_WIDTH));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [tocWidth]);

  useEffect(() => {
    const root = contentRootRef.current;
    if (!markdownMode || !root || !displayPath) return;
    let cancelled = false;
    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-md-src]'));
    images.forEach(async (img) => {
      const href = img.dataset.mdSrc || '';
      if (!href) return;
      try {
        const dataUrl = source === 'remote'
          ? await ReadRemoteMarkdownResourceDataURL(sessionId || '', remotePath || '', href)
          : await ReadLocalMarkdownResourceDataURL(filePath || '', href);
        if (cancelled) return;
        img.src = dataUrl;
        img.classList.remove('md-image-loading');
      } catch {
        if (cancelled) return;
        img.classList.remove('md-image-loading');
        img.classList.add('md-image-error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, markdownMode, visibleDoc.html, editing, splitPreview, source, filePath, remotePath, sessionId, displayPath]);

  useEffect(() => {
    if (!active || !markdownMode) return;
    const root = contentRootRef.current;
    if (!root) return;
    let cancelled = false;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.md-mermaid'));
    if (!blocks.length) return;

    (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const sourceText = block.dataset.source || block.textContent || '';
        const id = `md-mermaid-${Date.now()}-${i}`;
        try {
          const result = await mermaid.render(id, sourceText);
          if (cancelled) return;
          block.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
          block.classList.add('md-mermaid-rendered');
        } catch (err: any) {
          if (cancelled) return;
          block.classList.add('md-mermaid-error');
          block.textContent = err?.message || 'Mermaid render failed';
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, markdownMode, visibleDoc.html, editing, splitPreview]);

  useEffect(() => {
    const scroller = editing && splitPreview ? splitPreviewRef.current : previewRef.current;
    const root = contentRootRef.current;
    if (!active || !scroller || !root || !canShowToc) {
      setActiveHeading('');
      return;
    }
    const updateActiveHeading = () => {
      const headings = Array.from(root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'));
      let next = headings[0]?.id || '';
      for (const heading of headings) {
        if (heading.offsetTop - scroller.scrollTop <= 96) {
          next = heading.id;
        } else {
          break;
        }
      }
      setActiveHeading(next);
    };
    updateActiveHeading();
    scroller.addEventListener('scroll', updateActiveHeading);
    return () => scroller.removeEventListener('scroll', updateActiveHeading);
  }, [active, visibleDoc.html, editing, splitPreview, canShowToc]);

  if (loading) return <div className="markdown-viewer-loading">{t(lang, "loading")}</div>;
  if (error) return <div className="markdown-viewer-error">{error}</div>;

  return (
    <div
      className="markdown-viewer"
      onPointerMove={noteActivity}
      onPointerDown={noteActivity}
      onKeyDown={noteActivity}
      onWheelCapture={noteActivity}
    >
      <div className="markdown-viewer-float" data-activity={floatActivity}>
        <input
          type="range"
          className="markdown-viewer-zoom"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={zoom}
          title={`Zoom ${Math.round(zoom * 100)}%`}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        <button
          onClick={() => setTocOpen((v) => !v)}
          className={clsx('markdown-viewer-fbtn', tocOpen && canShowToc && 'active')}
          disabled={!canShowToc}
          title={t(lang, "outline")}
        >
          <ListTree size={15} />
        </button>
        <button
          onClick={() => setWrapCode((v) => !v)}
          className={clsx('markdown-viewer-fbtn', wrapCode && 'active')}
          title={markdownMode ? t(lang, "wrapCode") : t(lang, "wrapText")}
        >
          <WrapText size={15} />
        </button>
        {markdownMode && editing && (
          <button
            onClick={() => setSplitPreview((v) => !v)}
            className={clsx('markdown-viewer-fbtn', splitPreview && 'active')}
            title="Split preview"
          >
            <Columns2 size={15} />
          </button>
        )}
        {editing ? (
          <>
            <button onClick={save} className="markdown-viewer-fbtn" disabled={saving} title="Save (Ctrl+S)">
              <Save size={15} />
            </button>
            <button onClick={cancelEdit} className="markdown-viewer-fbtn" title="Cancel">
              <X size={15} />
            </button>
          </>
        ) : (
          <>
            <button onClick={startEdit} className="markdown-viewer-fbtn" title="Edit">
              <Pencil size={15} />
            </button>
            <button onClick={loadFile} className="markdown-viewer-fbtn" title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button onClick={onClose} className="markdown-viewer-fbtn" title="Close">
              <X size={15} />
            </button>
          </>
        )}
      </div>

      {searchOpen && (
        <div className="markdown-search-bar">
          <input
            ref={searchInputRef}
            className="markdown-search-input"
            value={query}
            placeholder={t(lang, "find")}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <span className="markdown-search-count">
            {matchCount ? `${current + 1}/${matchCount}` : (query ? '0/0' : '')}
          </span>
          <button className="markdown-viewer-fbtn" onClick={goPrev} disabled={!matchCount} title="Previous (Shift+Enter)">
            <ChevronUp size={15} />
          </button>
          <button className="markdown-viewer-fbtn" onClick={goNext} disabled={!matchCount} title="Next (Enter)">
            <ChevronDown size={15} />
          </button>
          <button className="markdown-viewer-fbtn" onClick={closeSearch} title={t(lang, "closeEsc")}>
            <X size={15} />
          </button>
        </div>
      )}

      <div className={clsx('markdown-viewer-main', canShowToc && tocOpen && 'with-toc')} style={viewerMainStyle}>
        {canShowToc && tocOpen && (
          <aside className="markdown-viewer-outline">
            <div className="markdown-outline-header">
              <span>{t(lang, "outline")}</span>
              <button className="markdown-outline-close" onClick={() => setTocOpen(false)} title={t(lang, "hideOutline")}>
                <X size={13} />
              </button>
            </div>
            <div className="markdown-outline-list">
              {visibleDoc.toc.map((item) => (
                <button
                  key={item.id}
                  className={clsx('markdown-outline-item', activeHeading === item.id && 'active')}
                  style={{ paddingLeft: 8 + (item.depth - 1) * 10 }}
                  title={item.text}
                  onClick={() => jumpToHeading(item.id)}
                >
                  {item.text}
                </button>
              ))}
            </div>
            <div className="markdown-outline-resizer" onMouseDown={onTocResizeStart} />
          </aside>
        )}

        {editing ? (
          <div className={clsx('markdown-viewer-edit-shell', splitPreview && 'markdown-viewer-edit-split')}>
            <textarea
              ref={textareaRef}
              className="markdown-viewer-editor"
              style={{ zoom: zoom }}
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditorKeyDown}
              onScroll={syncSplitPreviewScroll}
            />
            {markdownMode && splitPreview && (
              <div className="markdown-viewer-content markdown-viewer-split-content" ref={splitPreviewRef}>
                <div
                  ref={contentRootRef as React.RefObject<HTMLDivElement>}
                  className={clsx('ai-markdown', 'md-document', wrapCode && 'md-wrap-code')}
                  style={{ zoom: zoom }}
                  onClick={onContentClick}
                  dangerouslySetInnerHTML={{ __html: draftDoc.html }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="markdown-viewer-content" ref={previewRef}>
            {markdownMode ? (
              <div
                ref={contentRootRef as React.RefObject<HTMLDivElement>}
                className={clsx('ai-markdown', 'md-document', wrapCode && 'md-wrap-code')}
                style={{ zoom: zoom }}
                onClick={onContentClick}
                dangerouslySetInnerHTML={{ __html: previewDoc.html }}
              />
            ) : (
              <pre
                ref={contentRootRef as React.RefObject<HTMLPreElement>}
                className={clsx('text-document', wrapCode && 'text-document-wrap')}
                style={{ zoom: zoom }}
              >
                {content}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
