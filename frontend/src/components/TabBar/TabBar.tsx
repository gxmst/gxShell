import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Circle, Columns2, CopyPlus, FileText, List, Pin, PinOff, Plus, Radio, RefreshCw, Rows2, Search, Server, Terminal, X } from "lucide-react";
import type { AutomationIndicator, SplitDirection, Tab } from "../../types";
import { Grid2X2 } from "lucide-react";
import { stateClass } from "../../utils/format";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { isImeComposing } from "../../utils/ime";
import { TabStrip } from "./TabStrip";
import { closeTabTargets, orderTabs, TerminalLabels } from "./tabLayout";

function tabContext(tab: Tab, profile?: types.Profile) {
  if (tab.type === "markdown") return [tab.markdownSource === "remote" && profile?.host ? `${profile.username || ""}@${profile.host}:${profile.port || 22}` : "", tab.remotePath || tab.filePath].filter(Boolean).join(" · ");
  return profile?.host ? `${profile.username || ""}@${profile.host}:${profile.port || 22}` : "";
}

// The tab strip. It is mounted inside AppTopBar, so it owns no window chrome
// and no sidebar affordance: the activity rail is always visible and carries
// the only panel toggle.
export function TabBar({ tabs, activeTab, profiles, onActive, onClose, onCloseMany, closingTabs, onReconnect, onTearOff, onReorder, onSplitToggle, onNewConnection, onNewLocal, onNewTerminal, onOpenMarkdown, onRename, onTogglePin, rightAccessory, broadcastInput, broadcastAvailable, onToggleBroadcast, recording, onToggleRecording, automationActivity, dirtyTabIds, language }: { tabs: Tab[]; activeTab: string; profiles: types.Profile[]; onActive: (id: string, options?: { keepFocus?: boolean }) => void; onClose: (id: string) => void; onCloseMany?: (ids: string[]) => void | Promise<unknown>; closingTabs?: boolean; onReconnect: (tab: Tab) => void; onTearOff?: (tab: Tab) => void; onReorder?: (draggedId: string, targetId: string) => void; onSplitToggle?: (tabId: string, direction: SplitDirection) => void; onNewConnection?: () => void; onNewLocal?: () => void; onNewTerminal?: (tab: Tab) => void; onOpenMarkdown?: () => void; onRename?: (tab: Tab) => void; onTogglePin?: (tab: Tab) => void; rightAccessory?: ReactNode; broadcastInput?: boolean; broadcastAvailable?: boolean; onToggleBroadcast?: () => void; recording?: boolean; onToggleRecording?: (id: string) => void; automationActivity?: Record<string, AutomationIndicator>; dirtyTabIds?: string[]; language?: string }) {
  const orderedTabs = useMemo(() => orderTabs(tabs), [tabs]);
  const active = orderedTabs.find((tab) => tab.id === activeTab);
  const labelsRef = useRef(new TerminalLabels());
  const labels = useMemo(() => labelsRef.current.labels(tabs), [tabs]);
  const pinnedTabs = orderedTabs.filter((tab) => tab.pinned);
  const regularTabs = orderedTabs.filter((tab) => !tab.pinned);
  const lang = language || "en";
  const dragRef = useRef<{ tabId: string; startX: number; startY: number; active: boolean } | null>(null);
  const tabsRef = useRef(orderedTabs);
  tabsRef.current = orderedTabs;
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
  const [pinnedMenuOnly, setPinnedMenuOnly] = useState(false);
  const [tabsMenuPosition, setTabsMenuPosition] = useState({ left: 12, top: 40, maxHeight: 480 });
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [contextTabId, setContextTabId] = useState("");
  const [contextPosition, setContextPosition] = useState({ left: 0, top: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const newMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const toolsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const profileByID = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const dirtySet = useMemo(() => new Set(dirtyTabIds || []), [dirtyTabIds]);
  const filteredTabs = useMemo(() => {
    const query = tabsQuery.trim().toLocaleLowerCase();
    return orderedTabs.filter((tab) => {
      if (pinnedMenuOnly && !tab.pinned) return false;
      const profile = profileByID.get(tab.profileId);
      return [labels.get(tab.id), tab.title, tabContext(tab, profile), profile?.name, profile?.host, profile?.username, profile?.group].join(" ").toLocaleLowerCase().includes(query);
    });
  }, [orderedTabs, tabsQuery, profileByID, labels, pinnedMenuOnly]);
  const tabGroups = useMemo(() => {
    const groups = new Map<string, { title: string; context: string; tabs: Tab[] }>();
    for (const tab of filteredTabs) {
      const profile = profileByID.get(tab.profileId);
      const key = tab.type === "markdown" ? "documents" : tab.local ? "local" : `server:${tab.profileId || tab.id}`;
      if (!groups.has(key)) groups.set(key, { title: tab.type === "markdown" ? t(lang, "documentsNav") : tab.local ? t(lang, "localTerminal") : profile?.name || tab.title, context: tab.type === "markdown" || tab.local ? "" : tabContext(tab, profile), tabs: [] });
      groups.get(key)!.tabs.push(tab);
    }
    return [...groups.values()];
  }, [filteredTabs, profileByID, lang]);
  const menuTabs = tabGroups.flatMap((group) => group.tabs);
  const contextTab = orderedTabs.find((tab) => tab.id === contextTabId);

  const toggleTabsMenu = (event: React.MouseEvent<HTMLButtonElement>, pinnedOnly = false) => {
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 24);
    const top = bounds.bottom + 7;
    setTabsMenuPosition({ left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)), top, maxHeight: Math.max(0, window.innerHeight - top - 12) });
    setNewMenuOpen(false); setToolsMenuOpen(false); setContextTabId(""); setTabsQuery("");
    setTabsMenuOpen((value) => !value || pinnedMenuOnly !== pinnedOnly);
    setPinnedMenuOnly(pinnedOnly);
  };

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setContextPosition((position) => {
      const next = { left: Math.max(8, Math.min(position.left, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(position.top, window.innerHeight - rect.height - 8)) };
      return next.left === position.left && next.top === position.top ? position : next;
    });
  }, [contextTabId]);

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
      if (event.key !== "Escape" || isImeComposing(event) || event.defaultPrevented) return;
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
    if (isImeComposing(event)) return;
    const target = event.target as HTMLElement;
    const input = target instanceof HTMLInputElement;
    if (input && event.key === "Enter" && menuTabs[0]) {
      event.preventDefault();
      onActive(menuTabs[0].id);
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
    const close = () => { setTabsMenuOpen(false); setContextTabId(""); };
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  const activateTabByIndex = useCallback((index: number) => {
    const tab = orderedTabs[index];
    if (!tab) return;
    // The strip keeps the focus it is navigating with, so the caller must not
    // move it into the terminal. The focus move is synchronous: the button for
    // every tab is already rendered, and deferring it to an animation frame is
    // what let the terminal's own focus timer win the race.
    onActive(tab.id, { keepFocus: true });
    const host = tabsListRef.current;
    const target = Array.from(host?.querySelectorAll<HTMLButtonElement>(".tab-main") || [])
      .find((element) => element.closest<HTMLElement>(".tab")?.dataset.tabId === tab.id);
    if (target?.offsetParent === null && tab.pinned) host?.querySelector<HTMLButtonElement>(".tabs-pinned-compact button")?.focus();
    else target?.focus();
  }, [onActive, orderedTabs]);

  const onTabKeyDown = useCallback((event: React.KeyboardEvent, index: number) => {
    if (isImeComposing(event)) return;
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
      const id = tabEl?.dataset.tabId;
      const dragging = tabsRef.current.find((tab) => tab.id === dragRef.current?.tabId);
      const target = tabsRef.current.find((tab) => tab.id === id);
      return target && !!target.pinned === !!dragging?.pinned ? target.id : null;
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

  const renderTab = (tab: Tab) => {
    const index = orderedTabs.findIndex((item) => item.id === tab.id);
    const profile = profileByID.get(tab.profileId);
    const automation = automationActivity?.[tab.id];
    const hostInfo = tabContext(tab, profile);
    const label = labels.get(tab.id) || tab.title;
    const numberSuffix = label === tab.title ? "" : label.slice(tab.title.length).trim();
    const full = [label, tab.type !== "markdown" && profile?.name !== tab.title ? profile?.name : "", hostInfo].filter(Boolean).join("\n");
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
          setContextPosition({ left: event.clientX, top: event.clientY });
          setContextTabId(tab.id);
        }}
      >
        <button className="tab-main" role="tab" aria-selected={activeTab === tab.id} aria-label={label} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => onActive(tab.id)} onKeyDown={(event) => onTabKeyDown(event, index)}>
          {tab.type === "markdown" ? <FileText size={13} className="text-accent shrink-0" /> : tab.local ? <Terminal size={13} className="text-accent shrink-0" /> : <span className="tab-server-icon" title={t(lang, tab.state === "connected" ? "serverStatusConnected" : tab.state === "error" ? "serverStatusError" : tab.state === "disconnected" ? "serverStatusDisconnected" : "terminalStateConnecting")}><Server size={13} /><span className={clsx("status-dot", stateClass(tab.state))} /></span>}
          <span className="tab-title">{tab.title}</span>
          {numberSuffix && <span className="tab-number">{numberSuffix}</span>}
          {tab.pinned && <Pin size={10} className="tab-pin-mark" aria-label={t(lang, "tabPinned")} />}
          {tab.unread && activeTab !== tab.id && <span className="tab-unread-dot" title={t(lang, "tabNewOutput")} />}
          {dirtySet.has(tab.id) && <span className="tab-dirty-dot" title={t(lang, "tabUnsaved")} />}
          {automation && <span className={clsx("automation-badge tab-automation-badge", `automation-${automation.source}`, automation.phase === "started" && "automation-running", automation.phase === "failed" && "automation-failed")}>{automation.source.toUpperCase()}</span>}
        </button>
        <button className="tab-close" tabIndex={activeTab === tab.id ? 0 : -1} aria-label={`${t(lang, "close")} ${label}`} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}><X size={13} /></button>

      </div>
    );
  };

  return (
    <div className="tabbar" data-dragging={dragState ? "true" : "false"}>
      <div className="tabs-regions" ref={tabsListRef} role="tablist" aria-label={t(lang, "openTabs")}>
        {pinnedTabs.length > 0 && regularTabs.length > 0 && <div className={clsx("tabs-pinned-compact", active?.pinned && "active")}>
          <button className="tab-action" aria-label={t(lang, "pinnedTabs")} title={active?.pinned ? labels.get(active.id) : t(lang, "pinnedTabs")} aria-haspopup="dialog" aria-expanded={tabsMenuOpen && pinnedMenuOnly} onClick={(event) => toggleTabsMenu(event, true)} onKeyDown={(event) => onTabKeyDown(event, orderedTabs.findIndex((tab) => tab.id === activeTab))}><Pin size={13} /><span className="tab-count">{pinnedTabs.length}</span></button>
        </div>}
        {pinnedTabs.length > 0 && <TabStrip pinned onlyPinned={!regularTabs.length} activeTab={activeTab} orderKey={pinnedTabs.map((tab) => tab.id).join("|")} leftLabel={t(lang, "scrollPinnedTabsLeft")} rightLabel={t(lang, "scrollPinnedTabsRight")}>{pinnedTabs.map(renderTab)}</TabStrip>}
        {regularTabs.length > 0 && <TabStrip activeTab={activeTab} orderKey={regularTabs.map((tab) => tab.id).join("|")} leftLabel={t(lang, "scrollTabsLeft")} rightLabel={t(lang, "scrollTabsRight")}>{regularTabs.map(renderTab)}</TabStrip>}
      </div>
      <div className="tab-actions" ref={actionsRef}>
        {tabs.length > 0 && <div className="relative">
          <button ref={tabsMenuButtonRef} className="tab-action tab-list-toggle" aria-label={t(lang, "allTabs")} aria-haspopup="dialog" aria-expanded={tabsMenuOpen} onClick={(event) => toggleTabsMenu(event)} title={t(lang, "allTabs")}>
            <List size={14} /><span className="tab-list-label">{t(lang, "allTabs")}</span><span className="tab-count">{tabs.length}</span>
          </button>
          {tabsMenuOpen && <div className="tab-action-dropdown tab-overflow-dropdown" role="dialog" aria-label={t(lang, "allTabs")} style={tabsMenuPosition} onClick={(event) => event.stopPropagation()} onKeyDown={onTabsMenuKeyDown}>
            <div className="tab-overflow-heading">{pinnedMenuOnly ? `${t(lang, "pinnedTabs")} · ${pinnedTabs.length}` : t(lang, "tabsCount", { count: String(tabs.length) })}</div>
            <label className="tab-overflow-filter"><Search size={13} /><input autoFocus value={tabsQuery} onChange={(event) => setTabsQuery(event.target.value)} aria-label={t(lang, "filterTabs")} placeholder={t(lang, "filterTabs")} /></label>
            <div className="tab-overflow-list">
              {tabGroups.map((group, index) => <div className="tab-overflow-group" key={index}>
                <div className="tab-overflow-group-heading"><strong>{group.title}</strong><span>{group.tabs.length}</span></div>
                {group.tabs.map((tab) => (
                <div key={tab.id} className={clsx("tab-overflow-row", activeTab === tab.id && "active")}>
                  <button className="tab-overflow-main" aria-label={labels.get(tab.id) || tab.title} title={[labels.get(tab.id) || tab.title, tabContext(tab, profileByID.get(tab.profileId))].filter(Boolean).join("\n")} onClick={() => { onActive(tab.id); setTabsMenuOpen(false); }}>
                    {tab.type === "markdown" ? <FileText size={12} /> : tab.local ? <Terminal size={12} /> : <span className={clsx("status-dot", stateClass(tab.state))} />}
                    <span className="tab-overflow-text"><strong>{labels.get(tab.id) || tab.title}</strong><small><span className="tab-kind">{t(lang, tab.type === "markdown" ? "tabKindDocument" : "tabKindTerminal")}</span>{tabContext(tab, profileByID.get(tab.profileId))}</small></span>
                    {tab.pinned && <Pin size={10} aria-label={t(lang, "tabPinned")} />}
                    {tab.unread && activeTab !== tab.id && <span className="tab-unread-dot" />}
                    {dirtySet.has(tab.id) && <span className="tab-dirty-dot" />}
                  </button>
                  <button className="tab-overflow-close" aria-label={`${t(lang, "close")} ${labels.get(tab.id) || tab.title}`} onClick={() => onClose(tab.id)}><X size={12} /></button>
                </div>
              ))}
              </div>)}
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
              {active && active.type !== "markdown" && profileByID.has(active.profileId) && onNewTerminal && <button className="tab-action-item" role="menuitem" onClick={() => { setNewMenuOpen(false); onNewTerminal(active); }}><CopyPlus size={12} />{t(lang, "openInNewTerminal")}</button>}
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
              ><Grid2X2 size={13} /><span>{t(lang, "fourPanes")}</span></button>
              <button
                className={clsx("tab-action-item", broadcastInput && "active")}
                role="menuitem"
                disabled={!broadcastAvailable && !broadcastInput}
                onClick={() => { setToolsMenuOpen(false); onToggleBroadcast?.(); }}
                title={t(lang, "broadcastToggle")}
              >
                <Radio size={13} />
                <span>{t(lang, "broadcastToggle")}</span>
                {broadcastInput && <span className="tab-tools-state-on">{t(lang, "tabToolsOn")}</span>}
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
                {recording && <span className="tab-tools-state-rec">{t(lang, "tabToolsRecording")}</span>}
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
      {contextTab && <div className="tab-context-menu" ref={contextMenuRef} role="menu" style={contextPosition} onClick={(event) => event.stopPropagation()}>
        {onNewTerminal && contextTab.type !== "markdown" && profileByID.has(contextTab.profileId) && <button role="menuitem" onClick={() => { setContextTabId(""); onNewTerminal(contextTab); }}><CopyPlus size={12} />{t(lang, "openInNewTerminal")}</button>}
        {onRename && <button role="menuitem" onClick={() => { setContextTabId(""); onRename(contextTab); }}>{t(lang, "renameTab")}</button>}
        {onTogglePin && <button role="menuitem" onClick={() => { setContextTabId(""); onTogglePin(contextTab); }}>{contextTab.pinned ? <PinOff size={12} /> : <Pin size={12} />}{t(lang, contextTab.pinned ? "unpinTab" : "pinTab")}</button>}
        <button role="menuitem" onClick={() => { setContextTabId(""); onClose(contextTab.id); }}><X size={12} />{t(lang, "close")}</button>
        {onCloseMany && <>
          <div className="tab-context-divider" />
          <button role="menuitem" disabled={closingTabs || !closeTabTargets(orderedTabs, contextTab.id, "others").length} onClick={() => { setContextTabId(""); void onCloseMany(closeTabTargets(orderedTabs, contextTab.id, "others")); }}>{t(lang, "closeOtherTabs")}</button>
          <button role="menuitem" disabled={closingTabs || !closeTabTargets(orderedTabs, contextTab.id, "right").length} onClick={() => { setContextTabId(""); void onCloseMany(closeTabTargets(orderedTabs, contextTab.id, "right")); }}>{t(lang, "closeTabsToRight")}</button>
        </>}
      </div>}
    </div>
  );
}
