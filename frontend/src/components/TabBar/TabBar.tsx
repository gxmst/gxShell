import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Circle, Columns2, CopyPlus, FileText, List, Pin, PinOff, Plus, Radio, RefreshCw, Rows2, Search, Server, Terminal, X } from "lucide-react";
import type { AutomationIndicator, SplitDirection, Tab } from "../../types";
import { Grid2X2 } from "lucide-react";
import { stateClass } from "../../utils/format";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

function tabContext(tab: Tab, profile?: types.Profile) {
  if (tab.type === "markdown") return tab.remotePath || tab.filePath || "";
  return profile?.host ? `${profile.username || ""}@${profile.host}:${profile.port || 22}` : "";
}

// The tab strip. It is mounted inside AppTopBar, so it owns no window chrome
// and no sidebar affordance: the activity rail is always visible and carries
// the only panel toggle.
export function TabBar({ tabs, activeTab, profiles, onActive, onClose, onReconnect, onTearOff, onReorder, onSplitToggle, onNewConnection, onNewLocal, onNewTerminal, onOpenMarkdown, onRename, onTogglePin, rightAccessory, broadcastInput, broadcastAvailable, onToggleBroadcast, recording, onToggleRecording, automationActivity, dirtyTabIds, language }: { tabs: Tab[]; activeTab: string; profiles: types.Profile[]; onActive: (id: string) => void; onClose: (id: string) => void; onReconnect: (tab: Tab) => void; onTearOff?: (tab: Tab) => void; onReorder?: (draggedId: string, targetId: string) => void; onSplitToggle?: (tabId: string, direction: SplitDirection) => void; onNewConnection?: () => void; onNewLocal?: () => void; onNewTerminal?: (tab: Tab) => void; onOpenMarkdown?: () => void; onRename?: (tab: Tab) => void; onTogglePin?: (tab: Tab) => void; rightAccessory?: ReactNode; broadcastInput?: boolean; broadcastAvailable?: boolean; onToggleBroadcast?: () => void; recording?: boolean; onToggleRecording?: (id: string) => void; automationActivity?: Record<string, AutomationIndicator>; dirtyTabIds?: string[]; language?: string }) {
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
  const [tabsQuery, setTabsQuery] = useState("");
  const [tabsMenuPosition, setTabsMenuPosition] = useState({ left: 12, top: 40, maxHeight: 480 });
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [contextTabId, setContextTabId] = useState("");
  const actionsRef = useRef<HTMLDivElement>(null);
  const newMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const toolsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const profileByID = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const dirtySet = useMemo(() => new Set(dirtyTabIds || []), [dirtyTabIds]);
  const filteredTabs = useMemo(() => {
    const query = tabsQuery.trim().toLocaleLowerCase();
    return tabs.filter((tab) => {
      const profile = profileByID.get(tab.profileId);
      return [tab.title, tabContext(tab, profile), profile?.name, profile?.group].join(" ").toLocaleLowerCase().includes(query);
    });
  }, [tabs, tabsQuery, profileByID]);

  useEffect(() => {
    if (!newMenuOpen && !tabsMenuOpen && !toolsMenuOpen && !contextTabId) return;
    const close = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false);
        setTabsMenuOpen(false);
        setToolsMenuOpen(false);
        setContextTabId("");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      event.preventDefault();
      const returnFocus = toolsMenuOpen ? toolsMenuButtonRef.current : tabsMenuOpen ? tabsMenuButtonRef.current : newMenuButtonRef.current;
      setNewMenuOpen(false);
      setTabsMenuOpen(false);
      setToolsMenuOpen(false);
      setContextTabId("");
      window.requestAnimationFrame(() => returnFocus?.focus());
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextTabId, newMenuOpen, tabsMenuOpen, toolsMenuOpen]);

  const onTabsMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target as HTMLElement;
    const input = target instanceof HTMLInputElement;
    if (input && event.key === "Enter" && filteredTabs[0]) {
      event.preventDefault();
      onActive(filteredTabs[0].id);
      setTabsMenuOpen(false);
      return;
    }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".tab-overflow-main"));
    if (!buttons.length) return;
    const row = target.closest(".tab-overflow-row");
    const index = buttons.findIndex((button) => button.closest(".tab-overflow-row") === row);
    let next = -1;
    if (event.key === "ArrowDown") next = input ? 0 : (index + 1) % buttons.length;
    if (event.key === "ArrowUp") next = input ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
    if (!input && event.key === "Home") next = 0;
    if (!input && event.key === "End") next = buttons.length - 1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus();
    buttons[next].scrollIntoView?.({ block: "nearest" });
  };

  useEffect(() => {
    const host = tabsScrollRef.current;
    if (!host || !activeTab) return;
    const activeElement = Array.from(host.querySelectorAll<HTMLElement>(".tab[data-tab-id]"))
      .find((element) => element.dataset.tabId === activeTab);
    if (!activeElement) return;
    const reveal = () => {
      const bounds = host.getBoundingClientRect();
      const tab = activeElement.getBoundingClientRect();
      if (tab.left < bounds.left) host.scrollLeft += tab.left - bounds.left;
      else if (tab.right > bounds.right) host.scrollLeft += tab.right - bounds.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(host);
    observer.observe(activeElement);
    return () => observer.disconnect();
  }, [activeTab, tabs.length]);

  useEffect(() => {
    const close = () => setTabsMenuOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  useEffect(() => {
    const host = tabsScrollRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && host.scrollWidth > host.clientWidth) {
        e.preventDefault();
        host.scrollLeft += e.deltaY;
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheel);
    };
  }, []);

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
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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
          const hostInfo = tabContext(tab, profile);
          const full = [tab.title, tab.type !== "markdown" && profile?.name !== tab.title ? profile?.name : "", hostInfo].filter(Boolean).join("\n");
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
                setToolsMenuOpen(false);
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
                {onNewTerminal && tab.type !== "markdown" && profileByID.has(tab.profileId) && <button role="menuitem" onClick={() => { setContextTabId(""); onNewTerminal(tab); }}><CopyPlus size={12} />{lang === "zh-CN" ? "在新终端打开" : "Open in new terminal"}</button>}
                {onRename && <button role="menuitem" onClick={() => { setContextTabId(""); onRename(tab); }}>{lang === "zh-CN" ? "重命名标签" : "Rename tab"}</button>}
                {onTogglePin && <button role="menuitem" onClick={() => { setContextTabId(""); onTogglePin(tab); }}>{tab.pinned ? <PinOff size={12} /> : <Pin size={12} />}{tab.pinned ? (lang === "zh-CN" ? "取消固定" : "Unpin") : (lang === "zh-CN" ? "固定标签" : "Pin tab")}</button>}
                <button role="menuitem" onClick={() => { setContextTabId(""); onClose(tab.id); }}><X size={12} />{t(lang, "close")}</button>
              </div>}
            </div>
          );
        })}
      </div>
      <div className="tab-actions" ref={actionsRef}>
        {tabs.length > 0 && <div className="relative">
          <button ref={tabsMenuButtonRef} className="tab-action" aria-label={t(lang, "allTabs")} aria-haspopup="dialog" aria-expanded={tabsMenuOpen} onClick={(event) => {
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            const width = Math.min(440, window.innerWidth - 24);
            const top = bounds.bottom + 7;
            setTabsMenuPosition({ left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)), top, maxHeight: Math.max(0, window.innerHeight - top - 12) });
            setNewMenuOpen(false); setToolsMenuOpen(false); setTabsQuery(""); setTabsMenuOpen((value) => !value);
          }} title={t(lang, "allTabs")}>
            <List size={14} />
          </button>
          {tabsMenuOpen && <div className="tab-action-dropdown tab-overflow-dropdown" role="dialog" aria-label={t(lang, "allTabs")} style={tabsMenuPosition} onClick={(event) => event.stopPropagation()} onKeyDown={onTabsMenuKeyDown}>
            <div className="tab-overflow-heading">{t(lang, "tabsCount", { count: String(tabs.length) })}</div>
            <label className="tab-overflow-filter"><Search size={13} /><input autoFocus value={tabsQuery} onChange={(event) => setTabsQuery(event.target.value)} aria-label={t(lang, "filterTabs")} placeholder={t(lang, "filterTabs")} /></label>
            <div className="tab-overflow-list">
              {filteredTabs.map((tab) => (
                <div key={tab.id} className={clsx("tab-overflow-row", activeTab === tab.id && "active")}>
                  <button className="tab-overflow-main" aria-label={tab.title} title={[tab.title, tabContext(tab, profileByID.get(tab.profileId))].filter(Boolean).join("\n")} onClick={() => { onActive(tab.id); setTabsMenuOpen(false); }}>
                    {tab.type === "markdown" ? <FileText size={12} /> : tab.local ? <Terminal size={12} /> : <span className={clsx("status-dot", stateClass(tab.state))} />}
                    <span className="tab-overflow-text"><strong>{tab.title}</strong><small>{tabContext(tab, profileByID.get(tab.profileId))}</small></span>
                    {tab.unread && activeTab !== tab.id && <span className="tab-unread-dot" />}
                    {dirtySet.has(tab.id) && <span className="tab-dirty-dot" />}
                  </button>
                  <button className="tab-overflow-close" aria-label={`${t(lang, "close")} ${tab.title}`} onClick={() => onClose(tab.id)}><X size={12} /></button>
                </div>
              ))}
              {!filteredTabs.length && <div className="tab-overflow-empty" role="status">{t(lang, "noMatchingTabs")}</div>}
            </div>
          </div>}
        </div>}
        <div className="relative">
          <button ref={newMenuButtonRef} className="tab-action" aria-label={t(lang, "new")} aria-haspopup="menu" aria-expanded={newMenuOpen} onClick={(e) => { e.stopPropagation(); setTabsMenuOpen(false); setToolsMenuOpen(false); setNewMenuOpen((v) => !v); }} title={t(lang, "new")}>
            <Plus size={14} />
            <ChevronDown size={10} className="opacity-50 ml-px" />
          </button>
          {newMenuOpen && (
            <div className="tab-action-dropdown" role="menu" onClick={(e) => e.stopPropagation()}>
              {active && active.type !== "markdown" && profileByID.has(active.profileId) && onNewTerminal && <button className="tab-action-item" role="menuitem" onClick={() => { setNewMenuOpen(false); onNewTerminal(active); }}><CopyPlus size={12} />{lang === "zh-CN" ? "在新终端打开" : "Open in new terminal"}</button>}
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
        <div className="relative">
          <button
            ref={toolsMenuButtonRef}
            className={clsx("tab-action tab-tools-toggle", toolsMenuOpen && "tab-action-on")}
            aria-label={t(lang, "terminalTools")}
            aria-haspopup="menu"
            aria-expanded={toolsMenuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setTabsMenuOpen(false);
              setNewMenuOpen(false);
              setToolsMenuOpen((v) => !v);
            }}
            title={t(lang, "terminalTools")}
          >
            <ChevronDown size={12} className={clsx("tab-tools-arrow", toolsMenuOpen && "tab-tools-arrow-open")} />
            {(broadcastInput || recording) && <span className="tab-tools-active-dot" />}
          </button>
          {toolsMenuOpen && (
            <div className="tab-action-dropdown tab-tools-popup" role="menu" onClick={(e) => e.stopPropagation()}>
              <button
                className="tab-action-item"
                role="menuitem"
                disabled={!active || active.type === "markdown" || tabs.filter((tab) => tab.type !== "markdown").length < 2}
                onClick={() => { setToolsMenuOpen(false); if (active) onSplitToggle?.(active.id, "horizontal"); }}
                title={t(lang, "splitHorizontal")}
              >
                <Columns2 size={13} />
                <span>{t(lang, "splitHorizontal")}</span>
              </button>
              <button
                className="tab-action-item"
                role="menuitem"
                disabled={!active || active.type === "markdown" || tabs.filter((tab) => tab.type !== "markdown").length < 2}
                onClick={() => { setToolsMenuOpen(false); if (active) onSplitToggle?.(active.id, "vertical"); }}
                title={t(lang, "splitVertical")}
              >
                <Rows2 size={13} />
                <span>{t(lang, "splitVertical")}</span>
              </button>
              <button
                className="tab-action-item"
                role="menuitem"
                disabled={!active || active.type === "markdown" || tabs.filter((tab) => tab.type !== "markdown").length < 4}
                onClick={() => { setToolsMenuOpen(false); if (active) onSplitToggle?.(active.id, "grid"); }}
              ><Grid2X2 size={13} /><span>{lang === "zh-CN" ? "四分屏" : "Four panes"}</span></button>
              <button
                className={clsx("tab-action-item", broadcastInput && "active")}
                role="menuitem"
                disabled={!broadcastAvailable && !broadcastInput}
                onClick={() => { setToolsMenuOpen(false); onToggleBroadcast?.(); }}
                title={t(lang, "broadcastToggle")}
              >
                <Radio size={13} />
                <span>{t(lang, "broadcastToggle")}</span>
                {broadcastInput && <span className="tab-tools-state-on">{lang === "zh-CN" ? "开启" : "ON"}</span>}
              </button>
              <button
                className="tab-action-item"
                role="menuitem"
                disabled={!active || active.local || active.type === "markdown" || active.state !== "connected"}
                onClick={() => { setToolsMenuOpen(false); if (active) onToggleRecording?.(active.id); }}
                title={t(lang, recording ? "stopRecording" : "startRecording")}
              >
                <Circle size={13} fill={recording ? "currentColor" : "none"} />
                <span>{t(lang, recording ? "stopRecording" : "startRecording")}</span>
                {recording && <span className="tab-tools-state-rec">{lang === "zh-CN" ? "录制中" : "REC"}</span>}
              </button>
              <button
                className="tab-action-item"
                role="menuitem"
                disabled={!active || active.local || active.type === "markdown"}
                onClick={() => { setToolsMenuOpen(false); if (active) onReconnect(active); }}
                title={t(lang, "reconnect")}
              >
                <RefreshCw size={13} />
                <span>{t(lang, "reconnect")}</span>
              </button>
            </div>
          )}
        </div>
        {rightAccessory}
      </div>
    </div>
  );
}
