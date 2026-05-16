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
}

export function FloatingTerminal({ tab, terminalHosts, onDock, onClose, refitTerminal }: FloatingTerminalProps) {
  const [pos, setPos] = useState({ left: 120, top: 80 });
  const [size, setSize] = useState({ width: 720, height: 480 });
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 });
  const resizeRef = useRef({ active: false, startX: 0, startY: 0, startW: 0, startH: 0 });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || movedRef.current) return;
    const oldHost = terminalHosts.current[tab.id];
    if (oldHost && oldHost !== host) {
      const xtermEl = oldHost.querySelector(".xterm");
      if (xtermEl) {
        host.appendChild(xtermEl);
      }
    }
    terminalHosts.current[tab.id] = host;
    movedRef.current = true;
    const timer = setTimeout(() => refitTerminal?.(tab.id), 50);
    return () => clearTimeout(timer);
  }, [tab.id, terminalHosts, refitTerminal]);

  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (!host) return;
      const xtermEl = host.querySelector(".xterm");
      const mainHost = document.querySelector(`.terminal-stage [data-tab-id="${tab.id}"]`);
      if (xtermEl && mainHost) {
        mainHost.appendChild(xtermEl);
        terminalHosts.current[tab.id] = mainHost as HTMLDivElement;
      }
      movedRef.current = false;
      setTimeout(() => refitTerminal?.(tab.id), 50);
    };
  }, [tab.id, terminalHosts, refitTerminal]);

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, startLeft: pos.left, startTop: pos.top };
    e.preventDefault();
  }, [pos.left, pos.top]);

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    resizeRef.current = { active: true, startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height };
    e.preventDefault();
    e.stopPropagation();
  }, [size.width, size.height]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current.active) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPos({
          left: Math.max(0, Math.min(window.innerWidth - 100, dragRef.current.startLeft + dx)),
          top: Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.startTop + dy)),
        });
      }
      if (resizeRef.current.active) {
        const dx = e.clientX - resizeRef.current.startX;
        const dy = e.clientY - resizeRef.current.startY;
        setSize({
          width: Math.max(320, resizeRef.current.startW + dx),
          height: Math.max(200, resizeRef.current.startH + dy),
        });
      }
    };
    const onUp = () => {
      const wasActive = dragRef.current.active || resizeRef.current.active;
      dragRef.current.active = false;
      resizeRef.current.active = false;
      if (wasActive) {
        setTimeout(() => refitTerminal?.(tab.id), 30);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [tab.id, refitTerminal]);

  return (
    <div className="floating-terminal" style={{ left: pos.left, top: pos.top, width: size.width, height: size.height }}>
      <div className="floating-terminal-header" onMouseDown={onHeaderMouseDown}>
        <span className={stateClass(tab.state) + " status-dot"} />
        <span className="floating-terminal-title">{tab.title}</span>
        <button className="mini-btn" title="Dock back" onClick={() => onDock(tab.id)}><ArrowLeftToLine size={12} /></button>
        <button className="mini-btn" title="Close" onClick={() => onClose(tab.id)}><X size={12} /></button>
      </div>
      <div className="floating-terminal-body" ref={hostRef} />
      <div className="floating-terminal-resize" onMouseDown={onResizeMouseDown} />
    </div>
  );
}
