import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { readDocumentPosition, writeDocumentPosition, type DocumentScrollPosition } from '../../utils/documentReadingState';
import type { SourceEditorHandle } from './SourceEditor';

interface ReadingPositionOptions {
  identity: string;
  ready: boolean;
  visible: boolean;
  editing: boolean;
  sourceView: boolean;
  revision: unknown;
  layout: string;
  editor: RefObject<SourceEditorHandle>;
  scroller: RefObject<HTMLDivElement>;
  root: RefObject<HTMLElement>;
  viewer: RefObject<HTMLDivElement>;
}

export function useReadingPosition(options: ReadingPositionOptions) {
  const latest = useRef(options);
  latest.current = options;
  const position = useRef<DocumentScrollPosition | null>(null);
  const pending = useRef(true);
  const timer = useRef(0);
  const settleFrame = useRef(0);
  const restoring = useRef(false);
  const blocks = useRef<HTMLElement[]>([]);

  const capture = useCallback(() => {
    const state = latest.current;
    if (!state.ready || !state.visible) return null;
    if (state.sourceView) return state.editor.current?.scrollPosition() ?? null;
    const scroller = state.scroller.current;
    if (!scroller) return null;
    const top = scroller.getBoundingClientRect().top;
    const children = blocks.current;
    let low = 0;
    let high = children.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (children[mid].getBoundingClientRect().top <= top + 1) low = mid;
      else high = mid - 1;
    }
    const max = scroller.scrollHeight - scroller.clientHeight;
    return {
      kind: 'html' as const,
      anchor: low,
      offset: children[low] ? children[low].getBoundingClientRect().top - top : 0,
      ratio: max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0,
      left: scroller.scrollLeft,
    };
  }, []);

  const restore = useCallback((newView = false) => {
    const state = latest.current;
    if (state.editing) { pending.current = false; return; }
    // StrictMode can recreate the lazily mounted editor after its first
    // handle has consumed the pending restore. Every new view needs the saved
    // anchor, while ordinary rerenders must leave the user's scrolling alone.
    if (newView) pending.current = true;
    if (!pending.current || !state.ready || !state.visible) return;
    const saved = position.current;
    if (state.sourceView && !state.editor.current) return;
    if (!state.sourceView && !state.scroller.current) return;
    pending.current = false;
    if (!saved) return;
    restoring.current = true;
    if (state.sourceView) {
      state.editor.current?.setScrollPosition(saved);
    } else {
      const scroller = state.scroller.current!;
      const block = saved.kind === 'html' ? blocks.current[Math.min(Math.floor(saved.anchor), blocks.current.length - 1)] : null;
      if (block) scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
      else scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * saved.ratio;
      scroller.scrollLeft = saved.left;
    }
    cancelAnimationFrame(settleFrame.current);
    settleFrame.current = requestAnimationFrame(() => {
      settleFrame.current = requestAnimationFrame(() => { restoring.current = false; });
    });
  }, []);

  const remember = useCallback(() => {
    const state = latest.current;
    if (state.editing || pending.current || restoring.current) return;
    const next = capture();
    if (!next) return;
    position.current = next;
    window.clearTimeout(timer.current);
    const identity = state.identity;
    timer.current = window.setTimeout(() => writeDocumentPosition(identity, next), 250);
  }, [capture]);

  const beforeLayoutChange = useCallback(() => {
    const next = capture();
    if (next) position.current = next;
    pending.current = true;
  }, [capture]);

  useLayoutEffect(() => {
    position.current = readDocumentPosition(options.identity);
    pending.current = true;
    restoring.current = false;
    return () => {
      window.clearTimeout(timer.current);
      cancelAnimationFrame(settleFrame.current);
      if (position.current) writeDocumentPosition(options.identity, position.current);
    };
  }, [options.identity]);

  useLayoutEffect(() => {
    blocks.current = options.root.current ? Array.from(options.root.current.children).filter((node): node is HTMLElement => node instanceof HTMLElement) : [];
    restore();
  }, [options.ready, options.visible, options.sourceView, options.editing, options.revision, options.layout, options.identity, options.root, restore]);

  useEffect(() => {
    const viewer = options.viewer.current;
    if (!viewer || !options.ready) return;
    let width = viewer.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = viewer.clientWidth;
      if (nextWidth <= 0 || nextWidth === width) return;
      width = nextWidth;
      if (latest.current.visible && !latest.current.editing && position.current) {
        pending.current = true;
        restore();
      }
    });
    observer.observe(viewer);
    return () => observer.disconnect();
  }, [options.ready, options.viewer, restore]);

  return { remember, restore, beforeLayoutChange };
}
