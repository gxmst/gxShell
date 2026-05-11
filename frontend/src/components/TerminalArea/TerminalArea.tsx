import clsx from "clsx";
import { Plus, Search, TerminalSquare } from "lucide-react";
import type { Tab } from "../../types";
import { TabBar } from "../TabBar/TabBar";
import { types } from "../../../wailsjs/go/models";

export function TerminalArea(props: {
  tabs: Tab[];
  activeTab: string;
  profiles: types.Profile[];
  terminalHosts: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onActive: (id: string) => void;
  onClose: (id: string) => void;
  onReconnect: (tab: Tab) => void;
  onNewConnection: () => void;
  onCommandPalette: () => void;
}) {
  return (
    <section className="terminal-pane">
      <TabBar tabs={props.tabs} activeTab={props.activeTab} profiles={props.profiles} onActive={props.onActive} onClose={props.onClose} onReconnect={props.onReconnect} />
      <div className="terminal-stage">
        {props.tabs.map((tab) => (
          <div key={tab.id} className={clsx("terminal-host", props.activeTab === tab.id ? "block" : "hidden")} ref={(el) => { props.terminalHosts.current[tab.id] = el; }} />
        ))}
        {!props.tabs.length && (
          <div className="terminal-empty">
            <div className="terminal-empty-card">
              <TerminalSquare className="mx-auto mb-3 h-11 w-11 text-muted" />
              <div className="text-lg font-semibold">No active terminal</div>
              <div className="mt-1 text-sm text-muted">Double click a server, or press Ctrl+K to search.</div>
              <div className="mt-4 flex justify-center gap-2">
                <button className="btn-primary" onClick={props.onNewConnection}><Plus size={15} /> New connection</button>
                <button className="btn-secondary" onClick={props.onCommandPalette}><Search size={15} /> Open command palette</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
