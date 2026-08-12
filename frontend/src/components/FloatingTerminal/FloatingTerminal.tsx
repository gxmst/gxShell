import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftToLine, X } from "lucide-react";
import type { Tab } from "../../types";
import { stateClass } from "../../utils/format";

interface FloatingTerminalProps {
  tab: Tab;
  terminalHosts: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onDock: (id: string) => void;
  onClose: (id: string) => void;
  refitTerminal?: (id: string) => void;
  reattachTerminal?: (id: string, newHost: HTMLDivElement) => void;
}

export function FloatingTerminal({ tab, terminalHosts, onDock, onClose, refitTerminal, reattachTerminal }: FloatingTerminalProps) {
  const [pos, setPos] = useState({ left: 120, top: 80 });
  const [size, setSize] = useState({ width: 720, height: 480 });
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 });
  const resizeRef = useRef({ active: false, startX: 0, startY: 0, startW: 0, startH: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);
  const frameRef = useRef(0);
  const livePosRef = useRef(pos);
  const liveSizeRef = useRef(size);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || movedRef.current) return;

    if (reattachTerminal) {
      reattachTerminal(tab.id, host);
    } else {
      const oldHost = terminalHosts.current[tab.id];
      if (oldHost && oldHost !== host) {
        const xtermEl = oldHost.querySelector(".xterm");
        if (xtermEl) {
          host.appendChild(xtermEl);
        }
      }
      terminalHosts.current[tab.id] = host;
      setTimeout(() => refitTerminal?.(tab.id), 50);
    }
    
    movedRef.current = true;
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      // When unmounting (dock or close), move the terminal DOM back to the main window.
      // reattachTerminal uses term.element directly, so it doesn't depend on
      // terminalHosts.current (which may have been overwritten by TerminalArea's ref).
      const mainHost = document.querySelector(`.terminal-stage [data-tab-id="${tab.id}"]`) as HTMLDivElement;
      if (mainHost && reattachTerminal) {
        reattachTerminal(tab.id, mainHost);
      }
      movedRef.current = false;
    };
  }, [tab.id, reattachTerminal]);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    livePosRef.current = pos;
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, startLeft: pos.left, startTop: pos.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [pos]);

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    liveSizeRef.current = size;
    resizeRef.current = { active: true, startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, [size]);

  const applyLiveBounds = useCallback(() => {
    frameRef.current = 0;
    const panel = panelRef.current;
    if (!panel) return;
    if (dragRef.current.active) {
      panel.style.left = `${livePosRef.current.left}px`;
      panel.style.top = `${livePosRef.current.top}px`;
    }
    if (resizeRef.current.active) {
      panel.style.width = `${liveSizeRef.current.width}px`;
      panel.style.height = `${liveSizeRef.current.height}px`;
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      livePosRef.current = {
        left: Math.max(0, Math.min(window.innerWidth - 100, dragRef.current.startLeft + dx)),
        top: Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.startTop + dy)),
      };
    }
    if (resizeRef.current.active) {
      liveSizeRef.current = {
        width: Math.max(320, resizeRef.current.startW + e.clientX - resizeRef.current.startX),
        height: Math.max(200, resizeRef.current.startH + e.clientY - resizeRef.current.startY),
      };
    }
    if (!frameRef.current && (dragRef.current.active || resizeRef.current.active)) {
      frameRef.current = requestAnimationFrame(applyLiveBounds);
    }
  }, [applyLiveBounds]);

  const finishPointerGesture = useCallback((cancelled = false) => {
    const wasDragging = dragRef.current.active;
    const wasResizing = resizeRef.current.active;
    if (!wasDragging && !wasResizing) return;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    dragRef.current.active = false;
    resizeRef.current.active = false;
    if (!cancelled) {
      if (wasDragging) setPos(livePosRef.current);
      if (wasResizing) setSize(liveSizeRef.current);
    } else {
      livePosRef.current = pos;
      liveSizeRef.current = size;
      const panel = panelRef.current;
      if (panel) {
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
        panel.style.width = `${size.width}px`;
        panel.style.height = `${size.height}px`;
      }
    }
    setTimeout(() => refitTerminal?.(tab.id), 30);
  }, [pos, size, tab.id, refitTerminal]);

  return (
    <div ref={panelRef} className="floating-terminal" style={{ left: pos.left, top: pos.top, width: size.width, height: size.height }}>
      <div
        className="floating-terminal-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finishPointerGesture()}
        onPointerCancel={() => finishPointerGesture(true)}
      >
        <span className={stateClass(tab.state) + " status-dot"} />
        <span className="floating-terminal-title">{tab.title}</span>
        <button className="mini-btn" title="Dock back" onClick={() => onDock(tab.id)}><ArrowLeftToLine size={12} /></button>
        <button className="mini-btn" title="Close" onClick={() => onClose(tab.id)}><X size={12} /></button>
      </div>
      <div className="floating-terminal-body" ref={hostRef} />
      <div
        className="floating-terminal-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finishPointerGesture()}
        onPointerCancel={() => finishPointerGesture(true)}
      />
    </div>
  );
}
