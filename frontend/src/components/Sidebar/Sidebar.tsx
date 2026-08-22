import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, Bot, ChevronRight, Edit3, FileText, Folder, FolderOpen, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Play, Plus, Search, Server, Settings, Star, Trash2, X, Zap } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { isWindowsPlatform } from "../../utils/clipboard";
import { TraceRoute, PingHost, UpdateSettings } from "../../../wailsjs/go/app/App";
import type { AutomationActivityRecord, AutomationIndicator, Drawer, RecentMarkdownItem, Tab, Toast } from "../../types";
import type { AppContextMenu } from "../../hooks/useTerminal";
import { drawerIcon } from "../../constants";
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

const FOLDED_GROUPS_KEY = "gx:foldedServerGroups";
const RECENT_SECTION_LIMIT = 8;

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
  /** Starts a horizontal drag of the panel width. Owned by App, which holds the width. */
  onResizeStart?: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** Restores the default panel width, bound to a double-click on the edge. */
  onResizeReset?: () => void;
  /** Keyboard resize: applied as a width delta in pixels (negative narrows). */
  onResizeAdjust?: (delta: number) => void;
  /** Current panel width and its clamp bounds, for the separator's aria-value*. */
  panelWidth?: number;
  panelWidthMin?: number;
  panelWidthMax?: number;
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
  onOpenTerminalInDir?: (sessionId: string, path: string) => boolean | void | Promise<boolean | void>;
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
  const [splitPct, setSplitPct] = useState(45);
  const dragRef = useRef({ active: false, startY: 0, startPct: 0 });
  const splitRef = useRef(splitPct);
  splitRef.current = splitPct;

  const [floats, setFloats] = useState<Record<FloatKey, boolean>>({ path: false, memory: false, cpu: false, disk: false, network: false });

  // Folded server sections, persisted so the list looks the same next launch.
  // Recent is folded by default: it is a shortcut whose rows also appear under
  // their own group, so opening it duplicates them.
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(FOLDED_GROUPS_KEY) || "null");
      if (Array.isArray(parsed)) return new Set(parsed.filter((item): item is string => typeof item === "string"));
    } catch {
      /* unreadable storage falls back to the default fold */
    }
    return new Set(["__recent__"]);
  });
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

  const lastConnectedValue = useCallback((profile: types.Profile) => {
    const value = Date.parse(String(profile.lastConnectedAt || ""));
    return Number.isFinite(value) && value > Date.UTC(1970, 0, 1) ? value : 0;
  }, []);

  // Sections of the server list. Favorites and recent are shortcuts at the top;
  // every profile also appears under its own group, so the list is never a
  // filtered view the user has to reset to see everything.
  const serverSections = useMemo(() => {
    const sections: Array<{ key: string; label: string; profiles: types.Profile[] }> = [];
    const favorites = props.profiles.filter((profile) => profile.favorite);
    if (favorites.length) sections.push({ key: "__favorites__", label: t(lang, "favorites"), profiles: favorites });
    const recent = props.profiles
      .filter((profile) => lastConnectedValue(profile) > 0)
      .sort((left, right) => lastConnectedValue(right) - lastConnectedValue(left))
      .slice(0, RECENT_SECTION_LIMIT);
    if (recent.length) sections.push({ key: "__recent__", label: t(lang, "recentConnections"), profiles: recent });

    const byGroup = new Map<string, types.Profile[]>();
    props.profiles.forEach((profile) => {
      const key = profile.group || "";
      const existing = byGroup.get(key);
      if (existing) existing.push(profile);
      else byGroup.set(key, [profile]);
    });
    // Named groups alphabetically; the unnamed default group sorts last.
    Array.from(byGroup.keys())
      .sort((left, right) => (left === "" ? 1 : right === "" ? -1 : left.localeCompare(right)))
      .forEach((key) => sections.push({
        key: `group:${key}`,
        label: key || t(lang, "defaultGroup"),
        profiles: (byGroup.get(key) || []).slice().sort((left, right) => (
          Number(right.favorite) - Number(left.favorite)
          || (left.name || left.host).localeCompare(right.name || right.host)
        )),
      }));
    return sections;
  }, [lang, lastConnectedValue, props.profiles]);

  const toggleGroup = useCallback((key: string) => {
    setFoldedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(FOLDED_GROUPS_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* storage can be unavailable; the fold still applies this session */
      }
      return next;
    });
  }, []);

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
  // Rail behaviour follows the established activity-bar idiom: clicking the
  // section you are already in folds the panel away, clicking any other section
  // switches to it and unfolds. Without the unfold, clicking the rail while
  // collapsed would appear to do nothing.
  const activateSection = (isActive: boolean, open: () => void) => {
    if (isActive && !props.collapsed) {
      props.setCollapsed(true);
      return;
    }
    open();
    if (props.collapsed) props.setCollapsed(false);
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

  // One server row. Extracted because a profile now renders in more than one
  // section (favorites and recent are shortcuts into the same list).
  const renderServerRow = (profile: types.Profile) => {
    const automation = props.automationByProfile?.[profile.id];
    const session = props.profileStates?.[profile.id];
    const statusLabel = session?.state === "connected"
      ? (lang === "zh-CN" ? "已连接" : "Connected")
      : session?.state === "connecting" || session?.state === "reconnecting" || session?.state === "restoring"
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
  };

  return (
    <aside className="left-rail" ref={sidebarEl}>
      {/* The border between the panel and the terminal doubles as the resize
          grip. Hidden while collapsed: there is no panel to size then, and the
          rail's own toggle is what brings it back. */}
      {props.onResizeStart && props.onResizeAdjust && !props.collapsed && (
        <div
          className="rail-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={lang === "zh-CN" ? "调整侧栏宽度" : "Resize sidebar"}
          title={lang === "zh-CN" ? "拖动调整宽度，双击复位" : "Drag to resize, double-click to reset"}
          tabIndex={0}
          aria-valuenow={props.panelWidth}
          aria-valuemin={props.panelWidthMin}
          aria-valuemax={props.panelWidthMax}
          onPointerDown={props.onResizeStart}
          onDoubleClick={props.onResizeReset}
          onKeyDown={(event) => {
            if (!props.onResizeAdjust) return;
            const RESIZE_STEP = 16;
            // Home/End target the clamp bounds, so they need the current value
            // to express the jump as the delta API the App-side handler takes.
            const target = event.key === "Home" ? props.panelWidthMin : event.key === "End" ? props.panelWidthMax : undefined;
            const delta = target !== undefined && props.panelWidth !== undefined
              ? target - props.panelWidth
              : event.key === "ArrowLeft" ? -RESIZE_STEP
              : event.key === "ArrowRight" ? RESIZE_STEP
              : 0;
            if (delta === 0) return;
            event.preventDefault();
            props.onResizeAdjust(delta);
          }}
        />
      )}
      <nav className="activity-rail" aria-label={lang === "zh-CN" ? "主导航" : "Primary navigation"}>
        {(["connections", "files", "tools"] as PrimaryNav[]).map((item) => (
          <button
            key={item}
            type="button"
            className={clsx("rail-btn", activePrimary === item && "rail-btn-active")}
            aria-label={titleText[item]}
            aria-current={activePrimary === item ? "page" : undefined}
            title={titleText[item]}
            onClick={() => activateSection(activePrimary === item, () => openPrimary(item))}
          >
            {item === "connections" ? <Server size={17} /> : item === "files" ? <Folder size={17} /> : drawerIcon("commands", 17)}
          </button>
        ))}
        <span className="rail-spacer" />
        <button
          type="button"
          className={clsx("rail-btn", props.drawer === "ai" && "rail-btn-active")}
          aria-label={navLabel("ai", lang)}
          aria-current={props.drawer === "ai" ? "page" : undefined}
          title={navLabel("ai", lang)}
          onClick={() => activateSection(props.drawer === "ai", () => props.setDrawer("ai"))}
        >
          <Bot size={17} />
          {hasAutomationActivity && <span className="automation-nav-dot" />}
        </button>
        <button
          type="button"
          className={clsx("rail-btn", props.drawer === "settings" && "rail-btn-active")}
          aria-label={navLabel("settings", lang)}
          aria-current={props.drawer === "settings" ? "page" : undefined}
          title={navLabel("settings", lang)}
          onClick={() => activateSection(props.drawer === "settings", () => props.setDrawer("settings"))}
        >
          <Settings size={17} />
        </button>
        <button
          type="button"
          className="rail-btn"
          aria-label={props.collapsed ? t(lang, "showSidebar") : t(lang, "collapse")}
          aria-expanded={!props.collapsed}
          title={props.collapsed ? t(lang, "showSidebar") : t(lang, "collapse")}
          onClick={() => props.setCollapsed((value) => !value)}
        >
          {props.collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </nav>
      <section
        className={clsx("side-content", !isMonitor && "side-content-tool")}
        data-section={sectionKey}
        style={isMonitor ? ({ ["--side-split" as string]: `${splitPct}%` } as React.CSSProperties) : undefined}
      >
        {activePrimary === "connections" && (
          <>
            <div className="panel-head">
              <span className="panel-head-title">{t(lang, "servers")}</span>
              <span className="panel-head-count">{props.profiles.length}</span>
              <span className="panel-head-spacer" />
              <button type="button" className="icon-btn" onClick={props.onQuickConnect} aria-label={t(lang, "quickConnect")} title={t(lang, "quickConnect")}><Zap size={14} /></button>
              <button type="button" className="icon-btn" onClick={props.onOpenSearch} aria-label={t(lang, "search")} title={t(lang, "search")}><Search size={14} /></button>
              <button type="button" className="icon-btn" onClick={openProfileTools} aria-label={t(lang, "profileTools")} title={t(lang, "profileTools")}><MoreHorizontal size={14} /></button>
              <button type="button" className="btn-primary panel-head-primary" onClick={props.onNewProfile} title={t(lang, "newConnection")}><Plus size={13} /> {t(lang, "new")}</button>
            </div>
            <div className="server-list">
              {props.profiles.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon"><Server size={22} /></div>
                  <div className="empty-state-title">{t(lang, "emptyServersTitle")}</div>
                  <div className="empty-state-text">{t(lang, "emptyServersHint")}</div>
                  <button className="btn-primary empty-state-action" onClick={props.onNewProfile}><Plus size={13} /> {t(lang, "newConnection")}</button>
                </div>
              ) : serverSections.map((section) => {
                const folded = foldedGroups.has(section.key);
                return (
                  <div key={section.key} className="srv-group">
                    <button
                      type="button"
                      className="srv-group-head"
                      aria-expanded={!folded}
                      onClick={() => toggleGroup(section.key)}
                      title={section.label}
                    >
                      <ChevronRight size={11} className={clsx("srv-group-chev", !folded && "srv-group-chev-open")} aria-hidden="true" />
                      <span className="srv-group-title">{section.label}</span>
                      <span className="srv-group-count">{section.profiles.length}</span>
                    </button>
                    {!folded && section.profiles.map((profile) => renderServerRow(profile))}
                  </div>
                );
              })}
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
