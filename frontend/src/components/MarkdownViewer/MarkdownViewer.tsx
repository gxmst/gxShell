import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Pencil, Save, RefreshCw, X, ChevronUp, ChevronDown } from 'lucide-react';
import { ReadLocalFile, WriteLocalFile } from '../../../wailsjs/go/main/App';

interface MarkdownViewerProps {
  filePath: string;
  // active is true only for the visible/foreground tab. The viewer owns Ctrl+F
  // (suppressing the browser's native find and the app's terminal search) only
  // while active, so background markdown tabs never steal the shortcut.
  active?: boolean;
  onClose: () => void;
  onNotify?: (text: string, tone?: 'info' | 'error' | 'success') => void;
}

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.2;
const HL_ALL = 'md-search';
const HL_ACTIVE = 'md-search-active';

// Highlights live on the document-global CSS.highlights registry, so only the
// active viewer ever writes to them; clearing removes both this viewer's sets.
function clearHighlights() {
  const reg = (CSS as any).highlights;
  if (!reg) return;
  reg.delete(HL_ALL);
  reg.delete(HL_ACTIVE);
}

export default function MarkdownViewer({ filePath, active, onClose, onNotify }: MarkdownViewerProps) {
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [current, setCurrent] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const editMatchesRef = useRef<{ start: number; end: number }[]>([]);
  const pendingScrollRatioRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const loadFile = useCallback(async () => {
    try {
      setLoading(true);
      const text = await ReadLocalFile(filePath);
      setContent(text);
      setDraft(text);
      setError('');
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    setEditing(false);
    loadFile();
  }, [loadFile]);

  const dirty = editing && draft !== content;

  // captureScrollRatio records how far down the currently shown scroller is, as
  // a 0..1 ratio, so toggling between preview and editor can land at the same
  // relative position instead of snapping to the top.
  const captureScrollRatio = () => {
    const el = editing ? textareaRef.current : previewRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    pendingScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0;
  };

  // After the mode switch re-mounts the other element, restore the ratio. Done
  // in a layout effect so the user never sees the intermediate top position.
  useLayoutEffect(() => {
    const ratio = pendingScrollRatioRef.current;
    if (ratio == null) return;
    pendingScrollRatioRef.current = null;
    const el = editing ? textareaRef.current : previewRef.current;
    if (!el) return;
    if (editing) {
      // Focus first (without its default scroll-to-caret) so the manual
      // scrollTop below is what sticks.
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
  };

  const save = async () => {
    try {
      setSaving(true);
      await WriteLocalFile(filePath, draft);
      captureScrollRatio();
      setContent(draft);
      setEditing(false);
      onNotify?.('File saved', 'success');
    } catch (err: any) {
      onNotify?.(err.toString(), 'error');
    } finally {
      setSaving(false);
    }
  };

  // --- Search ---------------------------------------------------------------

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Defer focus so the input exists; select any prior query for quick replace.
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

  // A background tab must not keep the global Ctrl+F or leave stray highlights.
  useEffect(() => {
    if (!active && searchOpen) closeSearch();
  }, [active, searchOpen, closeSearch]);

  useEffect(() => {
    return () => {
      // Only the active viewer can own the highlight registry, so only it clears.
      if (activeRef.current) clearHighlights();
    };
  }, []);

  // Build the match set whenever the query, content, or mode changes.
  useEffect(() => {
    if (!searchOpen || !active) return;
    const q = query;
    rangesRef.current = [];
    editMatchesRef.current = [];
    // Drop any prior highlights up front so a stale "active" match can never
    // outlive the query that produced it.
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

    // Preview mode: walk text nodes and build Ranges for the Highlight API.
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

  // Apply the "current match" emphasis and scroll it into view.
  useEffect(() => {
    if (!searchOpen || !active || current < 0) return;

    if (editing) {
      const m = editMatchesRef.current[current];
      const ta = textareaRef.current;
      if (!m || !ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(m.start, m.end);
      // Approximate the line so we can center it in the textarea viewport.
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

  // Ctrl+F opens the in-document search and blocks the native/terminal search,
  // but only for the foreground tab.
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
    // Capture phase so we win over the window-level terminal-search hotkey.
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

  // Ctrl+S to save while editing.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  };

  const renderMarkdown = () => {
    const rawHtml = marked.parse(content) as string;
    const html = DOMPurify.sanitize(rawHtml);
    return { __html: html };
  };

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

      {editing ? (
        <textarea
          ref={textareaRef}
          className="markdown-viewer-editor"
          style={{ zoom: zoom }}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <div className="markdown-viewer-content" ref={previewRef}>
          <div
            ref={contentRootRef}
            className="ai-markdown"
            style={{ zoom: zoom }}
            dangerouslySetInnerHTML={renderMarkdown()}
          />
        </div>
      )}
    </div>
  );
}
