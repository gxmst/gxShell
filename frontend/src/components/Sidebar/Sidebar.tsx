import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, Bot, Edit3, FileText, Folder, FolderOpen, PanelLeftClose, Play, Plus, Search, Server, Settings, Trash2, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { TraceRoute, PingHost, UpdateSettings } from "../../../wailsjs/go/main/App";
import type { AutomationIndicator, Drawer, RecentMarkdownItem, Tab, Toast } from "../../types";
import { AppIcon, drawerIcon } from "../../constants";
import { stateClass } from "../../utils/format";
import { t, navLabel } from "../../i18n";
import { MonitorPanel } from "../MonitorPanel/MonitorPanel";
import { NetworkPathCard } from "../NetworkPathCard/NetworkPathCard";
import { MemoryCard } from "../MemoryCard/MemoryCard";
import { MonitorDetailCard, type MonitorDetailKind } from "../MonitorDetailCard/MonitorDetailCard";

type FloatKey = "path" | "memory" | MonitorDetailKind;
type PrimaryNav = "connections" | "files" | "tools";
type FileMode = "remote" | "text";

// Tool drawers are not part of the terminal startup path. Loading them on first
// use keeps the initial WebView bundle smaller without changing navigation.
const SftpPanel = lazy(() => import("../SftpPanel/SftpPanel").then((mod) => ({ default: mod.SftpPanel })));
const CommandPanel = lazy(() => import("../CommandPanel/CommandPanel").then((mod) => ({ default: mod.CommandPanel })));
const SettingsPanel = lazy(() => import("../SettingsPanel/SettingsPanel").then((mod) => ({ default: mod.SettingsPanel })));
const TunnelPanel = lazy(() => import("../TunnelPanel/TunnelPanel").then((mod) => ({ default: mod.TunnelPanel })));
const LogsPanel = lazy(() => import("../LogsPanel/LogsPanel").then((mod) => ({ default: mod.LogsPanel })));
const AiPanel = lazy(() => import("../AiPanel/AiPanel").then((mod) => ({ default: mod.AiPanel })));
const ContainerPanel = lazy(() => import("../ContainerPanel/ContainerPanel").then((mod) => ({ default: mod.ContainerPanel })));
const RecordingsPanel = lazy(() => import("../RecordingsPanel/RecordingsPanel").then((mod) => ({ default: mod.RecordingsPanel })));

function DrawerFallback() {
  return <div className="drawer-loading"><span className="drawer-loading-dot" /></div>;
}

const toolDrawers: Drawer[] = ["commands", "tunnels", "containers", "logs", "recordings"];

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
  onPickTextFile?: () => void;
  onOpenRecentMarkdown?: (item: RecentMarkdownItem) => void;
  onRemoveRecentMarkdown?: (id: string) => void;
  onNewProfile: () => void;
  onEditProfile: (profile: types.Profile) => void;
  onConnectProfile: (profile: types.Profile) => void;
  onDeleteProfile: (id: string) => void;
  onOpenSearch: () => void;
  onStartMonitor: () => void;
  onRefreshSftp: (path?: string) => void;
  onOpenTerminalInDir?: (sessionId: string, path: string) => void;
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
  automationByProfile?: Record<string, AutomationIndicator>;
}) {
  const lang = props.settings?.language || "en";
  const appVersion = props.appInfo.version || "1.3.0";
  const [splitPct, setSplitPct] = useState(45);
  const dragRef = useRef({ active: false, startY: 0, startPct: 0 });
  const splitRef = useRef(splitPct);
  splitRef.current = splitPct;

  const [floats, setFloats] = useState<Record<FloatKey, boolean>>({ path: false, memory: false, cpu: false, disk: false, network: false });

  const [activeGroup, setActiveGroup] = useState<string>("__all__");
  const [fileMode, setFileMode] = useState<FileMode>("remote");

  useEffect(() => {
    if (props.drawer === "sftp") setFileMode(props.active?.type === "markdown" ? "text" : "remote");
  }, [props.drawer, props.active?.id, props.active?.type]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    props.profiles.forEach((p) => {
      set.add(p.group || "");
    });
    return Array.from(set);
  }, [props.profiles]);
  const hasGroupTabs = groups.length > 1;

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
  const canBrowseRemote = !!props.active && props.active.type !== "markdown" && !props.active.local && props.active.state === "connected";
  const hasAutomationActivity = useMemo(
    () => Object.values(props.automationByProfile || {}).some((activity) => activity.phase === "started"),
    [props.automationByProfile]
  );
  const titleText = {
    connections: lang === "zh-CN" ? "连接" : "Connect",
    files: lang === "zh-CN" ? "文件" : "Files",
    tools: lang === "zh-CN" ? "工具" : "Tools",
  };
  const sectionKey = props.drawer === "ai" || props.drawer === "settings" ? props.drawer : activePrimary;
  const openPrimary = (nav: PrimaryNav) => {
    if (nav === "connections") props.setDrawer("monitor");
    if (nav === "files") props.setDrawer("sftp");
    if (nav === "tools") props.setDrawer(toolDrawers.includes(props.drawer) ? props.drawer : "commands");
  };

  return (
    <aside className="left-rail" ref={sidebarEl}>
      <section
        className={clsx("side-content", !isMonitor && "side-content-tool")}
        data-section={sectionKey}
        style={isMonitor ? { gridTemplateRows: hasGroupTabs ? `auto auto auto auto ${splitPct}fr 6px ${100 - splitPct}fr` : `auto auto auto ${splitPct}fr 6px ${100 - splitPct}fr` } : { gridTemplateRows: "auto auto 1fr" }}
      >
        <div className="brand-row">
          <div className="brand-mark"><AppIcon /></div>
          <div className="min-w-0">
            <div className="brand-name">gxShell</div>
            <div className="brand-meta">v{appVersion} / Ctrl+K</div>
          </div>
          <button className="icon-btn sidebar-collapse-btn ml-auto" onClick={() => props.setCollapsed((value) => !value)} title={t(lang, "collapse")}><PanelLeftClose size={15} /></button>
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
              {hasAutomationActivity && <span className="automation-nav-dot" />}
            </button>
            <button className={clsx("nav-icon-chip", props.drawer === "settings" && "nav-chip-active")} onClick={() => props.setDrawer("settings")} title={navLabel("settings", lang)}>
              <Settings size={14} />
            </button>
          </div>
        </div>

        {activePrimary === "connections" && (
          <>
            <div className="drawer-hero">
              <div className="drawer-hero-icon"><Server size={16} /></div>
              <div className="drawer-hero-copy">
                <div className="drawer-hero-title">{t(lang, "servers")}</div>
                <div className="drawer-hero-subtitle">{lang === "zh-CN" ? `${filteredProfiles.length} 个可用连接` : `${filteredProfiles.length} available connection${filteredProfiles.length === 1 ? "" : "s"}`}</div>
              </div>
              <div className="drawer-hero-actions">
                <button className="drawer-hero-btn" onClick={props.onOpenSearch} title={t(lang, "search")}><Search size={12} /></button>
                <button className="drawer-hero-btn drawer-hero-btn-primary" onClick={props.onNewProfile} title={t(lang, "new")}><Plus size={12} /></button>
              </div>
            </div>
            {hasGroupTabs && (
              <div className="group-tabs">
                <button className={clsx("group-tab", activeGroup === "__all__" && "group-tab-active")} onClick={() => setActiveGroup("__all__")}>{t(lang, "allGroups")}</button>
                {groups.map((g) => (
                  <button key={g} className={clsx("group-tab", activeGroup === g && "group-tab-active")} onClick={() => setActiveGroup(g)}>{g || t(lang, "defaultGroup")}</button>
                ))}
              </div>
            )}
            <div className="server-list">
              {filteredProfiles.map((profile) => {
                const automation = props.automationByProfile?.[profile.id];
                return (
                <div key={profile.id} className={clsx("server-row group", automation && "server-row-automation")} onDoubleClick={() => props.onConnectProfile(profile)}>
                  <div className="server-row-main">
                    <span className="server-avatar"><Server size={13} /><span className={clsx("status-dot", props.active?.profileId === profile.id ? stateClass(props.active.state) : "bg-muted")} /></span>
                    <div className="server-row-text">
                      <div className="server-title-line">
                        <div className="server-title">{profile.name || profile.host}</div>
                        {automation && <span className={clsx("automation-badge", `automation-${automation.source}`, automation.phase === "started" && "automation-running", automation.phase === "failed" && "automation-failed")}>{automation.source.toUpperCase()}</span>}
                      </div>
                      <div className="server-subtitle">{profile.username}@{profile.host}:{profile.port}{profile.proxyJumpId && <ArrowUpRight size={10} className="inline ml-1 opacity-50" />}</div>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="mini-btn" onClick={() => props.onConnectProfile(profile)} title={t(lang, "connect")}><Play size={13} /></button>
                    <button className="mini-btn" onClick={() => props.onEditProfile(profile)} title={t(lang, "editServer")}><Edit3 size={13} /></button>
                    <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); props.onDeleteProfile(profile.id); }} title={t(lang, "delete")}><Trash2 size={12} /></button>
                  </div>
                </div>
                );
              })}
              {!filteredProfiles.length && (
                props.profiles.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-icon"><Server size={22} /></div>
                    <div className="empty-state-title">{t(lang, "emptyServersTitle")}</div>
                    <div className="empty-state-text">{t(lang, "emptyServersHint")}</div>
                    <button className="btn-primary empty-state-action" onClick={props.onNewProfile}><Plus size={13} /> {t(lang, "newConnection")}</button>
                  </div>
                ) : (
                  <div className="empty">{t(lang, "noServers")}</div>
                )
              )}
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

        {activePrimary !== "connections" && <div className="tool-body-full" key={`${activePrimary}-${props.drawer}-${fileMode}`}><Suspense fallback={<DrawerFallback />}>
          {props.drawer === "sftp" && (
            <div className="file-workspace">
              <div className="file-workspace-bar">
                <div className="file-workspace-title">
                  <Folder size={14} />
                  <span>{titleText.files}</span>
                </div>
                <div className="file-workspace-tabs" title={t(lang, "switchFilesView")}>
                  <button className={clsx(fileMode === "remote" && "active")} onClick={() => setFileMode("remote")}>
                    <FolderOpen size={11} /><span>{t(lang, "remote")}</span>
                  </button>
                  <button className={clsx(fileMode === "text" && "active")} onClick={() => setFileMode("text")}>
                    <FileText size={11} /><span>{t(lang, "textFiles")}</span>
                  </button>
                </div>
              </div>

              <div className="file-workspace-body">
                {fileMode === "remote" && (
                  !canBrowseRemote ? (
                    <div className="file-workspace-empty">
                      <FolderOpen size={22} />
                      <span>{t(lang, "connectFirstSftp")}</span>
                    </div>
                  ) : (
                    <SftpPanel active={props.active} path={props.remotePath} files={props.remoteFiles} busy={props.sftpBusy} locale={lang} onRefresh={props.onRefreshSftp} onNotify={props.onNotify} setCtxMenu={props.setCtxMenu} onOpenMarkdownFile={props.onOpenRemoteMarkdownFile} onOpenTerminalInDir={props.onOpenTerminalInDir} />
                  )
                )}

                {fileMode === "text" && (
                  <div className="text-file-workspace">
                    <div className="text-file-toolbar">
                      <div>
                        <strong>{t(lang, "textFiles")}</strong>
                        <small>{lang === "zh-CN" ? "本地与远程文本工作区" : "Local and remote text workspace"}</small>
                      </div>
                      <button className="text-file-open-btn" onClick={props.onPickTextFile}><Plus size={11} /> {t(lang, "open")}</button>
                    </div>

                    {!!props.markdownSiblings?.length && (
                      <section className="text-file-section">
                        <div className="text-file-section-title">{lang === "zh-CN" ? "当前目录" : "Current folder"}<span>{props.markdownSiblings.length}</span></div>
                        <div className="text-file-list">
                          {props.markdownSiblings.map((file) => {
                            const isActive = props.active?.type === "markdown" && (props.active.filePath === file || props.active.remotePath === file);
                            return (
                              <button key={file} className={clsx("text-file-row", isActive && "active")} onClick={() => props.onOpenMarkdownFile?.(file)} title={file}>
                                <FileText size={13} />
                                <span>{file.split(/[\\/]/).pop()}</span>
                                {isActive && <span className="text-file-current">{lang === "zh-CN" ? "当前" : "Open"}</span>}
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    )}

                    <section className="text-file-section text-file-section-grow">
                      <div className="text-file-section-title">{t(lang, "recentTextFiles")}<span>{(props.recentMarkdown || []).length}</span></div>
                      <div className="text-file-list text-file-list-scroll">
                        {(props.recentMarkdown || []).map((item) => (
                          <div key={item.id} className="text-file-row text-file-recent-row">
                            <button className="text-file-main" onClick={() => props.onOpenRecentMarkdown?.(item)} title={item.path}>
                              <FileText size={13} className={item.source === "remote" ? "text-accent" : "text-muted"} />
                              <span><strong>{item.title}</strong><small>{item.source === "remote" ? (item.host || t(lang, "remote")) : t(lang, "local")} · {item.path}</small></span>
                            </button>
                            <button className="mini-btn danger text-file-remove" onClick={(event) => { event.stopPropagation(); props.onRemoveRecentMarkdown?.(item.id); }} title={t(lang, "remove")}><X size={11} /></button>
                          </div>
                        ))}
                        {!(props.recentMarkdown || []).length && <div className="text-file-empty">{t(lang, "noRecentTextFiles")}</div>}
                      </div>
                    </section>
                  </div>
                )}
              </div>
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
              <div className="tool-panel-body" key={props.drawer}>
                {props.drawer === "commands" && <CommandPanel commands={props.commands} active={props.active} locale={lang} onRun={props.onRunCommand} onRunAll={props.onRunCommandAll} onEdit={props.onEditCommand} onDelete={props.onDeleteCommand} onNew={props.onNewCommand} />}
                {props.drawer === "tunnels" && <TunnelPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "logs" && <LogsPanel locale={lang} onOpenLog={props.onOpenLog} />}
                {props.drawer === "containers" && <ContainerPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "recordings" && <RecordingsPanel active={props.active} locale={lang} onNotify={props.onNotify} settings={props.settings} />}
              </div>
            </>
          )}
          {props.drawer === "ai" && <AiPanel locale={lang} onNotify={props.onNotify} getTerminalLines={props.getTerminalLines} activeTabId={props.activeTabId} />}
          {props.drawer === "settings" && props.settings && <SettingsPanel settings={props.settings} language={lang} onSave={props.onSaveSettings} onOpenData={props.onOpenData} dataDir={props.appInfo.dataDir || ""} onNotify={props.onNotify} />}
        </Suspense></div>}
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
