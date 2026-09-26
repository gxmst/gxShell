import clsx from 'clsx';
import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, lazy, Suspense, useSyncExternalStore } from 'react';
import { Braces, Columns2, ListTree, Pencil, RefreshCw, Save, Search, Type, X, ChevronUp, ChevronDown } from 'lucide-react';
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
import { isWindowsPlatform, writeClipboardText } from '../../utils/clipboard';
import { applyEol, detectEol, eolLabel, toLf, type Eol } from '../../utils/eol';
import { documentEditorMode, extensionOf, isMarkdownPath, isPdfPath } from '../../utils/textFiles';
import { documentPresentation, needsLightweightMarkdown, textDocumentHeadings, MAX_DOCUMENT_HEADINGS, type DocumentHeading, type DocumentOutline } from '../../utils/documentPresentation';
import { getDocumentAppearance, subscribeDocumentAppearance, updateDocumentAppearance, type DocumentAppearance } from '../../utils/documentReadingState';
import type { JsonValidationResult } from '../../utils/jsonDocuments';
import { MAX_SYNC_JSON_CHARS } from '../../utils/jsonDocumentTasks';
import type { EditorStats, SourceEditorHandle } from './SourceEditor';
import type { RenderedMarkdown } from './markdownRenderer';
import { t } from '../../i18n';
import { hasActiveOverlay } from '../../utils/overlayManager';
import { MermaidDiagrams } from './MermaidDiagrams';
import { findPreviewRanges, findTextMatches, MAX_SEARCH_MATCHES } from './previewSearch';
import { useReadingPosition } from './useReadingPosition';
import { ConfirmDialog } from '../modals/ConfirmDialog';
import { DocumentConflictDialog } from '../modals/DocumentConflictDialog';
import { findHeadingElement, headingSlugOf } from '../../utils/markdownHeadings';
import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import '../../styles/markdown-viewer.css';

// Text browsing and editing share a viewport renderer, loaded on demand.
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
  documentId?: string;
  readingIdentity?: string;
  onOutlineChange?: (documentId: string, outline: DocumentOutline | null) => void;
}

const EMPTY_RENDERED_MARKDOWN: RenderedMarkdown = { html: '', toc: [] };
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.2;
const MIN_TOC_WIDTH = 150;
const MAX_TOC_WIDTH = 320;
const DEFAULT_TOC_WIDTH = 210;
const EMPTY_HEADINGS: DocumentHeading[] = [];
const HL_ALL = 'md-search';
const HL_ACTIVE = 'md-search-active';
let markdownRendererModulePromise: Promise<typeof import('./markdownRenderer')> | null = null;
let jsonDocumentsModulePromise: Promise<typeof import('../../utils/jsonDocumentTasks')> | null = null;
const markdownImageLoadTokens = new WeakMap<HTMLImageElement, object>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function localPDFURL(filePath: string) {
  return `/__gxshell/document/pdf?path=${encodeURIComponent(filePath)}&v=${Date.now()}`;
}

function remotePDFURL(sessionId: string, remotePath: string) {
  return `/__gxshell/document/remote-pdf?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(remotePath)}&v=${Date.now()}`;
}

function getMarkdownRenderer() {
  if (!markdownRendererModulePromise) markdownRendererModulePromise = import('./markdownRenderer');
  return markdownRendererModulePromise;
}

function getJsonDocuments() {
  if (!jsonDocumentsModulePromise) jsonDocumentsModulePromise = import('../../utils/jsonDocumentTasks');
  return jsonDocumentsModulePromise;
}

function documentErrorMessage(error: unknown, lang: string) {
  const message = String(error);
  if (message.includes('GX_DOCUMENT_NOT_TEXT')) return t(lang, 'documentNotText');
  if (message.includes('GX_DOCUMENT_TASK_FAILED')) return t(lang, 'documentProcessingFailed');
  return message;
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
  documentId,
  readingIdentity,
  onOutlineChange,
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Version of the content now on disk, set when a save finds the file changed
  // under the editor. Null means no conflict is being asked about.
  const [conflictVersion, setConflictVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formatting, setFormatting] = useState(false);
  // One appearance for the whole app. Every viewer reads the same value and
  // patches only the field it changed, so two panes of a split view cannot
  // overwrite each other's settings with a stale copy.
  const appearance = useSyncExternalStore(subscribeDocumentAppearance, getDocumentAppearance);
  const { zoom, leading, width: column } = appearance;
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(true);
  const [compactReading, setCompactReading] = useState(false);
  const [compactTocOpen, setCompactTocOpen] = useState(false);
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
  const saveControllerRef = useRef<AbortController | null>(null);
  const formatControllerRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const loadedDocumentRef = useRef<string | null>(null);
  // Fingerprint of the bytes the editor is holding. A save sends it so the
  // backend can tell "the file is what I opened" from "someone rewrote it while
  // this tab sat open", which is how certbot and ansible changes used to be
  // silently overwritten.
  const loadedVersionRef = useRef('');
  // Version the last save attempt found on disk, or null when it landed. Read
  // synchronously by the conflict dialog, which has to know whether a retry
  // succeeded or ran into a newer version again.
  const lastConflictRef = useRef<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  draftRef.current = draft;
  eolRef.current = eol;

  const [editorStats, setEditorStats] = useState<EditorStats>({ line: 1, column: 1, chars: 0, words: 0, selected: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [matchesLimited, setMatchesLimited] = useState(false);
  const [matchRevision, setMatchRevision] = useState(0);
  const [current, setCurrent] = useState(0);
  const [jsonValidation, setJsonValidation] = useState<JsonValidationResult | null>(null);


  const editorRef = useRef<SourceEditorHandle | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewerMainRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const splitPreviewRef = useRef<HTMLDivElement>(null);
  const contentRootRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const zoomInputRef = useRef<HTMLInputElement>(null);
  const appearanceRef = useRef<HTMLDivElement>(null);
  const appearanceButtonRef = useRef<HTMLButtonElement>(null);
  const previewContentRef = useRef<string | null>(null);
  const outlineCallbackRef = useRef(onOutlineChange);
  outlineCallbackRef.current = onOutlineChange;
  const rangesRef = useRef<Range[]>([]);
  const editMatchesRef = useRef(new Uint32Array());
  const pendingScrollRatioRef = useRef<number | null>(null);
  const pendingEditorRevealRef = useRef<{ start: number; end: number } | null>(null);
  // The query the last scan was run for. A scan re-runs whenever the document
  // changes, but only a changed query may move the user to the first match.
  const lastSearchQueryRef = useRef<string | null>(null);
  // The "query + match index" the reveal effect last moved to. Rescans replace
  // the Range objects and so must re-apply the active highlight, but they must
  // not re-reveal: while editing, that would drag the caret to the first match
  // on every keystroke and the next character would land there.
  const revealTargetRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const committedZoomRef = useRef(zoom);
  const zoomGestureRef = useRef(false);
  const tocResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number; frame: number } | null>(null);


  const displayPath = source === 'remote' ? remotePath : filePath;
  const documentKey = JSON.stringify([source, displayPath]);
  const documentTargetRef = useRef({ key: documentKey, source, path: displayPath || '', sessionId: sessionId || '' });
  const fileName = (displayPath || '').split(/[\\/]/).pop() || '';
  const editorMode = documentEditorMode(displayPath || '');
  const jsonMode = editorMode === 'json' || editorMode === 'jsonc' || editorMode === 'jsonl' ? editorMode : null;
  const deferJsonValidation = !!jsonMode && draft.length > MAX_SYNC_JSON_CHARS;
  const markdownMode = isMarkdownPath(displayPath || '');
  const pdfMode = isPdfPath(displayPath || '');
  const presentation = useMemo(() => documentPresentation(displayPath || '', content), [displayPath, content]);
  const lightweightMarkdown = useMemo(() => markdownMode && needsLightweightMarkdown(content), [markdownMode, content]);
  const lightweightDraft = useMemo(() => markdownMode && needsLightweightMarkdown(draft), [markdownMode, draft]);
  const richMarkdown = markdownMode && !lightweightMarkdown;
  // All text previews use the same virtualized renderer.
  const virtualTextPreview = !pdfMode && !richMarkdown;
  const sourceView = editing || virtualTextPreview;
  const [previewDoc, setPreviewDoc] = useState<RenderedMarkdown>(EMPTY_RENDERED_MARKDOWN);
  const [draftDoc, setDraftDoc] = useState<RenderedMarkdown>(EMPTY_RENDERED_MARKDOWN);
  const visibleDoc = editing && splitPreview ? draftDoc : previewDoc;
  const textHeadings = useMemo(() => presentation === 'prose' || lightweightMarkdown
    ? textDocumentHeadings(content, lightweightMarkdown) : EMPTY_HEADINGS, [presentation, lightweightMarkdown, content]);
  const outlineItems = !editing && virtualTextPreview ? textHeadings : visibleDoc.toc;
  const canShowToc = !loading && !pdfMode && (!editing || (splitPreview && !lightweightDraft)) && outlineItems.length > 0;
  const outlineInSidebar = !!onOutlineChange;
  const outlineOpen = compactReading ? compactTocOpen : tocOpen;
  const viewerMainStyle = canShowToc && outlineOpen && !outlineInSidebar
    ? ({ '--md-outline-width': `${tocWidth}px` } as React.CSSProperties)
    : undefined;
  const readingColumn = column === 'full' ? '100%' : column === 'wide' ? '64rem' : presentation === 'prose' ? '42em' : '50rem';
  const { remember, restore, beforeLayoutChange } = useReadingPosition({
    identity: readingIdentity || JSON.stringify([source, source === 'remote' ? sessionId : '', displayPath]),
    ready: !loading && !error && (!richMarkdown || previewContentRef.current === content),
    visible: !!isVisible, editing, sourceView, revision: previewDoc,
    layout: JSON.stringify([zoom, leading, column, wrapCode]),
    editor: editorRef, scroller: previewRef, root: contentRootRef, viewer: viewerRef,
  });
  const typeLabel = presentation === 'prose' ? t(lang, 'documentTypeText')
    : presentation === 'plain' ? t(lang, 'documentTypePlain')
      : presentation === 'log' ? t(lang, 'documentTypeLog')
        : markdownMode ? 'Markdown' : pdfMode ? 'PDF'
          : extensionOf(displayPath || '').slice(1).toUpperCase() || fileName;

  useEffect(() => {
    if (!appearanceOpen) return;
    if (!active) { setAppearanceOpen(false); return; }
    zoomInputRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !appearanceRef.current?.contains(event.target)) setAppearanceOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setAppearanceOpen(false);
      appearanceButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [appearanceOpen, active]);

  useLayoutEffect(() => {
    documentTargetRef.current = { key: documentKey, source, path: displayPath || '', sessionId: sessionId || '' };
  }, [documentKey, source, displayPath, sessionId]);

  useLayoutEffect(() => {
    setSaving(false);
    setFormatting(false);
    return () => {
      saveControllerRef.current?.abort();
      formatControllerRef.current?.abort();
      saveControllerRef.current = null;
      formatControllerRef.current = null;
      saveInFlightRef.current = null;
    };
  }, [documentKey]);

  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const update = () => {
      const width = viewer.clientWidth;
      if (width > 0) setCompactReading(width < 640);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewer);
    return () => observer.disconnect();
  }, [loading, error]);

  const toggleOutline = () => compactReading ? setCompactTocOpen((open) => !open) : setTocOpen((open) => !open);
  const closeOutline = () => compactReading ? setCompactTocOpen(false) : setTocOpen(false);

  useEffect(() => {
    if (!richMarkdown || !isVisible || loading) return;
    let cancelled = false;
    void getMarkdownRenderer()
      .then((renderer) => renderer.buildMarkdown(content))
      .then((rendered) => {
        if (!cancelled) {
          previewContentRef.current = content;
          setPreviewDoc(rendered);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => { cancelled = true; };
  }, [content, isVisible, richMarkdown, loading]);

  useEffect(() => {
    if (!markdownMode || lightweightDraft || !editing || !splitPreview || !isVisible) return;
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
  }, [editing, isVisible, markdownMode, lightweightDraft, previewDraft, splitPreview]);

  useEffect(() => {
    if (!editing || !jsonMode || deferJsonValidation) {
      setJsonValidation(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getJsonDocuments().then(async ({ validateJsonDocument }) => {
        if (cancelled) return;
        const result = await validateJsonDocument(draft, jsonMode);
        if (!cancelled) setJsonValidation(result);
      }).catch(() => { if (!cancelled) setJsonValidation(null); });
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
    if (zoomInputRef.current) zoomInputRef.current.value = String(zoom);
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
        loadedVersionRef.current = '';
        setError('');
        return;
      }
      const loaded = source === 'remote'
        ? await ReadRemoteTextFile(sessionId || '', remotePath || '')
        : await ReadLocalFile(filePath || '');
      if (generation !== loadGenerationRef.current) return;
      const text = loaded.content;
      loadedVersionRef.current = loaded.version;
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
      setActiveHeading('');
      setEditing(false);
      // A discard prompt and a conflict question both belong to the document
      // they were opened for.
      setConfirmDiscard(false);
      setConflictVersion(null);
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
    if (sourceView) {
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
    if (sourceView) {
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
  }, [editing, sourceView]);

  // Applies a scroll ratio that was captured before the editor finished
  // loading. Passed as the editor's ref callback so it runs on mount.
  const attachEditor = useCallback((handle: SourceEditorHandle | null) => {
    editorRef.current = handle;
    if (!handle) return;
    if (pendingScrollRatioRef.current == null) restore(true);
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
  }, [restore]);

  const startEdit = () => {
    remember();
    captureScrollRatio();
    draftRef.current = content;
    setDraft(content);
    setEditing(true);
  };

  const discardEdit = () => {
    setConfirmDiscard(false);
    formatControllerRef.current?.abort();
    captureScrollRatio();
    draftRef.current = content;
    setDraft(content);
    eolRef.current = loadedEol;
    setEol(loadedEol);
    setEditing(false);
    setSplitPreview(false);
  };

  const cancelEdit = () => {
    if (saveInFlightRef.current) return;
    // A native window.confirm would be the only one left in the application,
    // and it renders as a browser prompt ("wails.localhost says") rather than
    // as part of the app.
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    discardEdit();
  };

  const jsonErrorMessage = (validation: JsonValidationResult) => {
    if (validation.valid) return '';
    return t(lang, 'jsonInvalid', {
      line: String(validation.error.line),
      column: String(validation.error.column),
    });
  };

  const formatJson = async () => {
    if (!jsonMode || formatControllerRef.current || saveInFlightRef.current) return;
    const controller = new AbortController();
    formatControllerRef.current = controller;
    const snapshot = draftRef.current;
    setFormatting(true);
    try {
      const { formatJsonDocument } = await getJsonDocuments();
      const result = await formatJsonDocument(snapshot, jsonMode, controller.signal);
      controller.signal.throwIfAborted();
      if (documentTargetRef.current.key !== documentKey) return;
      if (!editingRef.current || draftRef.current !== snapshot) {
        onNotify?.(t(lang, 'documentFormatChanged'), 'info');
        return;
      }
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
    } catch (err) {
      if (!controller.signal.aborted) onNotify?.(documentErrorMessage(err, lang), 'error');
    } finally {
      if (formatControllerRef.current === controller) {
        formatControllerRef.current = null;
        setFormatting(false);
      }
    }
  };

  // expectedVersionOverride is how the overwrite branch of the conflict dialog
  // retries with the version the conflict reported. Everything else sends the
  // version the editor loaded.
  const save = (expectedVersionOverride?: string) => {
    // React state does not update synchronously, so `saving` alone cannot stop
    // two Ctrl+S/click events from starting writes in the same render frame.
    // Every caller joins the one in-flight operation instead.
    if (saveInFlightRef.current) return saveInFlightRef.current;

    formatControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    const snapshot = { draft: draftRef.current, eol: eolRef.current };
    // Schedule the body after the ref assignment below. Besides making the
    // same-frame de-duplication explicit, this also guarantees a synchronous
    // backend throw cannot run `finally` before the operation is registered.
    const operation = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        setSaving(true);
        if (jsonMode) {
          const { validateJsonDocument } = await getJsonDocuments();
          const validation = await validateJsonDocument(snapshot.draft, jsonMode, controller.signal);
          controller.signal.throwIfAborted();
          if (documentTargetRef.current.key !== documentKey) return false;
          if (draftRef.current === snapshot.draft) setJsonValidation(validation);
          if (!validation.valid) {
            onNotify?.(jsonErrorMessage(validation), 'error');
            return false;
          }
        }
        controller.signal.throwIfAborted();
        const target = documentTargetRef.current;
        if (target.key !== documentKey) return false;
        // Restore the selected line ending on the snapshot written to disk.
        // Resolve the transport after validation, as SSH may have reconnected
        // while a worker was parsing. Newer edits stay in draftRef/eolRef.
        const payload = applyEol(snapshot.draft, snapshot.eol);
        const expectedVersion = expectedVersionOverride ?? loadedVersionRef.current;
        const result = target.source === 'remote'
          ? await WriteRemoteTextFile(target.sessionId, target.path, payload, expectedVersion)
          : await WriteLocalFile(target.path, payload, expectedVersion);

        if (controller.signal.aborted || documentTargetRef.current.key !== documentKey) return false;
        if (result.conflict) {
          // The file changed on disk while this tab was open. Nothing was
          // written, so the draft is intact; ask which version to keep instead
          // of overwriting the other change without a word.
          lastConflictRef.current = result.version;
          setConflictVersion(result.version);
          return false;
        }
        lastConflictRef.current = null;
        loadedVersionRef.current = result.version;

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
      } catch (err) {
        if (!controller.signal.aborted) onNotify?.(documentErrorMessage(err, lang), 'error');
        return false;
      } finally {
        if (saveControllerRef.current === controller) {
          saveControllerRef.current = null;
          saveInFlightRef.current = null;
          setSaving(false);
        }
      }
    });

    saveInFlightRef.current = operation;
    return operation;
  };
  saveRef.current = save;

  const reloadConflict = () => {
    setConflictVersion(null);
    // Deliberate: the user chose the version on disk over their draft.
    void loadFile();
  };

  const overwriteConflict = async () => {
    const version = conflictVersion;
    if (version == null) return;
    await save(version);
    // A retry that conflicted again has already put a fresh version here, so
    // the question stays open with the version that actually won.
    setConflictVersion(lastConflictRef.current);
  };

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
    setMatchesLimited(false);
    setCurrent(0);
    rangesRef.current = [];
    editMatchesRef.current = new Uint32Array();
    pendingEditorRevealRef.current = null;
    // Reopening the find bar has to reveal the first match again, even when the
    // query text is unchanged.
    lastSearchQueryRef.current = null;
    revealTargetRef.current = null;
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
    if (!searchOpen || !active) {
      lastSearchQueryRef.current = null;
      return;
    }
    const q = query;
    // A rescan runs on every edit because the matches moved; only a new query
    // is allowed to jump the user to the first match.
    const queryChanged = lastSearchQueryRef.current !== q;
    lastSearchQueryRef.current = q;
    rangesRef.current = [];
    editMatchesRef.current = new Uint32Array();
    setMatchesLimited(false);
    clearHighlights();

    if (!q) {
      setMatchCount(0);
      setCurrent(0);
      pendingEditorRevealRef.current = null;
      return;
    }

    if (sourceView) {
      const text = editing ? draft : content;
      const find = () => {
        const found = findTextMatches(text, q);
        editMatchesRef.current = found.offsets;
        const count = found.offsets.length / 2;
        setMatchCount(count);
        setMatchesLimited(found.limited);
        setCurrent((previous) => (count ? (queryChanged ? 0 : clamp(previous, 0, count - 1)) : -1));
        setMatchRevision((revision) => revision + 1);
        if (!found.offsets.length) pendingEditorRevealRef.current = null;
      };
      if (text.length <= MAX_SYNC_JSON_CHARS) { find(); return; }
      setMatchCount(0);
      // Do not rescan a large document for every intermediate keystroke.
      const timer = window.setTimeout(find, 120);
      return () => window.clearTimeout(timer);
    }

    const root = contentRootRef.current;
    const reg = (CSS as any).highlights;
    if (!root || !reg) {
      setMatchCount(0);
      setCurrent(0);
      return;
    }
    let frame = 0;
    const rebuild = () => {
      frame = 0;
      const found = findPreviewRanges(root, q, MAX_SEARCH_MATCHES + 1);
      const ranges = found.slice(0, MAX_SEARCH_MATCHES);
      setMatchesLimited(found.length > MAX_SEARCH_MATCHES);
      rangesRef.current = ranges;
      reg.set(HL_ALL, new (window as any).Highlight(...ranges));
      reg.delete(HL_ACTIVE);
      setMatchCount(ranges.length);
      setCurrent((previous) => (ranges.length ? (queryChanged ? 0 : clamp(previous, 0, ranges.length - 1)) : -1));
      setMatchRevision((previous) => previous + 1);
    };
    rebuild();
    // Mermaid and lazy content finish after Markdown parsing. Refresh ranges
    // without forcing those renderers to run again or searching their CSS.
    const observer = new MutationObserver((mutations) => {
      if (mutations.every(({ target }) => (target instanceof Element ? target : target.parentElement)?.closest('[data-md-search-ignore]'))) return;
      if (!frame) frame = requestAnimationFrame(rebuild);
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [query, searchOpen, editing, sourceView, content, draft, active, visibleDoc.html]);

  useEffect(() => {
    if (!searchOpen || !active || current < 0) return;

    // matchRevision is a dependency because a rescan replaces the Range objects,
    // so the active highlight has to be re-applied to the new ones. It must not
    // move anything, though: while editing, a rescan happens on every keystroke
    // and re-revealing each time would drag the caret to the first match.
    const target = `${query}\u0000${current}`;
    const moved = revealTargetRef.current !== target;
    revealTargetRef.current = target;

    if (sourceView) {
      const offsets = editMatchesRef.current;
      if (current * 2 >= offsets.length) {
        pendingEditorRevealRef.current = null;
        return;
      }
      // A rescan must not touch the pending-reveal slot either: attachEditor
      // consumes it whenever the editor re-attaches, so refilling it here would
      // reveal on every keystroke by the back door.
      if (!moved) return;
      const m = { start: offsets[current * 2], end: offsets[current * 2 + 1] };
      // Leave the slot set for a lazily mounted editor to consume.
      pendingEditorRevealRef.current = m;
      // CodeMirror owns scrolling and selection, so hand it the range and let
      // it center the match rather than computing a scrollTop from line height.
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
    if (!moved) return;
    const container = range.startContainer.parentElement;
    container?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [current, matchCount, matchRevision, query, searchOpen, editing, sourceView, active, draft]);

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
      if (e.isComposing || e.keyCode === 229 || hasActiveOverlay()) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !editing && !pdfMode) {
        const target = e.target;
        const nativeSelectionTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
        if (!nativeSelectionTarget && virtualTextPreview && editorRef.current) {
          editorRef.current.selectAll();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
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
      } else if (e.key === 'Escape' && compactReading && compactTocOpen) {
        e.preventDefault();
        setCompactTocOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, compactReading, compactTocOpen, editing, pdfMode, virtualTextPreview, searchOpen, openSearch, closeSearch]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  };

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
    if (!(e.target instanceof Element)) return;

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

    const anchor = e.target.closest('a[href]') as HTMLAnchorElement | null;

    // In-page fragment. Anchors that carry data-md-link use href="#" as a
    // placeholder and are handled below, so they are excluded here.
    if (anchor && !anchor.dataset.mdLink && (anchor.getAttribute('href') || '').startsWith('#')) {
      e.preventDefault();
      const fragment = anchor.getAttribute('href')?.slice(1) || '';
      let id = fragment;
      try { id = decodeURIComponent(fragment); } catch { /* Handwritten anchors may contain a literal %. */ }
      // Resolved by slug, not by a bare `#id` selector: a heading whose slug
      // is a DOM property name (`## Scripts`) has a prefixed DOM id, and this
      // is also the path a hand-written `[jump](#scripts)` link takes.
      const el = findHeadingElement(contentRootRef.current, id);
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }

    const markdownLink = e.target.closest('a[data-md-link]') as HTMLAnchorElement | null;
    const href = markdownLink?.dataset.mdLink;
    if (markdownLink && href) {
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
      return;
    }

    if (!anchor) return;
    const rawHref = anchor.getAttribute('href') || '';

    // http(s)/mailto: hand the URL to the system browser. Left alone, the
    // WebView would navigate to it itself.
    if (/^(https?:|mailto:)/i.test(rawHref)) {
      e.preventDefault();
      BrowserOpenURL(rawHref);
      return;
    }

    // Anything else is a link the viewer has no handler for: a relative
    // reference to a file it cannot open (LICENSE, config.example.yaml), or a
    // scheme it does not route. The window is frameless, so allowing the
    // default navigation would replace the app with that resource — no way
    // back, and every unsaved draft lost.
    e.preventDefault();
    onNotify?.(t(lang, 'documentLinkUnsupported'), 'info');
  }, [filePath, isVisible, lang, markdownMode, onNotify, onOpenMarkdownFile, remotePath, sessionId, source]);

  const jumpToHeading = useCallback((id: string) => {
    const heading = textHeadings.find((item) => item.id === id);
    if (!editing && virtualTextPreview && heading?.from != null) {
      editorRef.current?.revealRange(heading.from, heading.from);
      setActiveHeading(id);
    } else {
      const el = findHeadingElement(contentRootRef.current, id);
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (compactReading) setCompactTocOpen(false);
  }, [compactReading, editing, textHeadings, virtualTextPreview]);

  const onSourceScroll = useCallback(() => {
    remember();
    syncSplitPreviewScroll();
    if (editing || !textHeadings.length) return;
    const position = editorRef.current?.scrollPosition();
    if (!position) return;
    let low = 0;
    let high = textHeadings.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (textHeadings[mid].from! <= position.anchor) low = mid;
      else high = mid - 1;
    }
    setActiveHeading(textHeadings[low].id);
  }, [remember, syncSplitPreviewScroll, editing, textHeadings]);

  useEffect(() => {
    if (!active) return;
    outlineCallbackRef.current?.(documentId || documentKey, canShowToc ? {
      items: outlineItems,
      activeId: activeHeading || outlineItems[0]?.id || '',
      navigate: jumpToHeading,
      truncated: virtualTextPreview && textHeadings.length >= MAX_DOCUMENT_HEADINGS,
    } : null);
  }, [active, documentId, documentKey, canShowToc, outlineItems, activeHeading, jumpToHeading, textHeadings.length, virtualTextPreview]);

  useEffect(() => {
    if (!active) return;
    return () => outlineCallbackRef.current?.(documentId || documentKey, null);
  }, [active, documentId, documentKey]);

  const previewZoom = useCallback((next: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const ratio = next / committedZoomRef.current;
    viewer.style.setProperty('--md-live-scale', String(ratio));
    viewer.classList.add('markdown-viewer-zooming');
  }, []);

  const onZoomPointerDown = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    beforeLayoutChange();
    zoomGestureRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [beforeLayoutChange]);

  const commitZoomGesture = useCallback((input: HTMLInputElement) => {
    zoomGestureRef.current = false;
    const next = clamp(Number(input.value), MIN_ZOOM, MAX_ZOOM);
    if (next === committedZoomRef.current) {
      const viewer = viewerRef.current;
      viewer?.classList.remove('markdown-viewer-zooming');
      viewer?.style.removeProperty('--md-live-scale');
      restore();
      return;
    }
    updateDocumentAppearance({ zoom: next });
  }, [restore]);

  const cancelZoomGesture = useCallback((input: HTMLInputElement) => {
    zoomGestureRef.current = false;
    input.value = String(committedZoomRef.current);
    const viewer = viewerRef.current;
    viewer?.classList.remove('markdown-viewer-zooming');
    viewer?.style.removeProperty('--md-live-scale');
    restore();
  }, [restore]);

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
    const scroller = editing && splitPreview ? splitPreviewRef.current : previewRef.current;
    const root = contentRootRef.current;
    if (!isVisible || !scroller || !root || !canShowToc) {
      if (!editing && virtualTextPreview && textHeadings.length) return;
      setActiveHeading('');
      return;
    }
    let frame = 0;
    let headings: Array<{ id: string; top: number }> = [];
    const measureHeadings = () => {
      headings = Array.from(root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
        // The slug, not the prefixed DOM id: `activeHeading` is compared
        // against the outline entries, which are keyed by slug.
        .map((heading) => ({ id: headingSlugOf(heading), top: heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop }));
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
  }, [canShowToc, editing, isVisible, splitPreview, visibleDoc.html, zoom, virtualTextPreview, textHeadings.length]);

  if (loading) return <div className="markdown-viewer-loading">{t(lang, "loading")}</div>;
  if (error) return <div className="markdown-viewer-error">{documentErrorMessage(error, lang)}</div>;

  return (
    <div
      className={clsx('markdown-viewer', compactReading && 'markdown-viewer-compact')}
      ref={viewerRef}
      data-active={active ? 'true' : 'false'}
      data-visible={isVisible ? 'true' : 'false'}
      data-document-path={displayPath}
      data-presentation={presentation}
    >
      {/* Keep file type and reading actions in their own row. */}
      <div className="markdown-viewer-toolbar">
        <span className="markdown-viewer-toolbar-name" title={displayPath || ''}>
          {typeLabel}
        </span>
        <span className="markdown-viewer-toolbar-spacer" />
        {!pdfMode && <div className="markdown-viewer-appearance" ref={appearanceRef}>
          <button
            ref={appearanceButtonRef}
            type="button"
            className={clsx('markdown-viewer-appearance-button', appearanceOpen && 'active')}
            onClick={() => setAppearanceOpen((open) => !open)}
            aria-label={t(lang, 'documentAppearance')}
            title={t(lang, 'documentAppearance')}
            aria-expanded={appearanceOpen}
            aria-haspopup="dialog"
          ><Type size={15} /><span>{Math.round(zoom * 100)}%</span></button>
          {appearanceOpen && <div className="markdown-appearance-popover" role="dialog" aria-label={t(lang, 'documentAppearance')}>
            <div className="markdown-appearance-label">
              <span>{t(lang, 'documentZoom')}</span>
              <button
                type="button"
                className="markdown-viewer-zoom-reset"
                onClick={() => { beforeLayoutChange(); updateDocumentAppearance({ zoom: 1 }); }}
                title={t(lang, 'documentZoomResetTitle')}
                aria-label={t(lang, 'documentZoomReset')}
              >{Math.round(zoom * 100)}%</button>
            </div>
            <input
              ref={zoomInputRef}
              type="range"
              className="markdown-viewer-zoom"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.05}
              defaultValue={zoom}
              aria-label={t(lang, 'documentZoom')}
              title={t(lang, 'documentZoomPercent', { percent: String(Math.round(zoom * 100)) })}
              onPointerDown={onZoomPointerDown}
              onInput={(e) => {
                const next = Number(e.currentTarget.value);
                e.currentTarget.title = t(lang, 'documentZoomPercent', { percent: String(Math.round(next * 100)) });
                if (zoomGestureRef.current) previewZoom(next);
              }}
              onChange={(e) => {
                if (!zoomGestureRef.current) {
                  beforeLayoutChange();
                  updateDocumentAppearance({ zoom: Number(e.currentTarget.value) });
                }
              }}
              onPointerUp={(e) => commitZoomGesture(e.currentTarget)}
              onPointerCancel={(e) => cancelZoomGesture(e.currentTarget)}
            />
            {!editing && (presentation === 'prose' || richMarkdown) && <>
              <label className="markdown-appearance-label">
                <span>{t(lang, 'documentLineHeight')}</span>
                <select aria-label={t(lang, 'documentLineHeight')} value={leading} onChange={(event) => { beforeLayoutChange(); updateDocumentAppearance({ leading: Number(event.target.value) }); }}>
                  <option value={1.5}>{t(lang, 'documentLeadingCompact')}</option>
                  <option value={1.85}>{t(lang, 'documentLeadingNormal')}</option>
                  <option value={2.1}>{t(lang, 'documentLeadingRelaxed')}</option>
                </select>
              </label>
              <label className="markdown-appearance-label">
                <span>{t(lang, 'documentLineWidth')}</span>
                <select aria-label={t(lang, 'documentLineWidth')} value={column} onChange={(event) => { beforeLayoutChange(); updateDocumentAppearance({ width: event.target.value as DocumentAppearance['width'] }); }}>
                  <option value="comfortable">{t(lang, 'documentWidthComfortable')}</option>
                  <option value="wide">{t(lang, 'documentWidthWide')}</option>
                  <option value="full">{t(lang, 'documentWidthFull')}</option>
                </select>
              </label>
            </>}
            {(editing || presentation !== 'prose') && <label className="markdown-appearance-label">
              <span>{t(lang, markdownMode ? 'wrapCode' : 'wrapText')}</span>
              <input type="checkbox" checked={wrapCode} onChange={() => { beforeLayoutChange(); setWrapCode((value) => !value); }} />
            </label>}
          </div>}
        </div>}
        {!pdfMode && <button
          type="button"
          onClick={openSearch}
          className={clsx('markdown-viewer-tbtn', searchOpen && 'active')}
          title={`${t(lang, 'find')} (Ctrl+F)`}
          aria-label={t(lang, 'find')}
        ><Search size={15} /></button>}
        {!pdfMode && !outlineInSidebar && canShowToc && <button
          onClick={toggleOutline}
          className={clsx('markdown-viewer-tbtn', outlineOpen && canShowToc && 'active')}
          disabled={!canShowToc}
          aria-expanded={outlineOpen && canShowToc}
          title={t(lang, "outline")}
        >
          <ListTree size={15} />
        </button>}
        {markdownMode && !lightweightDraft && editing && (
          <button
            onClick={() => setSplitPreview((v) => !v)}
            className={clsx('markdown-viewer-tbtn', splitPreview && 'active')}
            title={t(lang, 'documentSplitPreview')}
          >
            <Columns2 size={15} />
          </button>
        )}
        {jsonMode && editing && (
          <button onClick={formatJson} className="markdown-viewer-tbtn" disabled={formatting || saving} title={t(lang, 'formatJson')}>
            <Braces size={15} />
          </button>
        )}
        {pdfMode ? (
          <>
            <button onClick={() => { beforeLayoutChange(); void loadFile(); }} className="markdown-viewer-tbtn" title={t(lang, 'refresh')}>
              <RefreshCw size={15} />
            </button>
            <button onClick={onClose} className="markdown-viewer-tbtn" title={t(lang, 'close')}>
              <X size={15} />
            </button>
          </>
        ) : editing ? (
          <>
            <button onClick={() => { void save(); }} className="markdown-viewer-tbtn" disabled={saving || formatting || jsonValidation?.valid === false} title={`${t(lang, 'save')} (Ctrl+S)`}>
              <Save size={15} />
            </button>
            <button onClick={cancelEdit} className="markdown-viewer-tbtn" disabled={saving} title={t(lang, 'cancel')}>
              <X size={15} />
            </button>
          </>
        ) : (
          <>
            <button onClick={startEdit} className="markdown-viewer-tbtn" title={t(lang, 'documentEdit')}>
              <Pencil size={15} />
            </button>
            <button onClick={() => { beforeLayoutChange(); void loadFile(); }} className="markdown-viewer-tbtn" title={t(lang, 'refresh')}>
              <RefreshCw size={15} />
            </button>
            <button onClick={onClose} className="markdown-viewer-tbtn" title={t(lang, 'close')}>
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
            {matchCount ? (current + 1) + '/' + matchCount + (matchesLimited ? '+' : '') : (query ? '0/0' : '')}
          </span>
          <button className="markdown-viewer-tbtn" onClick={goPrev} disabled={!matchCount} title={t(lang, 'documentPreviousMatch')}>
            <ChevronUp size={15} />
          </button>
          <button className="markdown-viewer-tbtn" onClick={goNext} disabled={!matchCount} title={t(lang, 'documentNextMatch')}>
            <ChevronDown size={15} />
          </button>
          <button className="markdown-viewer-tbtn" onClick={closeSearch} title={t(lang, "closeEsc")}>
            <X size={15} />
          </button>
        </div>
      )}

      <div ref={viewerMainRef} className={clsx('markdown-viewer-main', canShowToc && outlineOpen && !outlineInSidebar && 'with-toc')} style={viewerMainStyle}>
        {canShowToc && outlineOpen && !outlineInSidebar && (
          <aside className="markdown-viewer-outline">
            <div className="markdown-outline-header">
              <span>{t(lang, "outline")}</span>
              <button className="markdown-outline-close" onClick={closeOutline} title={t(lang, "hideOutline")}>
                <X size={13} />
              </button>
            </div>
            <div className="markdown-outline-list">
              {outlineItems.map((item) => (
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
        ) : sourceView ? (
          <div className={clsx('markdown-viewer-edit-shell', !editing && 'text-document-virtual', editing && splitPreview && !lightweightDraft && 'markdown-viewer-edit-split')}>
            <Suspense fallback={<div className="markdown-viewer-loading">{t(lang, 'loading')}</div>}>
              <SourceEditor
                key={editing ? 'edit' : 'preview'}
                handleRef={attachEditor}
                value={editing ? draft : content}
                readOnly={!editing}
                ariaLabel={!editing ? t(lang, 'documentReadOnlyPreview') : undefined}
                onChange={(next) => {
                  if (!editing) return;
                  draftRef.current = next;
                  setDraft(next);
                }}
                onSave={save}
                onStats={editing ? setEditorStats : undefined}
                onScroll={onSourceScroll}
                // The base font size is scaled by the same zoom slider the
                // preview uses, so both modes track one control.
                fontSize={Math.round((editing ? 14 : presentation === 'prose' ? 17 : 14) * zoom)}
                wrap={!editing && presentation === 'prose' ? true : wrapCode}
                mode={editorMode}
                sourcePath={displayPath}
                presentation={presentation}
                headings={textHeadings}
                lineHeight={!editing && presentation === 'prose' ? leading : 1.65}
                columnWidth={readingColumn}
              />
            </Suspense>
            {markdownMode && splitPreview && !lightweightDraft && (
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
          <div className="markdown-viewer-content" ref={previewRef} onScroll={remember}>
              <div
                ref={contentRootRef as React.RefObject<HTMLDivElement>}
                tabIndex={0}
                className={clsx('ai-markdown', 'md-document', wrapCode && 'md-wrap-code')}
                style={{ zoom, lineHeight: leading, maxWidth: readingColumn }}
                onClick={onContentClick}
                dangerouslySetInnerHTML={{ __html: previewDoc.html }}
              />
          </div>
        )}
      </div>

      {richMarkdown && <MermaidDiagrams
        rootRef={contentRootRef}
        html={visibleDoc.html}
        visible={!!isVisible && (!editing || splitPreview)}
        previewKey={`${documentKey}:${editing}:${splitPreview}`}
        locale={lang}
        onNotify={onNotify}
      />}

      {!editing && !pdfMode && <div className="document-reading-status">
        <span className="document-reading-path" title={displayPath}>{displayPath}</span>
        {lightweightMarkdown && <span role="status">{t(lang, 'documentLightweightPreview')}</span>}
        <span>{t(lang, 'documentCharacterCount', { count: content.length.toLocaleString(lang) })}</span>
        <span>UTF-8</span>
      </div>}

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
          {(formatting || saving) && <span className="source-editor-status-item" role="status">{t(lang, 'documentProcessing')}</span>}
          {jsonMode && deferJsonValidation && !formatting && !saving && (
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

      {confirmDiscard && (
        <ConfirmDialog
          locale={lang}
          title={t(lang, 'discardChangesTitle')}
          body={t(lang, 'discardChanges')}
          confirmText={t(lang, 'confirm')}
          onConfirm={discardEdit}
          onClose={() => setConfirmDiscard(false)}
        />
      )}

      {conflictVersion !== null && (
        <DocumentConflictDialog
          locale={lang}
          busy={saving}
          onReload={reloadConflict}
          onOverwrite={overwriteConflict}
          onKeepEditing={() => setConflictVersion(null)}
        />
      )}
    </div>
  );
}
