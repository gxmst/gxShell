import clsx from "clsx";
import { memo } from "react";
import { Plus, TerminalSquare, X } from "lucide-react";
import type { Tab } from "../../types";
import { TabBar } from "../TabBar/TabBar";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

export const TerminalArea = memo(function TerminalArea(props: {
  tabs: Tab[];
  activeTab: string;
  profiles: types.Profile[];
  terminalHosts: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onActive: (id: string) => void;
  onClose: (id: string) => void;
  onReconnect: (tab: Tab) => void;
  onNewConnection: () => void;
  onTearOff?: (tab: Tab) => void;
  language: string;
  logViewer?: { name: string; content: string } | null;
  onCloseLogViewer?: () => void;
  floatingTabIds?: string[];
}) {
  const lang = props.language;
  const floatingSet = new Set(props.floatingTabIds || []);
  const visibleTabs = props.tabs.filter((tab) => !floatingSet.has(tab.id));
  return (
    <section className="terminal-pane">
      <TabBar tabs={visibleTabs} activeTab={props.activeTab} profiles={props.profiles} sidebarCollapsed={props.sidebarCollapsed} onToggleSidebar={props.onToggleSidebar} onActive={props.onActive} onClose={props.onClose} onReconnect={props.onReconnect} onTearOff={props.onTearOff} />
      <div className="terminal-stage">
        {props.tabs.map((tab) => (
          <div key={tab.id} data-tab-id={tab.id} className={clsx("terminal-host", (props.activeTab !== tab.id || floatingSet.has(tab.id)) && "terminal-hidden")} ref={(el) => { props.terminalHosts.current[tab.id] = el; }} />
        ))}
        {props.logViewer && (
          <div className="log-viewer-overlay">
            <div className="log-viewer-header">
              <span className="log-viewer-title">{props.logViewer.name}</span>
              <button className="mini-btn" onClick={props.onCloseLogViewer}><X size={12} /></button>
            </div>
            <pre className="log-viewer-content">{props.logViewer.content}</pre>
          </div>
        )}
        {!visibleTabs.length && !props.logViewer && (
          <div className="terminal-empty">
            <div className="terminal-empty-card">
              <TerminalSquare className="mx-auto mb-3 h-11 w-11 text-muted" />
              <div className="text-lg font-semibold">{t(lang, "noActiveTerminal")}</div>
              <div className="mt-1 text-sm text-muted">{t(lang, "noActiveTerminalHint")}</div>
              <div className="mt-4 flex justify-center">
                <button className="btn-primary" onClick={props.onNewConnection}><Plus size={15} /> {t(lang, "newConnection")}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
});
