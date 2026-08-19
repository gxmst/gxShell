import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, Bot, Edit3, FileText, Folder, FolderOpen, MoreHorizontal, PanelLeftClose, Play, Plus, Search, Server, Settings, Star, Trash2, X, Zap } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { isWindowsPlatform } from "../../utils/clipboard";
import { TraceRoute, PingHost, UpdateSettings } from "../../../wailsjs/go/app/App";
import type { AutomationActivityRecord, AutomationIndicator, Drawer, RecentMarkdownItem, Tab, Toast } from "../../types";
import type { AppContextMenu } from "../../hooks/useTerminal";
import { AppIcon, drawerIcon } from "../../constants";
import { stateClass } from "../../utils/format";
import { t, navLabel } from "../../i18n";
import { MonitorPanel } from "../MonitorPanel/MonitorPanel";
import { NetworkPathCard } from "../NetworkPathCard/NetworkPathCard";
import { MemoryCard } from "../MemoryCard/MemoryCard";
import { MonitorDetailCard, type MonitorDetailKind } from "../MonitorDetailCard/MonitorDetailCard";
import { CliTrustIndicator } from "../CliTrustIndicator/CliTrustIndicator";

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
const ServicePanel = lazy(() => import("../ServicePanel/ServicePanel").then((mod) => ({ default: mod.ServicePanel })));
const FirewallPanel = lazy(() => import("../FirewallPanel/FirewallPanel").then((mod) => ({ default: mod.FirewallPanel })));
const CronPanel = lazy(() => import("../CronPanel/CronPanel").then((mod) => ({ default: mod.CronPanel })));
const WebsitePanel = lazy(() => import("../WebsitePanel/WebsitePanel").then((mod) => ({ default: mod.WebsitePanel })));
const RecordingsPanel = lazy(() => import("../RecordingsPanel/RecordingsPanel").then((mod) => ({ default: mod.RecordingsPanel })));

function DrawerFallback() {
  return <div className="drawer-loading"><span className="drawer-loading-dot" /></div>;
}

const toolDrawers: Drawer[] = ["commands", "tunnels", "containers", "services", "firewall", "cron", "websites", "logs", "recordings"];

function primaryForDrawer(drawer: Drawer): PrimaryNav | "ai" | "settings" {
  if (drawer === "monitor") return "connections";
  if (drawer === "sftp") return "files";
  if (drawer === "ai") return "ai";
  if (drawer === "settings") return "settings";
  return "tools";
}

function sameDocumentPath(left: string | undefined, right: string, remote: boolean) {
  if (!left) return false;
  if (remote) return left === right;
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/");
    return isWindowsPlatform() ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export function Sidebar(props: {
  collapsed: boolean;
  setCollapsed: (value: boolean | ((value: boolean) => boolean)) => void;
  setCtxMenu: (menu: AppContextMenu | null) => void;
  drawer: Drawer;
  setDrawer: (drawer: Drawer) => void;
  profiles: types.Profile[];
  commands: types.CommandTemplate[];
  settings: types.AppSettings | null;
  appInfo: Record<string, string>;
  active?: Tab;
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
  onQuickConnect: () => void;
  onEditProfile: (profile: types.Profile) => void;
  onConnectProfile: (profile: types.Profile) => void;
  onToggleFavorite: (profile: types.Profile) => void;
  revokingCliTrustID?: string;
  onRevokeCliTrust?: (profileID: string) => void;
  onDeleteProfile: (id: string) => void;
  onImportProfiles: () => void;
  onImportOpenSSH: () => void;
  onExportProfiles: () => void;
  onOpenSearch: () => void;
  onStartMonitor: () => void;
  onRefreshSftp: (path?: string) => void;
  onOpenTerminalInDir?: (sessionId: string, path: string) => void;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
  onRunCommand: (command: types.CommandTemplate) => void;
  onRunCommandInSession: (command: types.CommandTemplate, sessionId: string) => void;
  onRunCommandAll: (command: types.CommandTemplate) => void;
  onEditCommand: (command: types.CommandTemplate) => void;
  onDeleteCommand: (id: string) => void;
  onNewCommand: () => void;
  onSaveSettings: (settings: types.AppSettings) => void | Promise<void>;
  onSettingsDirtyChange?: (dirty: boolean, save: () => Promise<boolean>) => void;
  onOpenData: () => void;
  onOpenLog: (name: string) => void;
  getTerminalLines: (id: string, lineCount: number) => string;
  activeTabId: string;
  tabs: Tab[];
  profileStates?: Record<string, { state: string; count: number; error?: string }>;
  activityHistory?: AutomationActivityRecord[];
  automationByProfile?: Record<string, AutomationIndicator>;
}) {
  const lang = props.settings?.language || "en";
  // GetAppInfo reports backend/version.Version, so there is no second literal to
  // keep in sync here. Before appInfo resolves the label simply has no version.
  const appVersion = props.appInfo.version || "";
  const [splitPct, setSplitPct] = useState(45);
  const dragRef = useRef({ active: false, startY: 0, startPct: 0 });
  const splitRef = useRef(splitPct);
  splitRef.current = splitPct;

  const [floats, setFloats] = useState<Record<FloatKey, boolean>>({ path: false, memory: false, cpu: false, disk: false, network: false });

  const [activeGroup, setActiveGroup] = useState<string>("__all__");
  const [fileMode, setFileMode] = useState<FileMode>("remote");
  const activeDocumentRowRef = useRef<HTMLButtonElement>(null);
  const [aiMounted, setAiMounted] = useState(props.drawer === "ai");

  useEffect(() => {
    if (props.drawer === "ai") setAiMounted(true);
  }, [props.drawer]);

  useEffect(() => {
    if (props.drawer === "sftp") setFileMode(props.active?.type === "markdown" ? "text" : "remote");
  }, [props.drawer, props.active?.id, props.active?.type]);

  useLayoutEffect(() => {
    if (props.drawer !== "sftp" || fileMode !== "text") return;
    const frame = requestAnimationFrame(() => {
      activeDocumentRowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [fileMode, props.active?.id, props.active?.filePath, props.active?.remotePath, props.drawer, props.markdownSiblings]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    props.profiles.forEach((p) => {
      set.add(p.group || "");
    });
    return Array.from(set);
  }, [props.profiles]);
  const hasGroupTabs = props.profiles.length > 0;

  const lastConnectedValue = useCallback((profile: types.Profile) => {
    const value = Date.parse(String(profile.lastConnectedAt || ""));
    return Number.isFinite(value) && value > Date.UTC(1970, 0, 1) ? value : 0;
  }, []);

  const filteredProfiles = useMemo(() => {
    if (activeGroup === "__favorites__") return props.profiles.filter((profile) => profile.favorite);
    if (activeGroup === "__recent__") {
      return props.profiles
        .filter((profile) => lastConnectedValue(profile) > 0)
        .sort((left, right) => lastConnectedValue(right) - lastConnectedValue(left));
    }
    if (activeGroup === "__all__") {
      return [...props.profiles].sort((left, right) => Number(right.favorite) - Number(left.favorite));
    }
    return props.profiles.filter((p) => (p.group || "") === activeGroup);
  }, [props.profiles, activeGroup, lastConnectedValue]);

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
  const openProfileTools = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    props.setCtxMenu({
      x: Math.min(rect.left, window.innerWidth - 210),
      y: rect.bottom + 5,
      items: [
        { label: t(lang, "importProfiles"), action: props.onImportProfiles },
        { label: t(lang, "importOpenSSH"), action: props.onImportOpenSSH },
        { label: t(lang, "exportProfiles"), action: props.onExportProfiles },
      ],
    });
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
            <div className="brand-meta">{appVersion ? `v${appVersion} / ` : ""}Ctrl+K</div>
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
                <button className="drawer-hero-btn" onClick={props.onQuickConnect} title={t(lang, "quickConnect")}><Zap size={12} /></button>
                <button className="drawer-hero-btn" onClick={props.onOpenSearch} title={t(lang, "search")}><Search size={12} /></button>
                <button className="drawer-hero-btn" onClick={openProfileTools} title={t(lang, "profileTools")}><MoreHorizontal size={12} /></button>
                <button className="drawer-hero-btn drawer-hero-btn-primary" onClick={props.onNewProfile} title={t(lang, "new")}><Plus size={12} /></button>
              </div>
            </div>
            {hasGroupTabs && (
              <div className="group-tabs">
                <button className={clsx("group-tab", activeGroup === "__all__" && "group-tab-active")} onClick={() => setActiveGroup("__all__")}>{t(lang, "allGroups")}</button>
                <button className={clsx("group-tab", activeGroup === "__favorites__" && "group-tab-active")} onClick={() => setActiveGroup("__favorites__")}><Star size={10} /> {t(lang, "favorites")}</button>
                <button className={clsx("group-tab", activeGroup === "__recent__" && "group-tab-active")} onClick={() => setActiveGroup("__recent__")}>{t(lang, "recentConnections")}</button>
                {groups.map((g) => (
                  <button key={g} className={clsx("group-tab", activeGroup === g && "group-tab-active")} onClick={() => setActiveGroup(g)}>{g || t(lang, "defaultGroup")}</button>
                ))}
              </div>
            )}
            <div className="server-list">
              {filteredProfiles.map((profile) => {
                const automation = props.automationByProfile?.[profile.id];
                const session = props.profileStates?.[profile.id];
                const statusLabel = session?.state === "connected"
                  ? (lang === "zh-CN" ? "已连接" : "Connected")
                  : session?.state === "connecting"
                    ? t(lang, "connecting")
                    : session?.state === "error"
                      ? (lang === "zh-CN" ? "连接错误" : "Connection error")
                      : (lang === "zh-CN" ? "未连接" : "Not connected");
                return (
                <div key={profile.id} className={clsx("server-row group", automation && "server-row-automation")}>
                  <button type="button" className="server-row-main" aria-label={`${t(lang, "connect")} ${profile.name || profile.host}, ${statusLabel}`} onClick={() => props.onConnectProfile(profile)}>
                    <span className="server-avatar" title={session ? `${statusLabel} · ${session.count} ${lang === "zh-CN" ? "个会话" : (session.count === 1 ? "session" : "sessions")}${session.error ? ` · ${session.error}` : ""}` : statusLabel}><Server size={13} /><span className={clsx("status-dot", stateClass(session?.state || "disconnected"))} /></span>
                    <div className="server-row-text">
                      <div className="server-title-line">
                        <div className="server-title-group">
                          <div className="server-title">{profile.name || profile.host}</div>
                        </div>
                        {!!session?.count && <span className="server-session-count" title={statusLabel}>{session.count}</span>}
                        {automation && <span className={clsx("automation-badge", `automation-${automation.source}`, automation.phase === "started" && "automation-running", automation.phase === "failed" && "automation-failed")}>{automation.source.toUpperCase()}</span>}
                      </div>
                      <div className="server-subtitle">{profile.username}@{profile.host}:{profile.port}{profile.proxyJumpId && <ArrowUpRight size={10} className="inline ml-1 opacity-50" />}</div>
                    </div>
                  </button>
                  {props.onRevokeCliTrust && (
                    <CliTrustIndicator
                      profile={profile}
                      locale={lang}
                      revoking={props.revokingCliTrustID === profile.id}
                      onRevoke={props.onRevokeCliTrust}
                    />
                  )}
                  <div className="row-actions">
                    <button className={clsx("mini-btn", profile.favorite && "favorite-active")} aria-label={profile.favorite ? t(lang, "removeFavorite") : t(lang, "addFavorite")} onClick={(event) => { event.stopPropagation(); props.onToggleFavorite(profile); }} title={profile.favorite ? t(lang, "removeFavorite") : t(lang, "addFavorite")}><Star size={12} fill={profile.favorite ? "currentColor" : "none"} /></button>
                    <button className="mini-btn" aria-label={`${t(lang, "connect")} ${profile.name || profile.host}`} onClick={() => props.onConnectProfile(profile)} title={t(lang, "connect")}><Play size={13} /></button>
                    <button className="mini-btn" aria-label={`${t(lang, "editServer")} ${profile.name || profile.host}`} onClick={() => props.onEditProfile(profile)} title={t(lang, "editServer")}><Edit3 size={13} /></button>
                    <button className="mini-btn danger" aria-label={`${t(lang, "delete")} ${profile.name || profile.host}`} onClick={(e) => { e.stopPropagation(); props.onDeleteProfile(profile.id); }} title={t(lang, "delete")}><Trash2 size={12} /></button>
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
                  <div className="empty">{activeGroup === "__favorites__" ? t(lang, "noFavorites") : activeGroup === "__recent__" ? t(lang, "noRecentConnections") : t(lang, "noServers")}</div>
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

        {activePrimary !== "connections" && props.drawer !== "ai" && <div className={clsx("tool-body-full", props.drawer === "settings" && "settings-host")} key={`${activePrimary}-${props.drawer}-${fileMode}`}><Suspense fallback={<DrawerFallback />}>
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
                        <small>{lang === "zh-CN" ? "本地与远程文档工作区" : "Local and remote document workspace"}</small>
                      </div>
                      <button className="text-file-open-btn" onClick={props.onPickTextFile}><Plus size={11} /> {t(lang, "open")}</button>
                    </div>

                    {!!props.markdownSiblings?.length && (
                      <section className="text-file-section text-file-section-current">
                        <div className="text-file-section-title">{lang === "zh-CN" ? "当前目录" : "Current folder"}<span>{props.markdownSiblings.length}</span></div>
                        <div className="text-file-list text-file-list-scroll">
                          {props.markdownSiblings.map((file) => {
                            const isRemote = props.active?.markdownSource === "remote";
                            const activePath = isRemote ? props.active?.remotePath : props.active?.filePath;
                            const isActive = props.active?.type === "markdown" && sameDocumentPath(activePath, file, isRemote);
                            return (
                              <button
                                key={file}
                                ref={isActive ? activeDocumentRowRef : undefined}
                                className={clsx("text-file-row", isActive && "active")}
                                aria-current={isActive ? "page" : undefined}
                                onClick={() => props.onOpenMarkdownFile?.(file)}
                                title={file}
                              >
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
                {props.drawer === "commands" && <CommandPanel commands={props.commands} tabs={props.tabs} active={props.active} locale={lang} onRun={props.onRunCommand} onRunInSession={props.onRunCommandInSession} onRunAll={props.onRunCommandAll} onEdit={props.onEditCommand} onDelete={props.onDeleteCommand} onNew={props.onNewCommand} />}
                {props.drawer === "tunnels" && <TunnelPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "logs" && <LogsPanel locale={lang} onOpenLog={props.onOpenLog} activities={props.activityHistory || []} />}
                {props.drawer === "containers" && <ContainerPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "services" && <ServicePanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "firewall" && <FirewallPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "cron" && <CronPanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "websites" && <WebsitePanel active={props.active} locale={lang} onNotify={props.onNotify} />}
                {props.drawer === "recordings" && <RecordingsPanel active={props.active} locale={lang} onNotify={props.onNotify} settings={props.settings} />}
              </div>
            </>
          )}
          {props.drawer === "settings" && props.settings && <SettingsPanel settings={props.settings} language={lang} onSave={props.onSaveSettings} onOpenData={props.onOpenData} dataDir={props.appInfo.dataDir || ""} onNotify={props.onNotify} onDirtyChange={props.onSettingsDirtyChange} />}
        </Suspense></div>}
        {aiMounted && (
          <div className="tool-body-full ai-persistent-host" style={{ display: props.drawer === "ai" ? undefined : "none" }}>
            <Suspense fallback={<DrawerFallback />}>
              <AiPanel locale={lang} onNotify={props.onNotify} getTerminalLines={props.getTerminalLines} activeTabId={props.activeTabId} tabs={props.tabs} />
            </Suspense>
          </div>
        )}
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
          sessionId={props.active?.id}
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
          sessionId={props.active?.id}
          initialLeft={floatLeft()}
          initialTop={kind === "cpu" ? 60 : kind === "disk" ? 90 : 120}
          locale={lang}
          onClose={() => closeFloat(kind)}
        />
      ) : null)}
    </aside>
  );
}
