import clsx from "clsx";
import { useCallback, useEffect, useRef } from "react";
import { Columns2, PanelLeft, RefreshCw, Rows2, X } from "lucide-react";
import type { SplitDirection, Tab } from "../../types";
import { stateClass } from "../../utils/format";
import { types } from "../../../wailsjs/go/models";

export function TabBar({ tabs, activeTab, profiles, sidebarCollapsed, onToggleSidebar, onActive, onClose, onReconnect, onTearOff, onSplitToggle }: { tabs: Tab[]; activeTab: string; profiles: types.Profile[]; sidebarCollapsed: boolean; onToggleSidebar: () => void; onActive: (id: string) => void; onClose: (id: string) => void; onReconnect: (tab: Tab) => void; onTearOff?: (tab: Tab) => void; onSplitToggle?: (tabId: string, direction: SplitDirection) => void }) {
  const active = tabs.find((tab) => tab.id === activeTab);
  const dragRef = useRef<{ tabId: string; startX: number; startY: number; active: boolean } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const onTearOffRef = useRef(onTearOff);
  onTearOffRef.current = onTearOff;

  const onTabMouseDown = useCallback((e: React.MouseEvent, tab: Tab) => {
    if (e.button !== 0) return;
    dragRef.current = { tabId: tab.id, startX: e.clientX, startY: e.clientY, active: false };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.active && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        d.active = true;
      }
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.active) {
        const tabbar = document.querySelector(".tabbar");
        if (tabbar) {
          const rect = tabbar.getBoundingClientRect();
          if (e.clientY < rect.top || e.clientY > rect.bottom || e.clientX < rect.left || e.clientX > rect.right) {
            const tab = tabsRef.current.find((t) => t.id === d.tabId);
            if (tab && onTearOffRef.current) {
              onTearOffRef.current(tab);
              dragRef.current = null;
              return;
            }
          }
        }
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="tabbar">
      {sidebarCollapsed && (
        <button className="tab-action" onClick={onToggleSidebar} title="Show sidebar"><PanelLeft size={14} /></button>
      )}
      <div className="tabs-scroll">
        {tabs.map((tab) => {
          const profile = profiles.find((item) => item.id === tab.profileId);
          const full = profile ? `${profile.username}@${profile.host}:${profile.port}` : tab.title;
          return (
            <button key={tab.id} title={full} className={clsx("tab", activeTab === tab.id && "tab-active")} onClick={() => onActive(tab.id)} onMouseDown={(e) => onTabMouseDown(e, tab)}>
              <span className={clsx("status-dot", stateClass(tab.state))} />
              <span className="max-w-[180px] truncate">{tab.title}</span>
              <X size={14} onClick={(e) => { e.stopPropagation(); onClose(tab.id); }} />
            </button>
          );
        })}
      </div>
      <div className="tab-actions">
        <button className="tab-action" disabled={!active || tabs.length < 2} onClick={() => active && onSplitToggle?.(active.id, "horizontal")} title="Split Horizontal"><Columns2 size={14} /></button>
        <button className="tab-action" disabled={!active || tabs.length < 2} onClick={() => active && onSplitToggle?.(active.id, "vertical")} title="Split Vertical"><Rows2 size={14} /></button>
        <button className="tab-action" disabled={!active} onClick={() => active && onReconnect(active)}><RefreshCw size={14} /></button>
      </div>
    </div>
  );
}
