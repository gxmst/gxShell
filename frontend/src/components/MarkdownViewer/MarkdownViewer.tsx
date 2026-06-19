import clsx from 'clsx';
import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { Columns2, ListTree, Pencil, RefreshCw, Save, WrapText, X, ChevronUp, ChevronDown } from 'lucide-react';
import {
  ReadLocalFile,
  ReadLocalMarkdownResourceDataURL,
  ReadRemoteMarkdownFile,
  ReadRemoteMarkdownResourceDataURL,
  ResolveLocalMarkdownLink,
  ResolveRemoteMarkdownLink,
  WriteLocalFile,
  WriteRemoteMarkdownFile,
} from '../../../wailsjs/go/main/App';
import type { MarkdownOpenTarget, MarkdownSource } from '../../types';

interface MarkdownViewerProps {
  source?: MarkdownSource;
  filePath?: string;
  remotePath?: string;
  sessionId?: string;
  active?: boolean;
  onClose: () => void;
  onNotify?: (text: string, tone?: 'info' | 'error' | 'success') => void;
  onOpenMarkdownFile?: (target: MarkdownOpenTarget) => void;
}

type TocItem = { id: string; text: string; depth: number };
type RenderedMarkdown = { html: string; toc: TocItem[] };

const EMPTY_RENDERED_MARKDOWN: RenderedMarkdown = { html: '', toc: [] };
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.2;
const HL_ALL = 'md-search';
const HL_ACTIVE = 'md-search-active';
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)([#?].*)?$/i;

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
  onClose,
  onNotify,
  onOpenMarkdownFile,
}: MarkdownViewerProps) {
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [tocOpen, setTocOpen] = useState(true);
  const [activeHeading, setActiveHeading] = useState('');
  const [wrapCode, setWrapCode] = useState(false);
  const [splitPreview, setSplitPreview] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [current, setCurrent] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const splitPreviewRef = useRef<HTMLDivElement>(null);
  const contentRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const editMatchesRef = useRef<{ start: number; end: number }[]>([]);
  const pendingScrollRatioRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const displayPath = source === 'remote' ? remotePath : filePath;
  const previewDoc = useMemo(() => buildMarkdown(content), [content]);
  const draftDoc = useMemo(
    () => (editing && splitPreview ? buildMarkdown(draft) : EMPTY_RENDERED_MARKDOWN),
    [draft, editing, splitPreview],
  );
  const visibleDoc = editing && splitPreview ? draftDoc : previewDoc;
  const canShowToc = (!editing || splitPreview) && visibleDoc.toc.length > 0;

  const loadFile = useCallback(async () => {
    try {
      setLoading(true);
      const text = source === 'remote'
        ? await ReadRemoteMarkdownFile(sessionId || '', remotePath || '')
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
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    captureScrollRatio();
    setDraft(content);
    setEditing(false);
    setSplitPreview(false);
  };

  const save = async () => {
    try {
      setSaving(true);
      if (source === 'remote') {
        await WriteRemoteMarkdownFile(sessionId || '', remotePath || '', draft);
      } else {
        await WriteLocalFile(filePath || '', draft);
      }
      captureScrollRatio();
      setContent(draft);
      setEditing(false);
      setSplitPreview(false);
      onNotify?.('File saved', 'success');
    } catch (err: any) {
      onNotify?.(err.toString(), 'error');
    } finally {
      setSaving(false);
    }
  };

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
    if (!(e.target instanceof HTMLElement)) return;

    const copyBtn = e.target.closest('[data-code-copy]');
    if (copyBtn) {
      e.preventDefault();
      const code = copyBtn.closest('.md-code-block')?.querySelector('code')?.textContent || '';
      try {
        await navigator.clipboard.writeText(code);
        onNotify?.('Copied to clipboard', 'success');
      } catch {
        onNotify?.('Copy failed', 'error');
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
  }, [source, filePath, remotePath, sessionId, onOpenMarkdownFile, onNotify]);

  const jumpToHeading = (id: string) => {
    const el = contentRootRef.current?.querySelector<HTMLElement>(`#${cssEscape(id)}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  useEffect(() => {
    const root = contentRootRef.current;
    if (!root || !displayPath) return;
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
  }, [visibleDoc.html, editing, splitPreview, source, filePath, remotePath, sessionId, displayPath]);

  useEffect(() => {
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
  }, [visibleDoc.html, editing, splitPreview]);

  useEffect(() => {
    const scroller = editing && splitPreview ? splitPreviewRef.current : previewRef.current;
    const root = contentRootRef.current;
    if (!scroller || !root || !canShowToc) {
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
  }, [visibleDoc.html, editing, splitPreview, canShowToc]);

  if (loading) return <div className="markdown-viewer-loading">Loading...</div>;
  if (error) return <div className="markdown-viewer-error">{error}</div>;

  return (
    <div className="markdown-viewer">
      <div className="markdown-viewer-float">
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
          title="Outline"
        >
          <ListTree size={15} />
        </button>
        <button
          onClick={() => setWrapCode((v) => !v)}
          className={clsx('markdown-viewer-fbtn', wrapCode && 'active')}
          title="Wrap code"
        >
          <WrapText size={15} />
        </button>
        {editing && (
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
            placeholder="Find"
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
          <button className="markdown-viewer-fbtn" onClick={closeSearch} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
      )}

      <div className={clsx('markdown-viewer-main', canShowToc && tocOpen && 'with-toc')}>
        {canShowToc && tocOpen && (
          <aside className="markdown-viewer-outline">
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
            {splitPreview && (
              <div className="markdown-viewer-content markdown-viewer-split-content" ref={splitPreviewRef}>
                <div
                  ref={contentRootRef}
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
            <div
              ref={contentRootRef}
              className={clsx('ai-markdown', 'md-document', wrapCode && 'md-wrap-code')}
              style={{ zoom: zoom }}
              onClick={onContentClick}
              dangerouslySetInnerHTML={{ __html: previewDoc.html }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
