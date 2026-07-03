import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Circle, Columns2, FileText, PanelLeft, Plus, Radio, RefreshCw, Rows2, Server, Terminal, X } from "lucide-react";
import type { SplitDirection, Tab } from "../../types";
import { stateClass } from "../../utils/format";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

export function TabBar({ tabs, activeTab, profiles, sidebarCollapsed, onToggleSidebar, onActive, onClose, onReconnect, onTearOff, onReorder, onSplitToggle, onNewConnection, onNewLocal, onOpenMarkdown, broadcastInput, broadcastAvailable, onToggleBroadcast, recording, onToggleRecording, language }: { tabs: Tab[]; activeTab: string; profiles: types.Profile[]; sidebarCollapsed: boolean; onToggleSidebar: () => void; onActive: (id: string) => void; onClose: (id: string) => void; onReconnect: (tab: Tab) => void; onTearOff?: (tab: Tab) => void; onReorder?: (draggedId: string, targetId: string) => void; onSplitToggle?: (tabId: string, direction: SplitDirection) => void; onNewConnection?: () => void; onNewLocal?: () => void; onOpenMarkdown?: () => void; broadcastInput?: boolean; broadcastAvailable?: boolean; onToggleBroadcast?: () => void; recording?: boolean; onToggleRecording?: (id: string) => void; language?: string }) {
  const active = tabs.find((tab) => tab.id === activeTab);
  const lang = language || "en";
  const dragRef = useRef<{ tabId: string; startX: number; startY: number; active: boolean } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const onTearOffRef = useRef(onTearOff);
  onTearOffRef.current = onTearOff;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const [dragState, setDragState] = useState<{ draggedId: string; overId: string | null } | null>(null);
  const dragStateRef = useRef(dragState);
  dragStateRef.current = dragState;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const onTabMouseDown = useCallback((e: React.MouseEvent, tab: Tab) => {
    if (e.button !== 0) return;
    dragRef.current = { tabId: tab.id, startX: e.clientX, startY: e.clientY, active: false };
  }, []);

  useEffect(() => {
    const tabAtPoint = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y);
      const tabEl = el?.closest<HTMLElement>(".tab[data-tab-id]");
      return tabEl?.dataset.tabId ?? null;
    };

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.active && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        d.active = true;
        setDragState({ draggedId: d.tabId, overId: null });
      }
      if (!d.active) return;
      const overId = tabAtPoint(e.clientX, e.clientY);
      const prev = dragStateRef.current;
      if (prev && prev.overId !== overId) {
        setDragState({ draggedId: d.tabId, overId: overId && overId !== d.tabId ? overId : null });
      }
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && d.active) {
        const tabbar = document.querySelector(".tabbar");
        const rect = tabbar?.getBoundingClientRect();
        const outside = rect && (e.clientY < rect.top || e.clientY > rect.bottom || e.clientX < rect.left || e.clientX > rect.right);
        if (outside) {
          const tab = tabsRef.current.find((t) => t.id === d.tabId);
          if (tab && tab.type !== "markdown" && onTearOffRef.current) {
            onTearOffRef.current(tab);
            setDragState(null);
            return;
          }
        } else {
          const targetId = tabAtPoint(e.clientX, e.clientY);
          if (targetId && targetId !== d.tabId && onReorderRef.current) {
            onReorderRef.current(d.tabId, targetId);
          }
        }
      }
      setDragState(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="tabbar" data-dragging={dragState ? "true" : "false"}>
      {sidebarCollapsed && (
        <button className="tab-action" onClick={onToggleSidebar} title={t(lang, "showSidebar")}><PanelLeft size={14} /></button>
      )}
      <div className="tabs-scroll">
        {tabs.map((tab) => {
          const profile = profiles.find((item) => item.id === tab.profileId);
          const full = profile ? `${profile.username}@${profile.host}:${profile.port}` : tab.title;
          const isDragging = dragState?.draggedId === tab.id;
          const isDragOver = dragState?.overId === tab.id;
          return (
            <button key={tab.id} data-tab-id={tab.id} title={full} className={clsx("tab", activeTab === tab.id && "tab-active", isDragging && "tab-dragging", isDragOver && "tab-drag-over")} onClick={() => onActive(tab.id)} onMouseDown={(e) => onTabMouseDown(e, tab)}>
              {tab.type === "markdown" ? <FileText size={12} className="text-accent opacity-70 shrink-0" /> : tab.local ? <Terminal size={12} className="text-accent opacity-70 shrink-0" /> : <span className={clsx("status-dot", stateClass(tab.state))} />}
              <span className="max-w-[180px] truncate">{tab.title}</span>
              <X size={14} onClick={(e) => { e.stopPropagation(); onClose(tab.id); }} />
            </button>
          );
        })}
      </div>
      <div className="tab-actions">
        <div className="relative" ref={menuRef}>
          <button className="tab-action" onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} title={t(lang, "new")}>
            <Plus size={14} />
            <ChevronDown size={10} className="opacity-50 ml-px" />
          </button>
          {menuOpen && (
            <div className="tab-action-dropdown" onClick={(e) => e.stopPropagation()}>
              <button className="tab-action-item" onClick={() => { setMenuOpen(false); onNewConnection?.(); }}>
                <Server size={12} />
                {t(lang, "sshConnection")}
              </button>
              <button className="tab-action-item" onClick={() => { setMenuOpen(false); onNewLocal?.(); }}>
                <Terminal size={12} />
                {t(lang, "localTerminal")}
              </button>
              <button className="tab-action-item" onClick={() => { setMenuOpen(false); onOpenMarkdown?.(); }}>
                <FileText size={12} />
                {t(lang, "openTextFile")}
              </button>
            </div>
          )}
        </div>
        <button className="tab-action" disabled={!active || tabs.length < 2} onClick={() => active && onSplitToggle?.(active.id, "horizontal")} title={t(lang, "splitHorizontal")}><Columns2 size={14} /></button>
        <button className="tab-action" disabled={!active || tabs.length < 2} onClick={() => active && onSplitToggle?.(active.id, "vertical")} title={t(lang, "splitVertical")}><Rows2 size={14} /></button>
        <button className={clsx("tab-action", broadcastInput && "tab-action-on")} disabled={!broadcastAvailable && !broadcastInput} onClick={() => onToggleBroadcast?.()} title={t(lang, "broadcastToggle")}><Radio size={14} /></button>
        <button className={clsx("tab-action", recording && "tab-action-rec")} disabled={!active || active.local || active.type === "markdown" || active.state !== "connected"} onClick={() => active && onToggleRecording?.(active.id)} title={t(lang, recording ? "stopRecording" : "startRecording")}><Circle size={14} fill={recording ? "currentColor" : "none"} /></button>
        <button className="tab-action" disabled={!active || active.local || active.type === "markdown"} onClick={() => active && onReconnect(active)} title={t(lang, "reconnect")}><RefreshCw size={14} /></button>
      </div>
    </div>
  );
}
