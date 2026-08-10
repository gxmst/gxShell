import clsx from 'clsx';
import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, lazy, Suspense } from 'react';
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
  ReadLocalPDFBase64,
  ReadLocalMarkdownResourceDataURL,
  ReadRemoteTextFile,
  ReadRemoteMarkdownResourceDataURL,
  ResolveLocalMarkdownLink,
  ResolveRemoteMarkdownLink,
  WriteLocalFile,
  WriteRemoteTextFile,
} from '../../../wailsjs/go/app/App';
import type { MarkdownOpenTarget, MarkdownSource } from '../../types';
import { isWindowsPlatform, toClipboardText, writeClipboardText } from '../../utils/clipboard';
import { applyEol, detectEol, eolLabel, toLf, type Eol } from '../../utils/eol';
import { isMarkdownPath, isPdfPath } from '../../utils/textFiles';
import type { EditorStats, SourceEditorHandle } from './SourceEditor';
import { t } from '../../i18n';
import '../../styles/markdown-viewer.css';

// CodeMirror only loads when a document is actually edited, keeping it out of
// the startup bundle for the read-only viewing path.
const SourceEditor = lazy(() => import('./SourceEditor'));

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
    // Unlabeled blocks: restrict auto-detection to a small common subset —
    // running it against every registered language is quadratic-ish and runs
    // synchronously inside buildMarkdown.
    const result = hljs.highlightAuto(code, ['bash', 'json', 'yaml', 'python', 'javascript']);
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
  const [pdfURL, setPdfURL] = useState('');
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
  // The file's own line ending. `content`/`draft` are always LF because that is
  // the only form the editor works in; this is re-applied on save so editing a
  // CRLF file does not silently rewrite every line in it. `loadedEol` is what
  // was on disk, so switching the indicator counts as an unsaved change.
  const [eol, setEol] = useState<Eol>('lf');
  const [loadedEol, setLoadedEol] = useState<Eol>('lf');
  const draftRef = useRef(draft);
  const eolRef = useRef(eol);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  draftRef.current = draft;
  eolRef.current = eol;

  const [editorStats, setEditorStats] = useState<EditorStats>({ line: 1, column: 1, chars: 0, words: 0, selected: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [current, setCurrent] = useState(0);


  const editorRef = useRef<SourceEditorHandle | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const splitPreviewRef = useRef<HTMLDivElement>(null);
  const contentRootRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const editMatchesRef = useRef<{ start: number; end: number }[]>([]);
  const pendingScrollRatioRef = useRef<number | null>(null);
  const pendingEditorRevealRef = useRef<{ start: number; end: number } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;


  const displayPath = source === 'remote' ? remotePath : filePath;
  const fileName = (displayPath || '').split(/[\\/]/).pop() || '';
  const markdownMode = isMarkdownPath(displayPath || '');
  const pdfMode = source === 'local' && isPdfPath(displayPath || '');
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
      if (pdfMode) {
        const encoded = await ReadLocalPDFBase64(filePath || '');
        const binary = window.atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const nextURL = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        setPdfURL((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return nextURL;
        });
        setContent('');
        draftRef.current = '';
        setDraft('');
        setError('');
        return;
      }
      const text = source === 'remote'
        ? await ReadRemoteTextFile(sessionId || '', remotePath || '')
        : await ReadLocalFile(filePath || '');
      // A single-line file has no detectable ending. Use the local platform
      // default for local files; remote hosts are unknown, so keep the portable
      // LF default and let the status control change it explicitly if needed.
      const fallbackEol: Eol = source === 'local' && isWindowsPlatform() ? 'crlf' : 'lf';
      const detected = detectEol(text, fallbackEol);
      eolRef.current = detected;
      setEol(detected);
      setLoadedEol(detected);
      const normalized = toLf(text);
      setContent(normalized);
      draftRef.current = normalized;
      setDraft(normalized);
      setError('');
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setLoading(false);
    }
  }, [source, filePath, remotePath, sessionId, pdfMode]);

  useEffect(() => () => {
    if (pdfURL) URL.revokeObjectURL(pdfURL);
  }, [pdfURL]);

  useEffect(() => {
    setEditing(false);
    setSplitPreview(false);
    loadFile();
  }, [loadFile]);

  const dirty = editing && (draft !== content || eol !== loadedEol);

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
    if (editing) {
      pendingScrollRatioRef.current = editorRef.current?.scrollRatio() ?? 0;
      return;
    }
    const el = previewRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    pendingScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0;
  };

  useLayoutEffect(() => {
    const ratio = pendingScrollRatioRef.current;
    if (ratio == null) return;
    if (editing) {
      // The editor is lazy-loaded, so its handle may not exist on this pass.
      // Leave the pending ratio in place and let the mount effect apply it.
      const handle = editorRef.current;
      if (!handle) return;
      pendingScrollRatioRef.current = null;
      handle.setScrollRatio(ratio);
      return;
    }
    pendingScrollRatioRef.current = null;
    const el = previewRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = max > 0 ? ratio * max : 0;
  }, [editing]);

  // Applies a scroll ratio that was captured before the editor finished
  // loading. Passed as the editor's ref callback so it runs on mount.
  const attachEditor = useCallback((handle: SourceEditorHandle | null) => {
    editorRef.current = handle;
    if (!handle) return;
    const ratio = pendingScrollRatioRef.current;
    if (ratio != null) {
      pendingScrollRatioRef.current = null;
      handle.setScrollRatio(ratio);
    }
    // Reveal after restoring the old scroll ratio so the current match wins
    // and ends up centered once the lazy editor has actually mounted.
    const reveal = pendingEditorRevealRef.current;
    if (reveal) {
      handle.revealRange(reveal.start, reveal.end);
      pendingEditorRevealRef.current = null;
    }
  }, []);

  const startEdit = () => {
    captureScrollRatio();
    draftRef.current = content;
    setDraft(content);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (dirty && !window.confirm(t(lang, 'discardChanges'))) return;
    captureScrollRatio();
    draftRef.current = content;
    setDraft(content);
    eolRef.current = loadedEol;
    setEol(loadedEol);
    setEditing(false);
    setSplitPreview(false);
  };

  const save = () => {
    // React state does not update synchronously, so `saving` alone cannot stop
    // two Ctrl+S/click events from starting writes in the same render frame.
    // Every caller joins the one in-flight operation instead.
    if (saveInFlightRef.current) return saveInFlightRef.current;

    const snapshot = { draft: draftRef.current, eol: eolRef.current };
    // Schedule the body after the ref assignment below. Besides making the
    // same-frame de-duplication explicit, this also guarantees a synchronous
    // backend throw cannot run `finally` before the operation is registered.
    const operation = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        setSaving(true);
        // Restore the selected line ending on the snapshot written to disk.
        // Edits made while this await is pending stay in draftRef/eolRef.
        const payload = applyEol(snapshot.draft, snapshot.eol);
        if (source === 'remote') {
          await WriteRemoteTextFile(sessionId || '', remotePath || '', payload);
        } else {
          await WriteLocalFile(filePath || '', payload);
        }

        const savedCurrentDraft = draftRef.current === snapshot.draft && eolRef.current === snapshot.eol;
        setContent(snapshot.draft);
        setLoadedEol(snapshot.eol);
        if (savedCurrentDraft) {
          captureScrollRatio();
          setEditing(false);
          setSplitPreview(false);
        }
        onNotify?.(t(lang, 'fileSaved'), 'success');
        // The unsaved-changes dialog may close the tab only when the bytes just
        // written still represent the current draft and EOL selection.
        return savedCurrentDraft;
      } catch (err: any) {
        onNotify?.(err.toString(), 'error');
        return false;
      } finally {
        saveInFlightRef.current = null;
        setSaving(false);
      }
    });

    saveInFlightRef.current = operation;
    return operation;
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
    pendingEditorRevealRef.current = null;
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
      pendingEditorRevealRef.current = null;
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
      if (!found.length) pendingEditorRevealRef.current = null;
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
      if (!m) {
        pendingEditorRevealRef.current = null;
        return;
      }
      // CodeMirror owns scrolling and selection, so hand it the range and let
      // it center the match rather than computing a scrollTop from line height.
      pendingEditorRevealRef.current = m;
      if (editorRef.current) {
        editorRef.current.revealRange(m.start, m.end);
        pendingEditorRevealRef.current = null;
      }
      return;
    }

    pendingEditorRevealRef.current = null;

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
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !editing && !pdfMode) {
        const target = e.target;
        const nativeSelectionTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
        const root = contentRootRef.current;
        if (!nativeSelectionTarget && root) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(root);
          selection?.removeAllRanges();
          selection?.addRange(range);
          e.preventDefault();
          e.stopPropagation();
        }
      } else if (e.key === 'Escape' && searchOpen) {
        closeSearch();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, editing, pdfMode, searchOpen, openSearch, closeSearch]);

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

  // Copying a plain-text document: take over the clipboard write instead of
  // leaving it to Chromium's serializer.
  //
  // Chromium attaches an HTML flavor to every DOM-selection copy. Rich-text
  // receivers prefer that flavor, and several of them (chat composers, some web
  // editors) collapse the whitespace inside the copied <pre> — which is how a
  // copied log arrives as one run-together line. For a .txt/.log/.conf the user
  // never wants the HTML flavor, so write text/plain alone and make the paste
  // deterministic everywhere, using CRLF only for Win32 receivers.
  //
  // The rendered Markdown view deliberately does NOT use this: pasting a
  // formatted document into Word or a mail client is a feature there, and
  // Chromium's own text/plain flavor is already CRLF-correct on Windows.
  const onCopyPlainText = useCallback((e: React.ClipboardEvent) => {
    const selected = window.getSelection()?.toString() ?? '';
    if (!selected) return;
    e.clipboardData.setData('text/plain', toClipboardText(selected));
    e.preventDefault();
  }, []);

  // The editor's own copy is handled inside SourceEditor by CodeMirror's
  // clipboardOutputFilter, which applies the same CRLF conversion.

  const syncSplitPreviewScroll = useCallback(() => {
    if (!splitPreview) return;
    const targetEl = splitPreviewRef.current;
    const handle = editorRef.current;
    if (!targetEl || !handle) return;
    const maxTarget = targetEl.scrollHeight - targetEl.clientHeight;
    targetEl.scrollTop = maxTarget > 0 ? handle.scrollRatio() * maxTarget : 0;
  }, [splitPreview]);

  const onContentClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!active || !markdownMode) return;
    if (!(e.target instanceof HTMLElement)) return;

    const copyBtn = e.target.closest('[data-code-copy]');
    if (copyBtn) {
      e.preventDefault();
      const code = copyBtn.closest('.md-code-block')?.querySelector('code')?.textContent || '';
      try {
        await writeClipboardText(code);
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
    <div className="markdown-viewer">
      {/* A real toolbar in normal flow, not an overlay. It previously floated
          over the top-right of the document with a three-tier idle fade: that
          covered text, stayed clickable while nearly invisible, and sat in the
          same corner the user reaches for. Owning a row of its own costs ~34px
          and removes all three problems. */}
      <div className="markdown-viewer-toolbar">
        <span className="markdown-viewer-toolbar-name" title={displayPath || ''}>
          {fileName}
        </span>
        <span className="markdown-viewer-toolbar-spacer" />
        {!pdfMode && <input
          type="range"
          className="markdown-viewer-zoom"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={zoom}
          title={`Zoom ${Math.round(zoom * 100)}%`}
          onChange={(e) => setZoom(Number(e.target.value))}
        />}
        {!pdfMode && <button
          onClick={() => setTocOpen((v) => !v)}
          className={clsx('markdown-viewer-tbtn', tocOpen && canShowToc && 'active')}
          disabled={!canShowToc}
          title={t(lang, "outline")}
        >
          <ListTree size={15} />
        </button>}
        {!pdfMode && <button
          onClick={() => setWrapCode((v) => !v)}
          className={clsx('markdown-viewer-tbtn', wrapCode && 'active')}
          title={markdownMode ? t(lang, "wrapCode") : t(lang, "wrapText")}
        >
          <WrapText size={15} />
        </button>}
        {markdownMode && editing && (
          <button
            onClick={() => setSplitPreview((v) => !v)}
            className={clsx('markdown-viewer-tbtn', splitPreview && 'active')}
            title="Split preview"
          >
            <Columns2 size={15} />
          </button>
        )}
        {pdfMode ? (
          <>
            <button onClick={loadFile} className="markdown-viewer-tbtn" title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button onClick={onClose} className="markdown-viewer-tbtn" title="Close">
              <X size={15} />
            </button>
          </>
        ) : editing ? (
          <>
            <button onClick={save} className="markdown-viewer-tbtn" disabled={saving} title="Save (Ctrl+S)">
              <Save size={15} />
            </button>
            <button onClick={cancelEdit} className="markdown-viewer-tbtn" title="Cancel">
              <X size={15} />
            </button>
          </>
        ) : (
          <>
            <button onClick={startEdit} className="markdown-viewer-tbtn" title="Edit">
              <Pencil size={15} />
            </button>
            <button onClick={loadFile} className="markdown-viewer-tbtn" title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button onClick={onClose} className="markdown-viewer-tbtn" title="Close">
              <X size={15} />
            </button>
          </>
        )}
      </div>

      {!pdfMode && searchOpen && (
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
          <button className="markdown-viewer-tbtn" onClick={goPrev} disabled={!matchCount} title="Previous (Shift+Enter)">
            <ChevronUp size={15} />
          </button>
          <button className="markdown-viewer-tbtn" onClick={goNext} disabled={!matchCount} title="Next (Enter)">
            <ChevronDown size={15} />
          </button>
          <button className="markdown-viewer-tbtn" onClick={closeSearch} title={t(lang, "closeEsc")}>
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

        {pdfMode ? (
          <div className="pdf-viewer-content">
            {pdfURL && <iframe className="pdf-viewer-frame" src={pdfURL} title={displayPath || 'PDF document'} />}
          </div>
        ) : editing ? (
          <div className={clsx('markdown-viewer-edit-shell', splitPreview && 'markdown-viewer-edit-split')}>
            <Suspense fallback={<div className="markdown-viewer-loading">{t(lang, 'loading')}</div>}>
              <SourceEditor
                handleRef={attachEditor}
                value={draft}
                onChange={(next) => {
                  draftRef.current = next;
                  setDraft(next);
                }}
                onSave={save}
                onStats={setEditorStats}
                onScroll={syncSplitPreviewScroll}
                // The base font size is scaled by the same zoom slider the
                // preview uses, so both modes track one control.
                fontSize={Math.round(14 * zoom)}
                wrap={wrapCode}
                markdownMode={markdownMode}
              />
            </Suspense>
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
                tabIndex={0}
                className={clsx('ai-markdown', 'md-document', wrapCode && 'md-wrap-code')}
                style={{ zoom: zoom }}
                onClick={onContentClick}
                dangerouslySetInnerHTML={{ __html: previewDoc.html }}
              />
            ) : (
              <pre
                ref={contentRootRef as React.RefObject<HTMLPreElement>}
                tabIndex={0}
                className={clsx('text-document', wrapCode && 'text-document-wrap')}
                style={{ zoom: zoom }}
                onCopy={onCopyPlainText}
              >
                {content}
              </pre>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="source-editor-status">
          <span className="source-editor-status-item">
            {t(lang, 'statusLineCol', { line: String(editorStats.line), col: String(editorStats.column) })}
          </span>
          <span className="source-editor-status-item">
            {t(lang, 'statusWords', { words: String(editorStats.words), chars: String(editorStats.chars) })}
          </span>
          {editorStats.selected > 0 && (
            <span className="source-editor-status-item">
              {t(lang, 'statusSelected', { count: String(editorStats.selected) })}
            </span>
          )}
          <span className="source-editor-status-spacer" />
          {dirty && <span className="source-editor-status-item source-editor-status-dirty">{t(lang, 'statusUnsaved')}</span>}
          {/* Clicking the indicator converts the file's line endings. It is the
              only place the choice is visible, and converting is a real edit,
              so it marks the document dirty rather than writing immediately. */}
          <button
            type="button"
            className="source-editor-status-btn"
            title={t(lang, 'statusEolHint')}
            onClick={() => setEol((prev) => {
              const next = prev === 'crlf' ? 'lf' : 'crlf';
              eolRef.current = next;
              return next;
            })}
          >
            {eolLabel(eol)}
          </button>
        </div>
      )}
    </div>
  );
}
