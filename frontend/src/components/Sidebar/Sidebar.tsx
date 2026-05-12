import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Download as DownloadIcon, Edit3, MoreHorizontal, Play, Plus, Search } from "lucide-react";
import { useTransfers } from "../../hooks/useTransfers";
import { types } from "../../../wailsjs/go/models";
import type { Drawer, Tab, Toast } from "../../types";
import { AppIcon, drawerIcon } from "../../constants";
import { stateClass } from "../../utils/format";
import { t, navLabel } from "../../i18n";
import { MonitorPanel } from "../MonitorPanel/MonitorPanel";
import { SftpPanel } from "../SftpPanel/SftpPanel";
import { CommandPanel } from "../CommandPanel/CommandPanel";
import { SettingsPanel } from "../SettingsPanel/SettingsPanel";

export function Sidebar(props: {
  collapsed: boolean;
  setCollapsed: (value: boolean | ((value: boolean) => boolean)) => void;
  setCtxMenu: any;
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
  const lang = props.settings?.language || "en";
  const { activeCount } = useTransfers();
  const navItems: (Drawer | "downloads")[] = activeCount > 0
    ? ["monitor", "sftp", "commands", "downloads", "settings"]
    : ["monitor", "sftp", "commands", "settings"];
  const [splitPct, setSplitPct] = useState(45);
  const dragRef = useRef({ active: false, startY: 0, startPct: 0 });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragRef.current = { active: true, startY: e.clientY, startPct: splitPct };
    e.preventDefault();
  }, [splitPct]);

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current.active) return;
    const parent = document.querySelector(".side-content");
    if (!parent || parent.clientHeight <= 0) return;
    const dy = e.clientY - dragRef.current.startY;
    const maxPct = Math.max(20, Math.min(75, dragRef.current.startPct + (dy / parent.clientHeight) * 100));
    setSplitPct(maxPct);
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current.active = false;
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => onDragMove(e);
    const end = () => onDragEnd();
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
    };
  }, [onDragMove, onDragEnd]);
  return (
    <aside className="left-rail">
      <section className="side-content" style={{ gridTemplateRows: `auto auto auto ${splitPct}fr 6px ${100-splitPct}fr` }}>
        <div className="brand-row">
          <div className="brand-mark"><AppIcon /></div>
          <div className="min-w-0">
            <div className="brand-name">gxShell</div>
            <div className="brand-meta">v1.0 · Ctrl+K</div>
          </div>
          <button className="icon-btn ml-auto" onClick={() => props.setCollapsed((value) => !value)} title={t(lang, "collapse")}><MoreHorizontal size={15} /></button>
        </div>

        <div className="nav-strip">
          {navItems.map((item) => (
            <button key={item} className={clsx("nav-chip", props.drawer === item && "nav-chip-active")} onClick={() => {
              if (item !== "downloads") props.setDrawer(item as Drawer);
            }} title={item === "downloads" ? "Downloads" : navLabel(item, lang)}>
              {item === "downloads" ? <DownloadIcon size={15} /> : drawerIcon(item as Drawer)}
              <span>{item === "downloads" ? (activeCount > 0 ? `${activeCount}` : "DL") : navLabel(item, lang)}</span>
            </button>
          ))}
        </div>

        <div className="section-title">
          <span>{t(lang, "servers")}</span>
          <button className="text-button" onClick={props.onNewProfile}><Plus size={13} /> {t(lang, "new")}</button>
          <button className="text-button" onClick={props.onOpenSearch}><Search size={13} /> {t(lang, "search")}</button>
        </div>
        <div className="server-list">
          {props.profiles.map((profile) => (
            <div key={profile.id} className="server-row group" onDoubleClick={() => props.onConnectProfile(profile)}>
              <div className="flex min-w-0 items-center gap-2">
                <span className={clsx("status-dot", props.active?.profileId === profile.id ? stateClass(props.active.state) : "bg-muted")} />
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
          {!props.profiles.length && <div className="empty">{t(lang, "noServers")}</div>}
        </div>

        <div className="split-handle" onMouseDown={onDragStart} />

        <div className="current-server-block">
          <div className="section-title subtle">
            <span>{props.drawer === "monitor" ? t(lang, "currentServer") : navLabel(props.drawer, lang)}</span>
          </div>
          <div className="tool-body">
            {props.drawer === "monitor" && <MonitorPanel metrics={props.activeMetrics} active={props.active} onStart={props.onStartMonitor} />}
            {props.drawer === "sftp" && <SftpPanel active={props.active} path={props.remotePath} files={props.remoteFiles} busy={props.sftpBusy} onRefresh={props.onRefreshSftp} onNotify={props.onNotify} setCtxMenu={props.setCtxMenu} />}
            {props.drawer === "commands" && <CommandPanel commands={props.commands} active={props.active} onRun={props.onRunCommand} onEdit={props.onEditCommand} onDelete={props.onDeleteCommand} onNew={props.onNewCommand} />}
            {props.drawer === "settings" && props.settings && <SettingsPanel settings={props.settings} onSave={props.onSaveSettings} onOpenData={props.onOpenData} dataDir={props.appInfo.dataDir || ""} />}
            {props.drawer === "downloads" && <DownloadList />}
          </div>
        </div>
      </section>
    </aside>
  );
}

function DownloadList() {
  const { transfers } = useTransfers();
  const items = Object.entries(transfers);
  if (!items.length) return <div className="empty compact">No active downloads.</div>;
  return (
    <div className="space-y-1">
      {items.map(([key, t]) => {
        const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
        const name = t.path.split(/[\\/]/).pop() || t.path;
        return (
          <div key={key} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[10px] border border-border/40" style={{ background: "color-mix(in srgb, var(--panel-raised) 60%, transparent)" }}>
            <DownloadIcon size={12} className="text-accent shrink-0" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--accent)" }} />
              </div>
              <span className="text-muted w-7 text-right tabular-nums">{pct}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
