import clsx from "clsx";
import { RefreshCw, X } from "lucide-react";
import type { Tab } from "../../types";
import { stateClass } from "../../utils/format";
import { types } from "../../../wailsjs/go/models";

export function TabBar({ tabs, activeTab, profiles, onActive, onClose, onReconnect }: { tabs: Tab[]; activeTab: string; profiles: types.Profile[]; onActive: (id: string) => void; onClose: (id: string) => void; onReconnect: (tab: Tab) => void }) {
  const active = tabs.find((tab) => tab.id === activeTab);
  return (
    <div className="tabbar">
      <div className="tabs-scroll">
        {tabs.map((tab) => {
          const profile = profiles.find((item) => item.id === tab.profileId);
          const full = profile ? `${profile.username}@${profile.host}:${profile.port}` : tab.title;
          return (
            <button key={tab.id} title={full} className={clsx("tab", activeTab === tab.id && "tab-active")} onClick={() => onActive(tab.id)}>
              <span className={clsx("status-dot", stateClass(tab.state))} />
              <span className="max-w-[180px] truncate">{tab.title}</span>
              <X size={14} onClick={(e) => { e.stopPropagation(); onClose(tab.id); }} />
            </button>
          );
        })}
      </div>
      <div className="tab-actions">
        <button className="tab-action" disabled={!active} onClick={() => active && onReconnect(active)}><RefreshCw size={14} /></button>
      </div>
    </div>
  );
}

