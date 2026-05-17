import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Edit3, MoreHorizontal, Play, Plus, Search, Trash2, ArrowUpRight } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { TraceRoute, PingHost, UpdateSettings } from "../../../wailsjs/go/main/App";
import type { Drawer, Tab, Toast } from "../../types";
import { AppIcon, drawerIcon } from "../../constants";
import { stateClass } from "../../utils/format";
import { t, navLabel } from "../../i18n";
import { MonitorPanel } from "../MonitorPanel/MonitorPanel";
import { SftpPanel } from "../SftpPanel/SftpPanel";
import { CommandPanel } from "../CommandPanel/CommandPanel";
import { SettingsPanel } from "../SettingsPanel/SettingsPanel";
import { TunnelPanel } from "../TunnelPanel/TunnelPanel";
import { LogsPanel } from "../LogsPanel/LogsPanel";
import { AiPanel } from "../AiPanel/AiPanel";
import { ContainerPanel } from "../ContainerPanel/ContainerPanel";
import { NetworkPathCard } from "../NetworkPathCard/NetworkPathCard";
import { MemoryCard } from "../MemoryCard/MemoryCard";

type FloatKey = "network" | "memory";

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
  onDeleteProfile: (id: string) => void;
  onOpenSearch: () => void;
  onStartMonitor: () => void;
  onRefreshSftp: (path?: string) => void;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
  onRunCommand: (command: types.CommandTemplate) => void;
  onRunCommandAll: (command: types.CommandTemplate) => void;
  onEditCommand: (command: types.CommandTemplate) => void;
  onDeleteCommand: (id: string) => void;
  onNewCommand: () => void;
  onSaveSettings: (settings: types.AppSettings) => void;
  onOpenData: () => void;
  onOpenLog: (name: string) => void;
  getTerminalLines: (id: string, lineCount: number) => string;
  activeTabId: string;
}) {
  const lang = props.settings?.language || "en";
  const navItems: Drawer[] = ["monitor", "sftp", "commands", "tunnels", "logs", "containers", "ai", "settings"];
  const [splitPct, setSplitPct] = useState(45);
  const dragRef = useRef({ active: false, startY: 0, startPct: 0 });
  const splitRef = useRef(splitPct);
  splitRef.current = splitPct;

  const [floats, setFloats] = useState<Record<FloatKey, boolean>>({ network: false, memory: false });

  const [activeGroup, setActiveGroup] = useState<string>("__all__");

  const groups = useMemo(() => {
    const set = new Set<string>();
    props.profiles.forEach((p) => {
      set.add(p.group || "");
    });
    return Array.from(set);
  }, [props.profiles]);

  const filteredProfiles = useMemo(() => {
    if (activeGroup === "__all__") return props.profiles;
    return props.profiles.filter((p) => (p.group || "") === activeGroup);
  }, [props.profiles, activeGroup]);

  const openFloat = useCallback((key: FloatKey) => setFloats((prev) => ({ ...prev, [key]: true })), []);
  const closeFloat = useCallback((key: FloatKey) => setFloats((prev) => ({ ...prev, [key]: false })), []);

  useEffect(() => {
    if (props.settings?.sidebarSplitPct) {
      setSplitPct(props.settings.sidebarSplitPct);
    }
  }, [props.settings?.sidebarSplitPct]);

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
    if (props.settings) {
      const next = new types.AppSettings({ ...props.settings, sidebarSplitPct: Math.round(splitRef.current) });
      UpdateSettings(next).catch(() => {});
    }
  }, [props.settings]);

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

  const sidebarEl = useRef<HTMLElement>(null);
  const floatLeft = () => {
    if (sidebarEl.current) {
      const r = sidebarEl.current.getBoundingClientRect();
      return r.right + 8;
    }
    return 300;
  };

  const isMonitor = props.drawer === "monitor";

  return (
    <aside className="left-rail" ref={sidebarEl}>
      {isMonitor ? (
        <section className="side-content" style={{ gridTemplateRows: `auto auto auto auto ${splitPct}fr 6px ${100 - splitPct}fr` }}>
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
              <button key={item} className={clsx("nav-chip", props.drawer === item && "nav-chip-active")} onClick={() => props.setDrawer(item)} title={navLabel(item, lang)}>
                {drawerIcon(item)}
                <span>{navLabel(item, lang)}</span>
              </button>
            ))}
          </div>

          <div className="section-title">
            <span>{t(lang, "servers")}</span>
            <button className="text-button" onClick={props.onNewProfile}><Plus size={13} /> {t(lang, "new")}</button>
            <button className="text-button" onClick={props.onOpenSearch}><Search size={13} /> {t(lang, "search")}</button>
          </div>
          {groups.length > 1 && (
            <div className="group-tabs">
              <button className={clsx("group-tab", activeGroup === "__all__" && "group-tab-active")} onClick={() => setActiveGroup("__all__")}>{t(lang, "allGroups")}</button>
              {groups.map((g) => (
                <button key={g} className={clsx("group-tab", activeGroup === g && "group-tab-active")} onClick={() => setActiveGroup(g)}>{g || t(lang, "defaultGroup")}</button>
              ))}
            </div>
          )}
          <div className="server-list">
            {filteredProfiles.map((profile) => (
              <div key={profile.id} className="server-row group" onDoubleClick={() => props.onConnectProfile(profile)}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className={clsx("status-dot", props.active?.profileId === profile.id ? stateClass(props.active.state) : "bg-muted")} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{profile.name || profile.host}</div>
                    <div className="truncate text-xs text-muted">{profile.username}@{profile.host}:{profile.port}{profile.proxyJumpId && <ArrowUpRight size={10} className="inline ml-1 opacity-50" />}</div>
                  </div>
                </div>
                <div className="row-actions">
                  <button className="mini-btn" onClick={() => props.onConnectProfile(profile)} title="Connect"><Play size={13} /></button>
                  <button className="mini-btn" onClick={() => props.onEditProfile(profile)} title="Edit"><Edit3 size={13} /></button>
                  <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); props.onDeleteProfile(profile.id); }} title="Delete"><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
            {!filteredProfiles.length && <div className="empty">{t(lang, "noServers")}</div>}
          </div>

          <div className="split-handle" onMouseDown={onDragStart} />

          <div className="current-server-block">
            <div className="section-title subtle">
              <span>{t(lang, "currentServer")}</span>
            </div>
            <div className="tool-body">
              <MonitorPanel metrics={props.activeMetrics} active={props.active} locale={lang} onStart={props.onStartMonitor} onPingClick={props.active ? () => openFloat("network") : undefined} onMemClick={props.active ? () => openFloat("memory") : undefined} />
            </div>
          </div>
        </section>
      ) : (
        <section className="side-content side-content-tool" style={{ gridTemplateRows: "auto auto 1fr" }}>
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
              <button key={item} className={clsx("nav-chip", props.drawer === item && "nav-chip-active")} onClick={() => props.setDrawer(item)} title={navLabel(item, lang)}>
                {drawerIcon(item)}
                <span>{navLabel(item, lang)}</span>
              </button>
            ))}
          </div>

          <div className="tool-body-full">
            {props.drawer === "sftp" && <SftpPanel active={props.active} path={props.remotePath} files={props.remoteFiles} busy={props.sftpBusy} locale={lang} onRefresh={props.onRefreshSftp} onNotify={props.onNotify} setCtxMenu={props.setCtxMenu} />}
            {props.drawer === "commands" && <CommandPanel commands={props.commands} active={props.active} locale={lang} onRun={props.onRunCommand} onRunAll={props.onRunCommandAll} onEdit={props.onEditCommand} onDelete={props.onDeleteCommand} onNew={props.onNewCommand} />}
            {props.drawer === "tunnels" && <TunnelPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
            {props.drawer === "logs" && <LogsPanel locale={lang} onOpenLog={props.onOpenLog} />}
            {props.drawer === "containers" && <ContainerPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
            {props.drawer === "ai" && <AiPanel active={props.active} locale={lang} onNotify={props.onNotify} getTerminalLines={props.getTerminalLines} activeTabId={props.activeTabId} />}
            {props.drawer === "settings" && props.settings && <SettingsPanel settings={props.settings} language={lang} onSave={props.onSaveSettings} onOpenData={props.onOpenData} dataDir={props.appInfo.dataDir || ""} />}
          </div>
        </section>
      )}

      {floats.network && props.active && (
        <NetworkPathCard
          sessionId={props.active.id}
          initialLeft={floatLeft()}
          initialTop={60}
          locale={lang}
          onClose={() => closeFloat("network")}
          onTraceRoute={TraceRoute}
          onPingHost={PingHost}
        />
      )}

      {floats.memory && (
        <MemoryCard
          metrics={props.activeMetrics}
          initialLeft={floatLeft()}
          initialTop={60}
          locale={lang}
          onClose={() => closeFloat("memory")}
        />
      )}
    </aside>
  );
}
