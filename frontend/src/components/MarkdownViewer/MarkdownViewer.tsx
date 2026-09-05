import clsx from 'clsx';
import { useState, useEffect, useRef, useCallback, useLayoutEffect, lazy, Suspense } from 'react';
import { Braces, Columns2, ListTree, Pencil, RefreshCw, Save, WrapText, X, ChevronUp, ChevronDown } from 'lucide-react';
import {
  ReadLocalFile,
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
import { documentEditorMode, isMarkdownPath, isPdfPath } from '../../utils/textFiles';
import type { JsonValidationResult } from '../../utils/jsonDocuments';
import type { EditorStats, SourceEditorHandle } from './SourceEditor';
import type { RenderedMarkdown } from './markdownRenderer';
import { t } from '../../i18n';
import '../../styles/markdown-viewer.css';

// CodeMirror only loads when a document is actually edited, keeping it out of
// the startup bundle for the read-only viewing path.
const SourceEditor = lazy(() => import('./SourceEditor'));

interface MarkdownViewerProps {
  source?: MarkdownSource;
  filePath?: string;
  remotePath?: string;
  sessionId?: string;
  active?: boolean;
  visible?: boolean;
  locale?: string;
  onClose: () => void;
  onNotify?: (text: string, tone?: 'info' | 'error' | 'success') => void;
  onOpenMarkdownFile?: (target: MarkdownOpenTarget) => void;
  onDirtyChange?: (dirty: boolean, save: () => Promise<boolean>) => void;
}

const EMPTY_RENDERED_MARKDOWN: RenderedMarkdown = { html: '', toc: [] };
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.2;
const MIN_TOC_WIDTH = 150;
const MAX_TOC_WIDTH = 320;
const DEFAULT_TOC_WIDTH = 210;
const MAX_LIVE_JSON_VALIDATION_CHARS = 256 * 1024;
const HL_ALL = 'md-search';
const HL_ACTIVE = 'md-search-active';
let markdownRendererModulePromise: Promise<typeof import('./markdownRenderer')> | null = null;
let jsonDocumentsModulePromise: Promise<typeof import('../../utils/jsonDocuments')> | null = null;
let mermaidModulePromise: Promise<typeof import('mermaid')['default']> | null = null;
let mermaidRenderSequence = 0;
const markdownImageLoadTokens = new WeakMap<HTMLImageElement, object>();
const mermaidRenderTokens = new WeakMap<HTMLElement, object>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function localPDFURL(filePath: string) {
  return `/__gxshell/document/pdf?path=${encodeURIComponent(filePath)}&v=${Date.now()}`;
}

function remotePDFURL(sessionId: string, remotePath: string) {
  return `/__gxshell/document/remote-pdf?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(remotePath)}&v=${Date.now()}`;
}

function getMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      return mermaid;
    });
  }
  return mermaidModulePromise;
}

function getMarkdownRenderer() {
  if (!markdownRendererModulePromise) markdownRendererModulePromise = import('./markdownRenderer');
  return markdownRendererModulePromise;
}

function getJsonDocuments() {
  if (!jsonDocumentsModulePromise) jsonDocumentsModulePromise = import('../../utils/jsonDocuments');
  return jsonDocumentsModulePromise;
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

function cssEscape(value: string) {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

export default function MarkdownViewer({
  source = 'local',
  filePath,
  remotePath,
  sessionId,
  active,
  visible,
  locale = 'en',
  onClose,
  onNotify,
  onOpenMarkdownFile,
  onDirtyChange,
}: MarkdownViewerProps) {
  const isVisible = visible ?? active;
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
  const loadGenerationRef = useRef(0);
  const loadedDocumentRef = useRef<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  draftRef.current = draft;
  eolRef.current = eol;

  const [editorStats, setEditorStats] = useState<EditorStats>({ line: 1, column: 1, chars: 0, words: 0, selected: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const [jsonValidation, setJsonValidation] = useState<JsonValidationResult | null>(null);


  const editorRef = useRef<SourceEditorHandle | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewerMainRef = useRef<HTMLDivElement>(null);
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
  const committedZoomRef = useRef(zoom);
  const zoomGestureRef = useRef(false);
  const tocResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number; frame: number } | null>(null);


  const displayPath = source === 'remote' ? remotePath : filePath;
  const documentKey = JSON.stringify([source, displayPath]);
  const fileName = (displayPath || '').split(/[\\/]/).pop() || '';
  const editorMode = documentEditorMode(displayPath || '');
  const jsonMode = editorMode === 'json' || editorMode === 'jsonl' ? editorMode : null;
  const deferJsonValidation = !!jsonMode && draft.length > MAX_LIVE_JSON_VALIDATION_CHARS;
  const markdownMode = isMarkdownPath(displayPath || '');
  const pdfMode = isPdfPath(displayPath || '');
  const [previewDoc, setPreviewDoc] = useState<RenderedMarkdown>(EMPTY_RENDERED_MARKDOWN);
  const [draftDoc, setDraftDoc] = useState<RenderedMarkdown>(EMPTY_RENDERED_MARKDOWN);
  const visibleDoc = editing && splitPreview ? draftDoc : previewDoc;
  const canShowToc = markdownMode && (!editing || splitPreview) && visibleDoc.toc.length > 0;
  const viewerMainStyle = canShowToc && tocOpen
    ? ({ '--md-outline-width': `${tocWidth}px` } as React.CSSProperties)
    : undefined;

  useEffect(() => {
    if (!markdownMode || !isVisible) return;
    let cancelled = false;
    void getMarkdownRenderer()
      .then((renderer) => renderer.buildMarkdown(content))
      .then((rendered) => {
        if (!cancelled) setPreviewDoc(rendered);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => { cancelled = true; };
  }, [content, isVisible, markdownMode]);

  useEffect(() => {
    if (!markdownMode || !editing || !splitPreview || !isVisible) return;
    let cancelled = false;
    void getMarkdownRenderer()
      .then((renderer) => renderer.buildMarkdown(previewDraft))
      .then((rendered) => {
        if (!cancelled) setDraftDoc(rendered);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => { cancelled = true; };
  }, [editing, isVisible, markdownMode, previewDraft, splitPreview]);

  useEffect(() => {
    if (!editing || !jsonMode || deferJsonValidation) {
      setJsonValidation(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getJsonDocuments().then(({ validateJsonDocument }) => {
        if (!cancelled) setJsonValidation(validateJsonDocument(draft, jsonMode));
      });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deferJsonValidation, draft, editing, jsonMode]);

  useEffect(() => {
    try {
      localStorage.setItem('gx:markdownTocWidth', String(Math.round(tocWidth)));
    } catch {}
  }, [tocWidth]);

  useLayoutEffect(() => {
    committedZoomRef.current = zoom;
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.classList.remove('markdown-viewer-zooming');
    viewer.style.removeProperty('--md-live-scale');
  }, [zoom]);

  const loadFile = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    try {
      setLoading(true);
      if (pdfMode) {
        setPdfURL(source === 'remote'
          ? remotePDFURL(sessionId || '', remotePath || '')
          : localPDFURL(filePath || ''));
        setContent('');
        draftRef.current = '';
        setDraft('');
        setError('');
        return;
      }
      const text = source === 'remote'
        ? await ReadRemoteTextFile(sessionId || '', remotePath || '')
        : await ReadLocalFile(filePath || '');
      if (generation !== loadGenerationRef.current) return;
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
      if (generation === loadGenerationRef.current) setError(err.toString());
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [source, filePath, remotePath, sessionId, pdfMode]);

  useEffect(() => {
    const sameDocument = loadedDocumentRef.current === documentKey;
    loadedDocumentRef.current = documentKey;
    // A transport replacement changes where the next save goes, not the draft.
    if (sameDocument && (editingRef.current || saveInFlightRef.current)) {
      setLoading(false);
    } else {
      setEditing(false);
      setSplitPreview(false);
      void loadFile();
    }
    return () => { loadGenerationRef.current += 1; };
  }, [documentKey, loadFile]);

  const dirty = editing && (draft.length !== content.length || draft !== content || eol !== loadedEol);

  useEffect(() => {
    if (!editing || !splitPreview || !isVisible) return;
    const timer = window.setTimeout(() => setPreviewDraft(draft), 220);
    return () => window.clearTimeout(timer);
  }, [draft, editing, isVisible, splitPreview]);

  useEffect(() => {
    if (editing && splitPreview && isVisible) setPreviewDraft(draft);
    // Only refresh immediately when the preview is opened or becomes visible;
    // keystrokes are handled by the debounced effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isVisible, splitPreview]);

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

  const jsonErrorMessage = (validation: JsonValidationResult) => {
    if (validation.valid) return '';
    return t(lang, 'jsonInvalid', {
      line: String(validation.error.line),
      column: String(validation.error.column),
    });
  };

  const formatJson = async () => {
    if (!jsonMode) return;
    const { formatJsonDocument } = await getJsonDocuments();
    const result = formatJsonDocument(draftRef.current, jsonMode);
    if (!result.ok) {
      const validation: JsonValidationResult = { valid: false, error: result.error };
      setJsonValidation(validation);
      onNotify?.(jsonErrorMessage(validation), 'error');
      return;
    }
    draftRef.current = result.text;
    setDraft(result.text);
    setJsonValidation({ valid: true });
    requestAnimationFrame(() => editorRef.current?.focus());
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
        if (jsonMode) {
          const { validateJsonDocument } = await getJsonDocuments();
          const validation = validateJsonDocument(snapshot.draft, jsonMode);
          setJsonValidation(validation);
          if (!validation.valid) {
            onNotify?.(jsonErrorMessage(validation), 'error');
            return false;
          }
        }
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
    if (!isVisible || !markdownMode) return;
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
  }, [filePath, isVisible, lang, markdownMode, onNotify, onOpenMarkdownFile, remotePath, sessionId, source]);

  const jumpToHeading = (id: string) => {
    const el = contentRootRef.current?.querySelector<HTMLElement>(`#${cssEscape(id)}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const previewZoom = useCallback((next: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const ratio = next / committedZoomRef.current;
    viewer.style.setProperty('--md-live-scale', String(ratio));
    viewer.classList.add('markdown-viewer-zooming');
  }, []);

  const onZoomPointerDown = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    zoomGestureRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const commitZoomGesture = useCallback((input: HTMLInputElement) => {
    zoomGestureRef.current = false;
    const next = clamp(Number(input.value), MIN_ZOOM, MAX_ZOOM);
    if (next === committedZoomRef.current) {
      const viewer = viewerRef.current;
      viewer?.classList.remove('markdown-viewer-zooming');
      viewer?.style.removeProperty('--md-live-scale');
      return;
    }
    setZoom(next);
  }, []);

  const cancelZoomGesture = useCallback((input: HTMLInputElement) => {
    zoomGestureRef.current = false;
    input.value = String(committedZoomRef.current);
    const viewer = viewerRef.current;
    viewer?.classList.remove('markdown-viewer-zooming');
    viewer?.style.removeProperty('--md-live-scale');
  }, []);

  const onTocResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    tocResizeRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: tocWidth, width: tocWidth, frame: 0 };
  }, [tocWidth]);

  const onTocResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = tocResizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.width = clamp(drag.startWidth + e.clientX - drag.startX, MIN_TOC_WIDTH, MAX_TOC_WIDTH);
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      const current = tocResizeRef.current;
      if (!current) return;
      current.frame = 0;
      viewerMainRef.current?.style.setProperty('--md-outline-width', `${current.width}px`);
    });
  }, []);

  const finishTocResize = useCallback((e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = tocResizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    tocResizeRef.current = null;
    const width = cancelled ? tocWidth : drag.width;
    viewerMainRef.current?.style.setProperty('--md-outline-width', `${width}px`);
    if (!cancelled && width !== tocWidth) setTocWidth(width);
  }, [tocWidth]);

  useEffect(() => {
    const root = contentRootRef.current;
    if (!isVisible || !markdownMode || !root || !displayPath) return;
    let cancelled = false;
    const images = Array.from(root.querySelectorAll<HTMLImageElement>(
      'img[data-md-src]:not([data-md-loaded]), img[data-md-loaded="error"]',
    ));
    images.forEach(async (img) => {
      const href = img.dataset.mdSrc || '';
      if (!href) return;
      const token = {};
      markdownImageLoadTokens.set(img, token);
      img.dataset.mdLoaded = 'pending';
      img.classList.remove('md-image-error');
      img.classList.add('md-image-loading');
      try {
        const dataUrl = source === 'remote'
          ? await ReadRemoteMarkdownResourceDataURL(sessionId || '', remotePath || '', href)
          : await ReadLocalMarkdownResourceDataURL(filePath || '', href);
        if (cancelled || markdownImageLoadTokens.get(img) !== token) return;
        markdownImageLoadTokens.delete(img);
        img.src = dataUrl;
        img.dataset.mdLoaded = 'true';
        img.classList.remove('md-image-loading');
      } catch {
        if (cancelled || markdownImageLoadTokens.get(img) !== token) return;
        markdownImageLoadTokens.delete(img);
        img.dataset.mdLoaded = 'error';
        img.classList.remove('md-image-loading');
        img.classList.add('md-image-error');
      }
    });
    return () => {
      cancelled = true;
      images.forEach((img) => {
        if (img.dataset.mdLoaded !== 'pending') return;
        markdownImageLoadTokens.delete(img);
        delete img.dataset.mdLoaded;
      });
    };
  }, [displayPath, editing, filePath, isVisible, markdownMode, remotePath, sessionId, source, splitPreview, visibleDoc.html]);

  useEffect(() => {
    if (!isVisible || !markdownMode) return;
    const root = contentRootRef.current;
    if (!root) return;
    let cancelled = false;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.md-mermaid:not([data-md-rendered])'));
    if (!blocks.length) return;

    const tokens = blocks.map((block) => {
      const token = {};
      mermaidRenderTokens.set(block, token);
      block.dataset.mdRendered = 'pending';
      return token;
    });

    (async () => {
      const mermaid = await getMermaid();
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const sourceText = block.dataset.source || block.textContent || '';
        const id = `md-mermaid-${++mermaidRenderSequence}`;
        try {
          const result = await mermaid.render(id, sourceText);
          if (cancelled || mermaidRenderTokens.get(block) !== tokens[i]) return;
          const renderer = await getMarkdownRenderer();
          const sanitizedSVG = renderer.sanitizeMermaidSVG(result.svg);
          if (cancelled || mermaidRenderTokens.get(block) !== tokens[i]) return;
          mermaidRenderTokens.delete(block);
          block.innerHTML = sanitizedSVG;
          block.dataset.mdRendered = 'true';
          block.classList.add('md-mermaid-rendered');
        } catch (err: any) {
          if (cancelled || mermaidRenderTokens.get(block) !== tokens[i]) return;
          mermaidRenderTokens.delete(block);
          block.dataset.mdRendered = 'error';
          block.classList.add('md-mermaid-error');
          block.textContent = err?.message || 'Mermaid render failed';
        }
      }
    })();

    return () => {
      cancelled = true;
      blocks.forEach((block, index) => {
        if (mermaidRenderTokens.get(block) !== tokens[index]) return;
        mermaidRenderTokens.delete(block);
        if (block.dataset.mdRendered === 'pending') delete block.dataset.mdRendered;
      });
    };
  }, [editing, isVisible, markdownMode, splitPreview, visibleDoc.html]);

  useEffect(() => {
    const scroller = editing && splitPreview ? splitPreviewRef.current : previewRef.current;
    const root = contentRootRef.current;
    if (!isVisible || !scroller || !root || !canShowToc) {
      setActiveHeading('');
      return;
    }
    let frame = 0;
    let headings: Array<{ id: string; top: number }> = [];
    const measureHeadings = () => {
      headings = Array.from(root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
        .map((heading) => ({ id: heading.id, top: heading.offsetTop }));
    };
    const updateActiveHeading = () => {
      frame = 0;
      if (!headings.length) {
        setActiveHeading('');
        return;
      }
      const target = scroller.scrollTop + 96;
      let low = 0;
      let high = headings.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (headings[mid].top <= target) low = mid;
        else high = mid - 1;
      }
      setActiveHeading(headings[low].id);
    };
    const scheduleUpdate = () => {
      if (!frame) frame = requestAnimationFrame(updateActiveHeading);
    };
    const resizeObserver = new ResizeObserver(() => {
      measureHeadings();
      scheduleUpdate();
    });
    measureHeadings();
    updateActiveHeading();
    resizeObserver.observe(root);
    scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
    return () => {
      resizeObserver.disconnect();
      scroller.removeEventListener('scroll', scheduleUpdate);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [canShowToc, editing, isVisible, splitPreview, visibleDoc.html, zoom]);

  if (loading) return <div className="markdown-viewer-loading">{t(lang, "loading")}</div>;
  if (error) return <div className="markdown-viewer-error">{error}</div>;

  return (
    <div
      className="markdown-viewer"
      ref={viewerRef}
      data-active={active ? 'true' : 'false'}
      data-visible={isVisible ? 'true' : 'false'}
    >
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
          defaultValue={zoom}
          aria-label="Document zoom"
          title={`Zoom ${Math.round(zoom * 100)}%`}
          onPointerDown={onZoomPointerDown}
          onInput={(e) => {
            const next = Number(e.currentTarget.value);
            e.currentTarget.title = `Zoom ${Math.round(next * 100)}%`;
            previewZoom(next);
          }}
          onChange={(e) => {
            if (!zoomGestureRef.current) setZoom(Number(e.currentTarget.value));
          }}
          onPointerUp={(e) => commitZoomGesture(e.currentTarget)}
          onPointerCancel={(e) => cancelZoomGesture(e.currentTarget)}
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
        {jsonMode && editing && (
          <button onClick={formatJson} className="markdown-viewer-tbtn" title={t(lang, 'formatJson')}>
            <Braces size={15} />
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
            <button onClick={save} className="markdown-viewer-tbtn" disabled={saving || jsonValidation?.valid === false} title="Save (Ctrl+S)">
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

      <div ref={viewerMainRef} className={clsx('markdown-viewer-main', canShowToc && tocOpen && 'with-toc')} style={viewerMainStyle}>
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
            <div
              className="markdown-outline-resizer"
              onPointerDown={onTocResizeStart}
              onPointerMove={onTocResizeMove}
              onPointerUp={(e) => finishTocResize(e)}
              onPointerCancel={(e) => finishTocResize(e, true)}
            />
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
                mode={editorMode}
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
          {jsonMode && deferJsonValidation && (
            <span className="source-editor-status-item">{t(lang, 'jsonValidateOnSave')}</span>
          )}
          {jsonMode && !deferJsonValidation && jsonValidation && (
            <span className={clsx(
              'source-editor-status-item',
              jsonValidation.valid ? 'source-editor-status-valid' : 'source-editor-status-invalid',
            )}>
              {jsonValidation.valid ? t(lang, 'jsonValid') : jsonErrorMessage(jsonValidation)}
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
