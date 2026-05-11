import clsx from "clsx";
import { Edit3, MoreHorizontal, Play, Plus, Search } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import type { Drawer, Tab, Toast } from "../../types";
import { AppIcon, drawerIcon, emptyProfile, navLabel } from "../../constants";
import { MonitorPanel } from "../MonitorPanel/MonitorPanel";
import { SftpPanel } from "../SftpPanel/SftpPanel";
import { CommandPanel } from "../CommandPanel/CommandPanel";
import { SettingsPanel } from "../SettingsPanel/SettingsPanel";

export function Sidebar(props: {
  collapsed: boolean;
  setCollapsed: (value: boolean | ((value: boolean) => boolean)) => void;
  drawer: Drawer;
  setDrawer: (drawer: Drawer) => void;
  profiles: types.Profile[];
  commands: types.CommandTemplate[];
  settings: types.AppSettings | null;
  appInfo: Record<string, string>;
  active?: Tab;
  activeMetrics?: types.Metrics;
  remotePath: string;
  remoteFiles: types.RemoteFile[];
  sftpBusy: boolean;
  onNewProfile: () => void;
  onEditProfile: (profile: types.Profile) => void;
  onConnectProfile: (profile: types.Profile) => void;
  onOpenSearch: () => void;
  onStartMonitor: () => void;
  onRefreshSftp: (path?: string) => void;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
  onRunCommand: (command: types.CommandTemplate) => void;
  onEditCommand: (command: types.CommandTemplate) => void;
  onDeleteCommand: (id: string) => void;
  onNewCommand: () => void;
  onSaveSettings: (settings: types.AppSettings) => void;
  onOpenData: () => void;
}) {
  return (
    <aside className="left-rail">
      <section className="side-content">
        <div className="brand-row">
          <div className="brand-mark"><AppIcon /></div>
          <div className="min-w-0">
            <div className="brand-name">gxShell</div>
            <div className="brand-meta">v1.0 · Ctrl+K</div>
          </div>
          <button className="icon-btn ml-auto" onClick={() => props.setCollapsed((value) => !value)} title="Collapse sidebar"><MoreHorizontal size={15} /></button>
        </div>

        <div className="nav-strip">
          {(["monitor", "sftp", "commands", "settings"] as Drawer[]).map((item) => (
            <button key={item} className={clsx("nav-chip", props.drawer === item && "nav-chip-active")} onClick={() => props.setDrawer(item)} title={item}>
              {drawerIcon(item)} <span>{navLabel(item)}</span>
            </button>
          ))}
        </div>

        <div className="section-title">
          <span>Servers</span>
          <button className="text-button" onClick={props.onNewProfile}><Plus size={13} /> New</button>
          <button className="text-button" onClick={props.onOpenSearch}><Search size={13} /> Search</button>
        </div>
        <div className="server-list">
          {props.profiles.map((profile) => (
            <div key={profile.id} className="server-row group" onDoubleClick={() => props.onConnectProfile(profile)}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="status-dot bg-muted" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{profile.name || profile.host}</div>
                  <div className="truncate text-xs text-muted">{profile.username}@{profile.host}:{profile.port}</div>
                </div>
              </div>
              <div className="row-actions">
                <button className="mini-btn" onClick={() => props.onConnectProfile(profile)} title="Connect"><Play size={13} /></button>
                <button className="mini-btn" onClick={() => props.onEditProfile(profile)} title="Edit"><Edit3 size={13} /></button>
              </div>
            </div>
          ))}
          {!props.profiles.length && <div className="empty">No servers yet. Create one to begin.</div>}
        </div>

        <div className="current-server-block">
          <div className="section-title subtle">
            <span>{props.drawer === "monitor" ? "Current Server" : navLabel(props.drawer)}</span>
          </div>
          <div className="tool-body">
            {props.drawer === "monitor" && <MonitorPanel metrics={props.activeMetrics} active={props.active} onStart={props.onStartMonitor} />}
            {props.drawer === "sftp" && <SftpPanel active={props.active} path={props.remotePath} files={props.remoteFiles} busy={props.sftpBusy} onRefresh={props.onRefreshSftp} onNotify={props.onNotify} />}
            {props.drawer === "commands" && <CommandPanel commands={props.commands} active={props.active} onRun={props.onRunCommand} onEdit={props.onEditCommand} onDelete={props.onDeleteCommand} onNew={props.onNewCommand} />}
            {props.drawer === "settings" && props.settings && <SettingsPanel settings={props.settings} onSave={props.onSaveSettings} onOpenData={props.onOpenData} dataDir={props.appInfo.dataDir || ""} />}
          </div>
        </div>
      </section>
    </aside>
  );
}

