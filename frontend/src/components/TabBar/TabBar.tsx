import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Circle, Columns2, FileText, List, Pin, PinOff, Plus, Radio, RefreshCw, Rows2, Server, Terminal, X } from "lucide-react";
import type { AutomationIndicator, SplitDirection, Tab } from "../../types";
import { stateClass } from "../../utils/format";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

// The tab strip. It is mounted inside AppTopBar, so it owns no window chrome
// and no sidebar affordance: the activity rail is always visible and carries
// the only panel toggle.
export function TabBar({ tabs, activeTab, profiles, onActive, onClose, onReconnect, onTearOff, onReorder, onSplitToggle, onNewConnection, onNewLocal, onOpenMarkdown, onRename, onTogglePin, rightAccessory, broadcastInput, broadcastAvailable, onToggleBroadcast, recording, onToggleRecording, automationActivity, dirtyTabIds, language }: { tabs: Tab[]; activeTab: string; profiles: types.Profile[]; onActive: (id: string) => void; onClose: (id: string) => void; onReconnect: (tab: Tab) => void; onTearOff?: (tab: Tab) => void; onReorder?: (draggedId: string, targetId: string) => void; onSplitToggle?: (tabId: string, direction: SplitDirection) => void; onNewConnection?: () => void; onNewLocal?: () => void; onOpenMarkdown?: () => void; onRename?: (tab: Tab) => void; onTogglePin?: (tab: Tab) => void; rightAccessory?: ReactNode; broadcastInput?: boolean; broadcastAvailable?: boolean; onToggleBroadcast?: () => void; recording?: boolean; onToggleRecording?: (id: string) => void; automationActivity?: Record<string, AutomationIndicator>; dirtyTabIds?: string[]; language?: string }) {
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

  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [contextTabId, setContextTabId] = useState("");
  const actionsRef = useRef<HTMLDivElement>(null);
  const newMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const profileByID = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const dirtySet = useMemo(() => new Set(dirtyTabIds || []), [dirtyTabIds]);

  useEffect(() => {
    if (!newMenuOpen && !tabsMenuOpen && !contextTabId) return;
    const close = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false);
        setTabsMenuOpen(false);
        setContextTabId("");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const returnFocus = tabsMenuOpen ? tabsMenuButtonRef.current : newMenuButtonRef.current;
      setNewMenuOpen(false);
      setTabsMenuOpen(false);
      window.requestAnimationFrame(() => returnFocus?.focus());
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextTabId, newMenuOpen, tabsMenuOpen]);

  useEffect(() => {
    const host = tabsScrollRef.current;
    if (!host || !activeTab) return;
    const activeElement = Array.from(host.querySelectorAll<HTMLElement>(".tab[data-tab-id]"))
      .find((element) => element.dataset.tabId === activeTab);
    activeElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab, tabs.length]);

  const activateTabByIndex = useCallback((index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    onActive(tab.id);
    window.requestAnimationFrame(() => {
      const host = tabsScrollRef.current;
      const target = Array.from(host?.querySelectorAll<HTMLButtonElement>(".tab-main") || [])
        .find((element) => element.closest<HTMLElement>(".tab")?.dataset.tabId === tab.id);
      target?.focus();
    });
  }, [onActive, tabs]);

  const onTabKeyDown = useCallback((event: React.KeyboardEvent, index: number) => {
    let nextIndex = -1;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    activateTabByIndex(nextIndex);
  }, [activateTabByIndex, tabs.length]);

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
      <div className="tabs-scroll" ref={tabsScrollRef} role="tablist" aria-label={lang === "zh-CN" ? "打开的标签" : "Open tabs"}>
        {tabs.map((tab, index) => {
          const profile = profileByID.get(tab.profileId);
          const automation = automationActivity?.[tab.id];
          const full = profile ? `${profile.username}@${profile.host}:${profile.port}` : tab.title;
          const tooltip = tab.error ? `${full}\n${tab.error}` : full;
          const isDragging = dragState?.draggedId === tab.id;
          const isDragOver = dragState?.overId === tab.id;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              title={tooltip}
              className={clsx("tab", activeTab === tab.id && "tab-active", tab.unread && activeTab !== tab.id && "tab-unread", tab.pinned && "tab-pinned", automation && "tab-automation", isDragging && "tab-dragging", isDragOver && "tab-drag-over")}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                  return;
                }
                onTabMouseDown(e, tab);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setNewMenuOpen(false);
                setTabsMenuOpen(false);
                setContextTabId(tab.id);
              }}
            >
              <button className="tab-main" role="tab" aria-selected={activeTab === tab.id} aria-label={tab.title} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => onActive(tab.id)} onKeyDown={(event) => onTabKeyDown(event, index)}>
                {tab.type === "markdown" ? <FileText size={12} className="text-accent opacity-70 shrink-0" /> : tab.local ? <Terminal size={12} className="text-accent opacity-70 shrink-0" /> : <span className={clsx("status-dot", stateClass(tab.state))} />}
                <span className="tab-title">{tab.title}</span>
                {tab.pinned && <Pin size={10} className="tab-pin-mark" aria-label={lang === "zh-CN" ? "已固定" : "Pinned"} />}
                {tab.unread && activeTab !== tab.id && <span className="tab-unread-dot" title={lang === "zh-CN" ? "有新输出" : "New output"} />}
                {dirtySet.has(tab.id) && <span className="tab-dirty-dot" title={lang === "zh-CN" ? "未保存" : "Unsaved"} />}
                {automation && <span className={clsx("automation-badge tab-automation-badge", `automation-${automation.source}`, automation.phase === "started" && "automation-running", automation.phase === "failed" && "automation-failed")}>{automation.source.toUpperCase()}</span>}
              </button>
              <button className="tab-close" tabIndex={activeTab === tab.id ? 0 : -1} aria-label={`${t(lang, "close")} ${tab.title}`} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}><X size={13} /></button>
              {contextTabId === tab.id && <div className="tab-context-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                {onRename && <button role="menuitem" onClick={() => { setContextTabId(""); onRename(tab); }}>{lang === "zh-CN" ? "重命名标签" : "Rename tab"}</button>}
                {onTogglePin && <button role="menuitem" onClick={() => { setContextTabId(""); onTogglePin(tab); }}>{tab.pinned ? <PinOff size={12} /> : <Pin size={12} />}{tab.pinned ? (lang === "zh-CN" ? "取消固定" : "Unpin") : (lang === "zh-CN" ? "固定标签" : "Pin tab")}</button>}
                <button role="menuitem" onClick={() => { setContextTabId(""); onClose(tab.id); }}><X size={12} />{t(lang, "close")}</button>
              </div>}
            </div>
          );
        })}
      </div>
      <div className="tab-actions" ref={actionsRef}>
        {tabs.length > 1 && <div className="relative">
          <button ref={tabsMenuButtonRef} className="tab-action" aria-label={lang === "zh-CN" ? "全部标签" : "All tabs"} aria-haspopup="menu" aria-expanded={tabsMenuOpen} onClick={(event) => { event.stopPropagation(); setNewMenuOpen(false); setTabsMenuOpen((value) => !value); }} title={lang === "zh-CN" ? "全部标签" : "All tabs"}>
            <List size={14} />
          </button>
          {tabsMenuOpen && <div className="tab-action-dropdown tab-overflow-dropdown" role="menu" onClick={(event) => event.stopPropagation()}>
            <div className="tab-overflow-heading">{lang === "zh-CN" ? `${tabs.length} 个标签` : `${tabs.length} tabs`}</div>
            <div className="tab-overflow-list">
              {tabs.map((tab) => (
                <div key={tab.id} className={clsx("tab-overflow-row", activeTab === tab.id && "active")}>
                  <button className="tab-overflow-main" role="menuitem" onClick={() => { onActive(tab.id); setTabsMenuOpen(false); }}>
                    {tab.type === "markdown" ? <FileText size={12} /> : tab.local ? <Terminal size={12} /> : <span className={clsx("status-dot", stateClass(tab.state))} />}
                    <span>{tab.title}</span>
                    {tab.unread && activeTab !== tab.id && <span className="tab-unread-dot" />}
                    {dirtySet.has(tab.id) && <span className="tab-dirty-dot" />}
                  </button>
                  <button className="tab-overflow-close" aria-label={`${t(lang, "close")} ${tab.title}`} onClick={() => onClose(tab.id)}><X size={12} /></button>
                </div>
              ))}
            </div>
          </div>}
        </div>}
        <div className="relative">
          <button ref={newMenuButtonRef} className="tab-action" aria-label={t(lang, "new")} aria-haspopup="menu" aria-expanded={newMenuOpen} onClick={(e) => { e.stopPropagation(); setTabsMenuOpen(false); setNewMenuOpen((v) => !v); }} title={t(lang, "new")}>
            <Plus size={14} />
            <ChevronDown size={10} className="opacity-50 ml-px" />
          </button>
          {newMenuOpen && (
            <div className="tab-action-dropdown" role="menu" onClick={(e) => e.stopPropagation()}>
              <button className="tab-action-item" role="menuitem" onClick={() => { setNewMenuOpen(false); onNewConnection?.(); }}>
                <Server size={12} />
                {t(lang, "sshConnection")}
              </button>
              <button className="tab-action-item" role="menuitem" onClick={() => { setNewMenuOpen(false); onNewLocal?.(); }}>
                <Terminal size={12} />
                {t(lang, "localTerminal")}
              </button>
              <button className="tab-action-item" role="menuitem" onClick={() => { setNewMenuOpen(false); onOpenMarkdown?.(); }}>
                <FileText size={12} />
                {t(lang, "openDocument")}
              </button>
            </div>
          )}
        </div>
        <button className="tab-action" aria-label={t(lang, "splitHorizontal")} disabled={!active || tabs.length < 2} onClick={() => active && onSplitToggle?.(active.id, "horizontal")} title={t(lang, "splitHorizontal")}><Columns2 size={14} /></button>
        <button className="tab-action" aria-label={t(lang, "splitVertical")} disabled={!active || tabs.length < 2} onClick={() => active && onSplitToggle?.(active.id, "vertical")} title={t(lang, "splitVertical")}><Rows2 size={14} /></button>
        <button className={clsx("tab-action", broadcastInput && "tab-action-on")} aria-label={t(lang, "broadcastToggle")} disabled={!broadcastAvailable && !broadcastInput} onClick={() => onToggleBroadcast?.()} title={t(lang, "broadcastToggle")}><Radio size={14} /></button>
        <button className={clsx("tab-action", recording && "tab-action-rec")} aria-label={t(lang, recording ? "stopRecording" : "startRecording")} disabled={!active || active.local || active.type === "markdown" || active.state !== "connected"} onClick={() => active && onToggleRecording?.(active.id)} title={t(lang, recording ? "stopRecording" : "startRecording")}><Circle size={14} fill={recording ? "currentColor" : "none"} /></button>
        <button className="tab-action" aria-label={t(lang, "reconnect")} disabled={!active || active.local || active.type === "markdown"} onClick={() => active && onReconnect(active)} title={t(lang, "reconnect")}><RefreshCw size={14} /></button>
        {rightAccessory}
      </div>
    </div>
  );
}
