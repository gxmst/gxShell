import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Bot, Edit3, FileText, Folder, MoreHorizontal, Play, Plus, Search, Server, Settings, Trash2, X, ArrowUpRight } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { TraceRoute, PingHost, UpdateSettings } from "../../../wailsjs/go/main/App";
import type { Drawer, RecentMarkdownItem, Tab, Toast } from "../../types";
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
import { MonitorDetailCard, type MonitorDetailKind } from "../MonitorDetailCard/MonitorDetailCard";

type FloatKey = "path" | "memory" | MonitorDetailKind;
type PrimaryNav = "connections" | "files" | "tools";
type FileMode = "remote" | "text";

const toolDrawers: Drawer[] = ["commands", "tunnels", "containers", "logs"];

function primaryForDrawer(drawer: Drawer): PrimaryNav | "ai" | "settings" {
  if (drawer === "monitor") return "connections";
  if (drawer === "sftp") return "files";
  if (drawer === "ai") return "ai";
  if (drawer === "settings") return "settings";
  return "tools";
}

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
  markdownSiblings?: string[];
  recentMarkdown?: RecentMarkdownItem[];
  onOpenMarkdownFile?: (path: string) => void;
  onOpenRemoteMarkdownFile?: (sessionId: string, path: string) => void;
  onOpenRecentMarkdown?: (item: RecentMarkdownItem) => void;
  onRemoveRecentMarkdown?: (id: string) => void;
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
  const appVersion = props.appInfo.version || "1.1.3";
  const [splitPct, setSplitPct] = useState(45);
  const dragRef = useRef({ active: false, startY: 0, startPct: 0 });
  const splitRef = useRef(splitPct);
  splitRef.current = splitPct;

  const [floats, setFloats] = useState<Record<FloatKey, boolean>>({ path: false, memory: false, cpu: false, disk: false, network: false });

  const [activeGroup, setActiveGroup] = useState<string>("__all__");
  const [fileMode, setFileMode] = useState<FileMode>("remote");

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
  const activePrimary = primaryForDrawer(props.drawer);
  const activeIsMarkdown = props.active?.type === "markdown";
  const titleText = {
    connections: lang === "zh-CN" ? "连接" : "Connect",
    files: lang === "zh-CN" ? "文件" : "Files",
    tools: lang === "zh-CN" ? "工具" : "Tools",
  };
  const openPrimary = (nav: PrimaryNav) => {
    if (nav === "connections") props.setDrawer("monitor");
    if (nav === "files") props.setDrawer("sftp");
    if (nav === "tools") props.setDrawer(toolDrawers.includes(props.drawer) ? props.drawer : "commands");
  };

  return (
    <aside className="left-rail" ref={sidebarEl}>
      <section
        className={clsx("side-content", !isMonitor && "side-content-tool")}
        style={isMonitor ? { gridTemplateRows: `auto auto auto auto ${splitPct}fr 6px ${100 - splitPct}fr` } : { gridTemplateRows: "auto auto auto 1fr" }}
      >
        <div className="brand-row">
          <div className="brand-mark"><AppIcon /></div>
          <div className="min-w-0">
            <div className="brand-name">gxShell</div>
            <div className="brand-meta">v{appVersion} / Ctrl+K</div>
          </div>
          <button className="icon-btn ml-auto" onClick={() => props.setCollapsed((value) => !value)} title={t(lang, "collapse")}><MoreHorizontal size={15} /></button>
        </div>

        <div className="nav-strip">
          {(["connections", "files", "tools"] as PrimaryNav[]).map((item) => (
            <button key={item} className={clsx("nav-chip", activePrimary === item && "nav-chip-active")} onClick={() => openPrimary(item)} title={titleText[item]}>
              {item === "connections" ? <Server size={14} /> : item === "files" ? <Folder size={14} /> : drawerIcon("commands", 14)}
              <span>{titleText[item]}</span>
            </button>
          ))}
          <div className="nav-aux">
            <button className={clsx("nav-icon-chip", props.drawer === "ai" && "nav-chip-active")} onClick={() => props.setDrawer("ai")} title={navLabel("ai", lang)}>
              <Bot size={14} />
            </button>
            <button className={clsx("nav-icon-chip", props.drawer === "settings" && "nav-chip-active")} onClick={() => props.setDrawer("settings")} title={navLabel("settings", lang)}>
              <Settings size={14} />
            </button>
          </div>
        </div>

        {activePrimary === "connections" && (
          <>
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
                  <div className="server-row-main">
                    <span className={clsx("status-dot", props.active?.profileId === profile.id ? stateClass(props.active.state) : "bg-muted")} />
                    <div className="server-row-text">
                      <div className="server-title">{profile.name || profile.host}</div>
                      <div className="server-subtitle">{profile.username}@{profile.host}:{profile.port}{profile.proxyJumpId && <ArrowUpRight size={10} className="inline ml-1 opacity-50" />}</div>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="mini-btn" onClick={() => props.onConnectProfile(profile)} title={t(lang, "connect")}><Play size={13} /></button>
                    <button className="mini-btn" onClick={() => props.onEditProfile(profile)} title={t(lang, "editServer")}><Edit3 size={13} /></button>
                    <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); props.onDeleteProfile(profile.id); }} title={t(lang, "delete")}><Trash2 size={12} /></button>
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
                <MonitorPanel
                  metrics={props.activeMetrics}
                  active={props.active}
                  locale={lang}
                  onStart={props.onStartMonitor}
                  onCpuClick={props.active ? () => openFloat("cpu") : undefined}
                  onPingClick={props.active ? () => openFloat("path") : undefined}
                  onNetworkClick={props.active ? () => openFloat("network") : undefined}
                  onDiskClick={props.active ? () => openFloat("disk") : undefined}
                  onMemClick={props.active ? () => openFloat("memory") : undefined}
                />
              </div>
            </div>
          </>
        )}

        {activePrimary !== "connections" && (
          <div className="section-title sidebar-panel-title">
            <span>{activePrimary === "files" ? titleText.files : activePrimary === "tools" ? titleText.tools : navLabel(props.drawer, lang)}</span>
            {activePrimary === "files" && (
              <div className="section-switch" title={t(lang, "switchFilesView")}>
                <button className={clsx(fileMode === "remote" && "active")} onClick={() => setFileMode("remote")} title={t(lang, "remote")}>
                  <Folder size={11} />
                </button>
                <button className={clsx(fileMode === "text" && "active")} onClick={() => setFileMode("text")} title={t(lang, "recentTextFiles")}>
                  <FileText size={11} />
                </button>
              </div>
            )}
          </div>
        )}

        {activePrimary !== "connections" && <div className="tool-body-full">
          {props.drawer === "sftp" && fileMode === "remote" && (
            <div className="space-y-2">
              {props.markdownSiblings && props.markdownSiblings.length > 0 && (
                <div className="markdown-file-list">
                  <div className="section-title subtle"><span>{t(lang, "textFiles")}</span></div>
                  <div className="server-list">
                    {props.markdownSiblings.map((file) => {
                      const isActive = props.active?.type === "markdown" && (props.active?.filePath === file || props.active?.remotePath === file);
                      return (
                        <div key={file} className={clsx("server-row cursor-pointer", isActive && "bg-accent/10")} onClick={() => props.onOpenMarkdownFile?.(file)}>
                          <div className="server-row-main">
                            <FileText size={14} className={clsx("shrink-0", isActive ? "text-accent" : "text-muted")} />
                            <div className="server-title">{file.split(/[\\/]/).pop()}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {activeIsMarkdown ? (
                <div className="empty compact">{t(lang, "connectFirstSftp")}</div>
              ) : (
                <SftpPanel active={props.active} path={props.remotePath} files={props.remoteFiles} busy={props.sftpBusy} locale={lang} onRefresh={props.onRefreshSftp} onNotify={props.onNotify} setCtxMenu={props.setCtxMenu} onOpenMarkdownFile={props.onOpenRemoteMarkdownFile} />
              )}
            </div>
          )}
          {props.drawer === "sftp" && fileMode === "text" && (
            <div className="server-list">
              {(props.recentMarkdown || []).map((item) => (
                <div key={item.id} className="server-row markdown-recent-row" onDoubleClick={() => props.onOpenRecentMarkdown?.(item)}>
                  <div className="server-row-main">
                    <FileText size={14} className={clsx("shrink-0", item.source === "remote" ? "text-accent" : "text-muted")} />
                    <div className="server-row-text">
                      <div className="server-title">{item.title}</div>
                      <div className="server-subtitle">{item.source === "remote" ? (item.host || t(lang, "remote")) : t(lang, "local")} / {item.path}</div>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="mini-btn" onClick={() => props.onOpenRecentMarkdown?.(item)} title={t(lang, "openTextFile")}><Play size={12} /></button>
                    <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); props.onRemoveRecentMarkdown?.(item.id); }} title={t(lang, "remove")}><X size={12} /></button>
                  </div>
                </div>
              ))}
              {!(props.recentMarkdown || []).length && <div className="empty">{t(lang, "noRecentTextFiles")}</div>}
            </div>
          )}
          {activePrimary === "tools" && (
            <>
              <div className="subnav-strip">
                {toolDrawers.map((item) => (
                  <button key={item} className={clsx("subnav-chip", props.drawer === item && "subnav-chip-active")} onClick={() => props.setDrawer(item)} title={navLabel(item, lang)}>
                    {drawerIcon(item, 13)}
                    <span>{navLabel(item, lang)}</span>
                  </button>
                ))}
              </div>
              <div className="tool-panel-body">
                {props.drawer === "commands" && <CommandPanel commands={props.commands} active={props.active} locale={lang} onRun={props.onRunCommand} onRunAll={props.onRunCommandAll} onEdit={props.onEditCommand} onDelete={props.onDeleteCommand} onNew={props.onNewCommand} />}
                {props.drawer === "tunnels" && <TunnelPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "logs" && <LogsPanel locale={lang} onOpenLog={props.onOpenLog} />}
                {props.drawer === "containers" && <ContainerPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
              </div>
            </>
          )}
          {props.drawer === "ai" && <AiPanel active={props.active} locale={lang} onNotify={props.onNotify} getTerminalLines={props.getTerminalLines} activeTabId={props.activeTabId} />}
          {props.drawer === "settings" && props.settings && <SettingsPanel settings={props.settings} language={lang} onSave={props.onSaveSettings} onOpenData={props.onOpenData} dataDir={props.appInfo.dataDir || ""} onNotify={props.onNotify} />}
        </div>}
      </section>

      {floats.path && props.active && (
        <NetworkPathCard
          sessionId={props.active.id}
          initialLeft={floatLeft()}
          initialTop={60}
          locale={lang}
          onClose={() => closeFloat("path")}
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

      {(["cpu", "disk", "network"] as MonitorDetailKind[]).map((kind) => floats[kind] ? (
        <MonitorDetailCard
          key={kind}
          kind={kind}
          metrics={props.activeMetrics}
          initialLeft={floatLeft()}
          initialTop={kind === "cpu" ? 60 : kind === "disk" ? 90 : 120}
          locale={lang}
          onClose={() => closeFloat(kind)}
        />
      ) : null)}
    </aside>
  );
}
