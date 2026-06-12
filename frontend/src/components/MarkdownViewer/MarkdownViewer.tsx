import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Pencil, Save, RefreshCw, X } from 'lucide-react';
import { ReadLocalFile, WriteLocalFile } from '../../../wailsjs/go/main/App';

interface MarkdownViewerProps {
  filePath: string;
  onClose: () => void;
  onNotify?: (text: string, tone?: 'info' | 'error' | 'success') => void;
}

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.2;

export default function MarkdownViewer({ filePath, onClose, onNotify }: MarkdownViewerProps) {
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  const dirty = editing && draft !== content;

  const startEdit = () => {
    setDraft(content);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setDraft(content);
    setEditing(false);
  };

  const save = async () => {
    try {
      setSaving(true);
      await WriteLocalFile(filePath, draft);
      setContent(draft);
      setEditing(false);
      onNotify?.('File saved', 'success');
    } catch (err: any) {
      onNotify?.(err.toString(), 'error');
    } finally {
      setSaving(false);
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
        <div className="markdown-viewer-content">
          <div
            className="ai-markdown"
            style={{ zoom: zoom }}
            dangerouslySetInnerHTML={renderMarkdown()}
          />
        </div>
      )}
    </div>
  );
}
