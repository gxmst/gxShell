import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Code, Copy, Maximize2, Minus, Plus, RefreshCw, ScanLine, X } from 'lucide-react';
import { ModalShell } from '../modals/ModalShell';
import { writeClipboardText } from '../../utils/clipboard';
import { t } from '../../i18n';
import { mermaidThemeFor, renderMermaid, type MermaidDrawing, type MermaidTheme } from './mermaidRenderer';

type Notify = (message: string, tone?: 'info' | 'error' | 'success') => void;
type DiagramState = { status: 'loading' } | { status: 'ready'; drawing: MermaidDrawing } | { status: 'error'; message: string };

function sourceFor(host: HTMLElement) {
  try { return decodeURIComponent(host.dataset.mermaidSource || ''); } catch { return ''; }
}

function MermaidDiagram({ host, source, theme, index, zh, visible, onNotify }: {
  host: HTMLElement; source: string; theme: MermaidTheme; index: number; zh: boolean; visible: boolean; onNotify?: Notify;
}) {
  const language = zh ? 'zh-CN' : 'en';
  const [state, setState] = useState<DiagramState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [copied, setCopied] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastRender = useRef<{ source: string; theme: MermaidTheme; attempt: number; drawing: MermaidDrawing }>();
  const inlineView = useRef<{ zoom: number | null; top: number; left: number }>({ zoom: null, top: 0, left: 0 });
  const restoreInlineScroll = useRef(false);
  const title = t(language, "diagramTitle", { count: String(index + 1) });

  useEffect(() => {
    if (!visible) return;
    // Successful drawings survive tab switches; an interrupted render retries.
    const previous = lastRender.current;
    if (previous?.source === source && previous.theme === theme && previous.attempt === attempt) {
      setState({ status: 'ready', drawing: previous.drawing });
      host.dataset.mdRendered = 'true';
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    host.dataset.mdRendered = 'pending';
    void renderMermaid(source, theme, controller.signal).then((drawing) => {
      if (!drawing || controller.signal.aborted) return;
      lastRender.current = { source, theme, attempt, drawing };
      host.dataset.mdRendered = 'true';
      setState({ status: 'ready', drawing });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      host.dataset.mdRendered = 'error';
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [attempt, host, source, theme, visible]);

  useEffect(() => {
    if (!visible && expanded) {
      setExpanded(false);
      setZoom(inlineView.current.zoom);
      restoreInlineScroll.current = true;
    }
  }, [expanded, visible]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setAvailableWidth(Math.max(0, viewport.clientWidth - 32));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded, showSource, state.status, visible]);

  useLayoutEffect(() => {
    if (expanded || !visible || !restoreInlineScroll.current || !viewportRef.current) return;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollTop = inlineView.current.top;
      viewport.scrollLeft = inlineView.current.left;
      restoreInlineScroll.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, showSource, state.status, visible]);

  const drawing = state.status === 'ready' ? state.drawing : null;
  const fitScale = drawing && availableWidth > 0 ? Math.min(1, availableWidth / drawing.width) : 1;
  const scale = zoom ?? fitScale;
  const changeZoom = (delta: number) => setZoom(Math.min(4, Math.max(0.1, Math.round((scale + delta) * 100) / 100)));
  const openExpanded = () => {
    inlineView.current = { zoom, top: viewportRef.current?.scrollTop || 0, left: viewportRef.current?.scrollLeft || 0 };
    setPlaceholderHeight(host.clientHeight);
    setExpanded(true);
    setZoom(null);
  };
  const closeExpanded = () => {
    restoreInlineScroll.current = true;
    setExpanded(false);
    setZoom(inlineView.current.zoom);
  };
  const copySource = async () => {
    try {
      await writeClipboardText(source);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      onNotify?.(t(language, "diagramCopyFailed"), 'error');
    }
  };

  const diagram = <section className="md-diagram" aria-label={title} data-theme-mode={theme}>
    <div className="md-diagram-toolbar" data-md-search-ignore>
      <span className="md-diagram-title">Mermaid</span>
      <div className="md-diagram-controls">
        <button type="button" disabled={!drawing || showSource || scale <= 0.1} onClick={() => changeZoom(-0.2)} title={t(language, "diagramZoomOut")} aria-label={t(language, "diagramZoomOut")}><Minus size={14} /></button>
        <button type="button" className="md-diagram-percent" disabled={!drawing || showSource} onClick={() => setZoom(1)} title={t(language, "diagramActualSize")}>{Math.round(scale * 100)}%</button>
        <button type="button" disabled={!drawing || showSource || scale >= 4} onClick={() => changeZoom(0.2)} title={t(language, "diagramZoomIn")} aria-label={t(language, "diagramZoomIn")}><Plus size={14} /></button>
        <button type="button" disabled={!drawing || showSource} onClick={() => setZoom(null)} aria-pressed={zoom === null} title={t(language, "diagramFitWidth")} aria-label={t(language, "diagramFitWidth")}><ScanLine size={14} /></button>
        <button type="button" onClick={() => setShowSource((value) => !value)} aria-pressed={showSource} title={t(language, "diagramViewSource")}><Code size={14} /><span>{t(language, "diagramSourceToggle")}</span></button>
        <button type="button" onClick={copySource} title={t(language, "diagramCopySource")} aria-label={t(language, "diagramCopySource")}>{copied ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{copied ? (t(language, "diagramCopied")) : ''}</span></button>
        {expanded
          ? <button type="button" onClick={closeExpanded} title={t(language, "diagramCloseHint")} aria-label={t(language, "diagramClose")}><X size={15} /></button>
          : <button type="button" disabled={!drawing && state.status !== 'error'} onClick={openExpanded} title={t(language, "diagramExpand")} aria-label={t(language, "diagramExpand")}><Maximize2 size={14} /></button>}
      </div>
    </div>
    {state.status === 'loading' && <div className="md-diagram-status" role="status">{t(language, "diagramRendering")}</div>}
    {state.status === 'error' && <div className="md-diagram-error" role="status">
      <strong>{t(language, "diagramRenderFailed")}</strong>
      <pre>{state.message}</pre>
      <button type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} />{t(language, "diagramRetry")}</button>
    </div>}
    {showSource || state.status === 'error'
      ? <pre className="md-diagram-source" tabIndex={0} aria-label={t(language, "diagramSource")}><code>{source}</code></pre>
      : drawing && <div ref={viewportRef} className="md-diagram-viewport" tabIndex={0} role="region" aria-label={t(language, "diagramScrollable")}>
        <div className="md-diagram-svg" style={{ width: drawing.width * scale, height: drawing.height * scale }} dangerouslySetInnerHTML={{ __html: drawing.svg }} />
      </div>}
    {drawing && !showSource && !expanded && scale < 0.6 && <button type="button" className="md-diagram-expand-hint" data-md-search-ignore onClick={openExpanded}>
      <Maximize2 size={13} />{t(language, "diagramExpandHint")}
    </button>}
  </section>;

  // Render a single SVG instance. Duplicating it into a dialog would duplicate
  // marker/label IDs and break references in some browsers.
  return expanded && visible ? <>
    <div className="md-diagram-status" style={{ height: placeholderHeight }}>{t(language, "diagramExpanded")}</div>
    <ModalShell className="md-diagram-modal" ariaLabel={title} onClose={closeExpanded}>{diagram}</ModalShell>
  </> : diagram;
}

export function MermaidDiagrams({ rootRef, html, visible, previewKey, locale, onNotify }: {
  rootRef: RefObject<HTMLElement>; html: string; visible: boolean; previewKey: string; locale: string; onNotify?: Notify;
}) {
  const [hosts, setHosts] = useState<HTMLElement[]>([]);
  const [theme, setTheme] = useState<MermaidTheme>('default');
  const knownHosts = useRef(new WeakSet<HTMLElement>());

  useLayoutEffect(() => {
    const root = rootRef.current;
    const blocks = Array.from(root?.querySelectorAll<HTMLElement>('.md-mermaid') || []);
    for (const block of blocks) {
      if (!knownHosts.current.has(block)) {
        block.replaceChildren();
        knownHosts.current.add(block);
      }
    }
    setHosts(blocks);
    const shell = root?.closest('[data-theme]');
    const updateTheme = () => setTheme(mermaidThemeFor(root));
    updateTheme();
    if (!shell) return;
    const observer = new MutationObserver(updateTheme);
    observer.observe(shell, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [html, previewKey, rootRef, visible]);

  return <>{hosts.map((host, index) => createPortal(
    <MermaidDiagram host={host} source={sourceFor(host)} theme={theme} index={index} zh={locale === 'zh-CN'} visible={visible} onNotify={onNotify} />,
    host,
    String(index),
  ))}</>;
}
