import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  Activity,
  Command,
  Copy,
  Download,
  Edit3,
  File,
  Folder,
  FolderPlus,
  Gauge,
  HardDrive,
  MemoryStick,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  TerminalSquare,
  Trash2,
  Upload,
  Wifi,
  X,
  Zap
} from "lucide-react";
import clsx from "clsx";
import { EventsOn } from "../wailsjs/runtime/runtime";
import {
  Connect,
  ConnectWithSecrets,
  CreateCommand,
  CreateProfile,
  CreateRemoteDir,
  DeleteCommand,
  DeleteProfile,
  DeleteRemoteFile,
  Disconnect,
  DownloadFile,
  DuplicateProfile,
  GetAppInfo,
  GetSettings,
  ListCommands,
  ListProfiles,
  ListRemoteDir,
  OpenDataDir,
  Reconnect,
  RenameRemoteFile,
  ResizeTerminal,
  SelectDownloadPath,
  SelectPrivateKey,
  SelectUploadFile,
  SendCommandToTerminal,
  StartMonitor,
  UpdateCommand,
  UpdateProfile,
  UpdateSettings,
  UploadFile,
  WriteToTerminal
} from "../wailsjs/go/main/App";
import { types } from "../wailsjs/go/models";
import "./style.css";

type Tab = {
  id: string;
  profileId: string;
  title: string;
  state: string;
  error?: string;
};

type Toast = {
  id: number;
  tone: "info" | "error" | "success";
  text: string;
};

type Drawer = "monitor" | "sftp" | "commands" | "settings";

const appThemes = ["Dark", "Deep Blue", "Light"];

const emptyProfile = (): types.Profile =>
  new types.Profile({
    id: "",
    name: "",
    group: "Default",
    host: "",
    port: 22,
    username: "root",
    authType: "password",
    password: "",
    privateKeyPath: "",
    privateKeyPassphrase: "",
    description: "",
    tags: [],
    favorite: false
  });

const terminalThemes: Record<string, any> = {
  "gx Dark": {
    background: "#05080d",
    foreground: "#d8e2f0",
    cursor: "#66d9ef",
    selectionBackground: "#284766",
    black: "#0b0f14",
    red: "#ff6b6b",
    green: "#51d88a",
    yellow: "#f6c760",
    blue: "#64d2ff",
    magenta: "#c792ea",
    cyan: "#5de4c7",
    white: "#d8e2f0"
  },
  "Deep Blue": {
    background: "#061226",
    foreground: "#dce9ff",
    cursor: "#8bd3ff",
    selectionBackground: "#1d4f7a",
    red: "#ff7b87",
    green: "#76e4a8",
    yellow: "#ffd166",
    blue: "#7bb7ff",
    magenta: "#b99cff",
    cyan: "#6ce5e8"
  },
  Light: {
    background: "#fbfcff",
    foreground: "#1e293b",
    cursor: "#2563eb",
    selectionBackground: "#bfdbfe",
    red: "#dc2626",
    green: "#15803d",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#7c3aed",
    cyan: "#0891b2"
  },
  Nord: { background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0" },
  Dracula: { background: "#282a36", foreground: "#f8f8f2", cursor: "#bd93f9" },
  "Tokyo Night": { background: "#1a1b26", foreground: "#c0caf5", cursor: "#7aa2f7" },
  Monokai: { background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0" },
  "Solarized Dark": { background: "#002b36", foreground: "#839496", cursor: "#93a1a1" }
};

function App() {
  const [profiles, setProfiles] = useState<types.Profile[]>([]);
  const [commands, setCommands] = useState<types.CommandTemplate[]>([]);
  const [settings, setSettings] = useState<types.AppSettings | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState("");
  const [drawer, setDrawer] = useState<Drawer>("monitor");
  const [profileModal, setProfileModal] = useState<types.Profile | null>(null);
  const [commandModal, setCommandModal] = useState<types.CommandTemplate | null>(null);
  const [metrics, setMetrics] = useState<Record<string, types.Metrics>>({});
  const [remotePath, setRemotePath] = useState(".");
  const [remoteFiles, setRemoteFiles] = useState<types.RemoteFile[]>([]);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [appInfo, setAppInfo] = useState<Record<string, string>>({});
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearch, setTerminalSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const terminals = useRef<Record<string, Terminal>>({});
  const fits = useRef<Record<string, FitAddon>>({});
  const searches = useRef<Record<string, SearchAddon>>({});
  const terminalHosts = useRef<Record<string, HTMLDivElement | null>>({});
  const bufferedOutput = useRef<Record<string, string[]>>({});
  const activeTabRef = useRef("");

  const active = tabs.find((tab) => tab.id === activeTab);
  const activeMetrics = active ? metrics[active.id] : undefined;
  const themeName = normalizeAppTheme(settings?.themeName);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now();
    setToasts((items) => [...items, { id, text, tone }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3600);
  }, []);

  const reload = useCallback(async () => {
    const [profileList, commandList, currentSettings, info] = await Promise.all([
      ListProfiles(),
      ListCommands(),
      GetSettings(),
      GetAppInfo()
    ]);
    if (!appThemes.includes(currentSettings.themeName)) currentSettings.themeName = "Dark";
    if (!currentSettings.terminal.themeName || currentSettings.terminal.themeName === "gx Dark") {
      currentSettings.terminal.themeName = currentSettings.themeName === "Light" ? "Light" : currentSettings.themeName;
    }
    setProfiles(profileList);
    setCommands(commandList);
    setSettings(currentSettings);
    setAppInfo(info);
  }, []);

  useEffect(() => {
    reload().catch((err) => notify(String(err), "error"));
  }, [reload, notify]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setGlobalSearchOpen(true);
        setGlobalQuery("");
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setTerminalSearchOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "w" && activeTabRef.current) {
        event.preventDefault();
        closeTab(activeTabRef.current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const offData = EventsOn("terminal:data", (payload: { sessionId: string; data: string }) => {
      const term = terminals.current[payload.sessionId];
      if (term) term.write(payload.data);
      else bufferedOutput.current[payload.sessionId] = [...(bufferedOutput.current[payload.sessionId] || []), payload.data];
    });
    const offConnected = EventsOn("terminal:connected", (info: types.SessionInfo) => {
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, state: "connected" } : tab));
      notify(`${info.name} connected`, "success");
    });
    const offDisconnected = EventsOn("terminal:disconnected", (info: types.SessionInfo) => {
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, state: "disconnected" } : tab));
    });
    const offError = EventsOn("terminal:error", (payload: { sessionId: string; error: string }) => {
      setTabs((items) => items.map((tab) => tab.id === payload.sessionId ? { ...tab, state: "error", error: payload.error } : tab));
      notify(payload.error, "error");
    });
    const offMonitor = EventsOn("monitor:update", (data: types.Metrics) => {
      setMetrics((items) => ({ ...items, [data.sessionId]: data }));
    });
    return () => {
      offData(); offConnected(); offDisconnected(); offError(); offMonitor();
    };
  }, [notify]);

  useEffect(() => {
    if (!activeTab || !settings) return;
    const host = terminalHosts.current[activeTab];
    if (!host || terminals.current[activeTab]) {
      fits.current[activeTab]?.fit();
      return;
    }
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: settings.terminal.cursorBlink,
      cursorStyle: settings.terminal.cursorStyle as any,
      fontFamily: settings.terminal.fontFamily || "JetBrains Mono, Cascadia Code, Fira Code, Maple Mono, Consolas, monospace",
      fontSize: settings.terminal.fontSize || 13.5,
      fontWeight: 400,
      lineHeight: settings.terminal.lineHeight || 1.4,
      scrollback: settings.terminal.scrollbackLines || 5000,
      theme: getTerminalTheme(settings)
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.open(host);
    const fitAndResize = () => {
      window.requestAnimationFrame(() => {
        try {
          fit.fit();
          ResizeTerminal(activeTab, term.cols, term.rows).catch(() => undefined);
        } catch {
          // xterm may briefly report zero-sized geometry while WebView is settling.
        }
      });
    };
    fitAndResize();
    window.setTimeout(fitAndResize, 80);
    window.setTimeout(fitAndResize, 260);
    term.focus();
    terminals.current[activeTab] = term;
    fits.current[activeTab] = fit;
    searches.current[activeTab] = searchAddon;
    term.onData((data) => WriteToTerminal(activeTab, data).catch((err) => notify(String(err), "error")));
    const buffered = bufferedOutput.current[activeTab] || [];
    buffered.forEach((chunk) => term.write(chunk));
    delete bufferedOutput.current[activeTab];
    const resize = () => fitAndResize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [activeTab, settings, notify]);

  useEffect(() => {
    if (!settings) return;
    Object.values(terminals.current).forEach((term) => {
      term.options.theme = getTerminalTheme(settings);
      term.options.fontFamily = settings.terminal.fontFamily;
      term.options.fontSize = settings.terminal.fontSize;
      term.options.lineHeight = settings.terminal.lineHeight;
    });
    Object.values(fits.current).forEach((fit) => fit.fit());
  }, [settings]);

  useEffect(() => {
    window.setTimeout(() => {
      Object.values(fits.current).forEach((fit) => {
        try {
          fit.fit();
        } catch {
          // Ignore transient zero-size layout during sidebar animation.
        }
      });
    }, 220);
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (drawer === "sftp" && active) refreshSftp(remotePath);
  }, [drawer, activeTab]);

  const connectProfile = async (profile: types.Profile) => {
    try {
      let password = "";
      let passphrase = "";
      if (!profile.rememberPassword) {
        if (profile.authType === "password") {
          password = window.prompt(`Password for ${profile.username}@${profile.host}`) || "";
          if (!password) return;
        }
        if (profile.authType === "privateKey") {
          passphrase = window.prompt(`Private key passphrase for ${profile.name || profile.host} (leave blank if none)`) || "";
        }
      }
      const info = profile.rememberPassword
        ? await Connect(profile.id, 120, 36)
        : await ConnectWithSecrets(profile.id, password, passphrase, 120, 36);
      setTabs((items) => [...items, { id: info.id, profileId: info.profileId, title: info.name, state: info.state }]);
      setActiveTab(info.id);
      setDrawer("monitor");
      await reload();
    } catch (err) {
      notify(String(err), "error");
    }
  };

  const closeTab = async (id: string) => {
    await Disconnect(id).catch(() => undefined);
    terminals.current[id]?.dispose();
    delete terminals.current[id];
    delete fits.current[id];
    delete searches.current[id];
    setTabs((items) => {
      const next = items.filter((tab) => tab.id !== id);
      if (activeTabRef.current === id) setActiveTab(next[0]?.id || "");
      return next;
    });
  };

  const refreshSftp = async (path = remotePath) => {
    if (!active) return;
    setSftpBusy(true);
    try {
      setRemoteFiles(await ListRemoteDir(active.id, path));
      setRemotePath(path);
    } catch (err) {
      notify(String(err), "error");
    } finally {
      setSftpBusy(false);
    }
  };

  const saveProfile = async (profile: types.Profile) => {
    try {
      if (profile.id) await UpdateProfile(profile);
      else await CreateProfile(profile);
      setProfileModal(null);
      await reload();
      notify("Server profile saved", "success");
    } catch (err) {
      notify(String(err), "error");
    }
  };

  const saveCommand = async (command: types.CommandTemplate) => {
    try {
      if (command.id) await UpdateCommand(command);
      else await CreateCommand(command);
      setCommandModal(null);
      setCommands(await ListCommands());
    } catch (err) {
      notify(String(err), "error");
    }
  };

  const runTerminalSearch = () => {
    if (!activeTab || !terminalSearch) return;
    searches.current[activeTab]?.findNext(terminalSearch);
  };

  const globalResults = useMemo(() => {
    const q = globalQuery.trim().toLowerCase();
    if (!q) return [];
    const serverResults = profiles
      .filter((profile) => [profile.name, profile.host, profile.username, profile.group].some((value) => (value || "").toLowerCase().includes(q)))
      .slice(0, 6)
      .map((profile) => ({ type: "server", title: profile.name || profile.host, subtitle: `${profile.username}@${profile.host}`, action: () => connectProfile(profile) }));
    const commandResults = commands
      .filter((cmd) => [cmd.name, cmd.command, cmd.category].some((value) => (value || "").toLowerCase().includes(q)))
      .slice(0, 6)
      .map((cmd) => ({ type: "command", title: cmd.name, subtitle: cmd.command, action: () => active && SendCommandToTerminal(active.id, cmd.command) }));
    const areaResults = (["monitor", "sftp", "commands", "settings"] as Drawer[])
      .filter((item) => item.includes(q))
      .map((item) => ({ type: "area", title: item, subtitle: "Open left panel", action: () => setDrawer(item) }));
    return [...serverResults, ...commandResults, ...areaResults];
  }, [globalQuery, profiles, commands, active]);

  return (
    <div className="app-shell" data-theme={themeName} data-collapsed={sidebarCollapsed ? "true" : "false"}>
      <main className="workspace">
        <aside className="left-rail">
          <section className="side-content">
            <div className="brand-row">
              <div className="brand-mark"><TerminalSquare size={18} /></div>
              <div className="min-w-0">
                <div className="brand-name">gxShell</div>
                <div className="brand-meta">v1.0 · Ctrl+K</div>
              </div>
              <button className="icon-btn ml-auto" onClick={() => setSidebarCollapsed((value) => !value)} title="Collapse sidebar"><MoreHorizontal size={15} /></button>
            </div>

            <div className="nav-strip">
              {(["monitor", "sftp", "commands", "settings"] as Drawer[]).map((item) => (
                <button key={item} className={clsx("nav-chip", drawer === item && "nav-chip-active")} onClick={() => setDrawer(item)} title={item}>
                  {drawerIcon(item)} <span>{navLabel(item)}</span>
                </button>
              ))}
            </div>

            <div className="section-title">
              <span>Servers</span>
              <button className="text-button" onClick={() => setProfileModal(emptyProfile())}><Plus size={13} /> New</button>
              <button className="text-button" onClick={() => setGlobalSearchOpen(true)}><Search size={13} /> Search</button>
            </div>
            <div className="server-list">
              {profiles.map((profile) => (
                <div key={profile.id} className="server-row group" onDoubleClick={() => connectProfile(profile)}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="status-dot bg-muted" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{profile.name || profile.host}</div>
                      <div className="truncate text-xs text-muted">{profile.username}@{profile.host}:{profile.port}</div>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="mini-btn" onClick={() => connectProfile(profile)} title="Connect"><Play size={13} /></button>
                    <button className="mini-btn" onClick={() => setProfileModal(new types.Profile(profile))} title="Edit"><Edit3 size={13} /></button>
                  </div>
                </div>
              ))}
              {!profiles.length && <div className="empty">No servers yet. Create one to begin.</div>}
            </div>

            <div className="current-server-block">
              <div className="section-title subtle">
                <span>{drawer === "monitor" ? "Current Server" : navLabel(drawer)}</span>
              </div>
              <div className="tool-body">
                {drawer === "monitor" && <MonitorView metrics={activeMetrics} active={active} onStart={() => active && StartMonitor(active.id)} />}
                {drawer === "sftp" && <SftpView active={active} path={remotePath} files={remoteFiles} busy={sftpBusy} onRefresh={refreshSftp} onNotify={notify} />}
                {drawer === "commands" && <CommandsView commands={commands} active={active} onRun={(cmd) => active && SendCommandToTerminal(active.id, cmd.command)} onEdit={setCommandModal} onDelete={async (id) => { await DeleteCommand(id); setCommands(await ListCommands()); }} onNew={() => setCommandModal(new types.CommandTemplate({ id: "", name: "", command: "", category: "Custom", description: "", tags: [] }))} />}
                {drawer === "settings" && settings && <SettingsView settings={settings} onSave={async (next) => { setSettings(await UpdateSettings(next)); notify("Settings saved", "success"); }} onOpenData={OpenDataDir} dataDir={appInfo.dataDir || ""} />}
              </div>
            </div>
          </section>
        </aside>

        <section className="terminal-pane">
          <div className="tabbar">
            <div className="tabs-scroll">
              {tabs.map((tab) => (
                <button key={tab.id} className={clsx("tab", activeTab === tab.id && "tab-active")} onClick={() => setActiveTab(tab.id)}>
                  <span className={clsx("status-dot", stateClass(tab.state))} />
                  <span className="max-w-[180px] truncate">{tab.title}</span>
                  <X size={14} onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }} />
                </button>
              ))}
            </div>
            <button className="tab-action" disabled={!active} onClick={() => active && Reconnect(active.id).then((info) => {
              setTabs((items) => items.map((tab) => tab.id === active.id ? { ...tab, id: info.id, state: info.state } : tab));
              setActiveTab(info.id);
            })}><RefreshCw size={14} /></button>
          </div>
          <div className="terminal-stage">
            {tabs.map((tab) => (
              <div key={tab.id} className={clsx("terminal-host", activeTab === tab.id ? "block" : "hidden")} ref={(el) => { terminalHosts.current[tab.id] = el; }} />
            ))}
            {!tabs.length && (
              <div className="terminal-empty">
                <TerminalSquare className="mx-auto mb-4 h-12 w-12 text-muted" />
                <div className="text-lg font-semibold">No active terminal</div>
                <div className="mt-1 text-sm text-muted">Double click a server or press Ctrl+K.</div>
              </div>
            )}
          </div>
        </section>
      </main>

      {globalSearchOpen && <GlobalSearchModal query={globalQuery} onQuery={setGlobalQuery} results={globalResults} onClose={() => setGlobalSearchOpen(false)} />}
      {terminalSearchOpen && <TerminalSearchModal query={terminalSearch} onQuery={setTerminalSearch} onNext={runTerminalSearch} onClose={() => setTerminalSearchOpen(false)} />}
      {profileModal && <ProfileModal profile={profileModal} onClose={() => setProfileModal(null)} onSave={saveProfile} onPickKey={SelectPrivateKey} onDelete={async (id) => { await DeleteProfile(id); setProfileModal(null); await reload(); }} onDuplicate={async (id) => { await DuplicateProfile(id); await reload(); }} />}
      {commandModal && <CommandModal command={commandModal} onClose={() => setCommandModal(null)} onSave={saveCommand} />}
      <div className="toast-stack">{toasts.map((toast) => <div key={toast.id} className={clsx("toast", `toast-${toast.tone}`)}>{toast.text}</div>)}</div>
    </div>
  );
}

function drawerIcon(item: Drawer) {
  const size = 15;
  if (item === "monitor") return <Activity size={size} />;
  if (item === "sftp") return <Folder size={size} />;
  if (item === "commands") return <Command size={size} />;
  return <Settings size={size} />;
}

function navLabel(item: Drawer) {
  if (item === "sftp") return "Files";
  if (item === "commands") return "Cmd";
  return item[0].toUpperCase() + item.slice(1);
}

function stateClass(state: string) {
  if (state === "connected") return "bg-ok";
  if (state === "connecting") return "bg-warn";
  if (state === "error") return "bg-bad";
  return "bg-muted";
}

function normalizeAppTheme(theme?: string): string {
  return appThemes.includes(theme || "") ? theme || "Dark" : "Dark";
}

function getTerminalTheme(settings: types.AppSettings) {
  const requested = settings.terminal.themeName || settings.themeName || "Dark";
  return terminalThemes[requested] || terminalThemes[normalizeAppTheme(settings.themeName)] || terminalThemes["gx Dark"];
}

function MonitorView({ metrics, active, onStart }: { metrics?: types.Metrics; active?: Tab; onStart: () => void }) {
  if (!active) return <div className="empty compact">Open a terminal to view live status.</div>;
  return (
    <div className="space-y-2">
      <div className="current-card">
        <Wifi size={15} className={clsx(active.state === "connected" ? "text-ok" : "text-muted")} />
        <span className="min-w-0 flex-1 truncate text-sm">{active.title}</span>
        <span className={clsx("status-dot", stateClass(active.state))} />
      </div>
      {!metrics && <button className="btn-secondary w-full" onClick={onStart}><Activity size={15} /> Start monitor</button>}
      {metrics && (
        <>
          <Metric icon={<Gauge size={15} />} label="CPU" value={metrics.cpuPercent} />
          <Metric icon={<MemoryStick size={15} />} label="Memory" value={metrics.memoryPercent} detail={`${metrics.memoryUsedMb || 0}/${metrics.memoryTotalMb || 0} MB`} />
          <Metric icon={<HardDrive size={15} />} label="Disk" value={metrics.diskPercent} detail={`${metrics.diskUsed || "-"} / ${metrics.diskTotal || "-"}`} />
          <div className="chip-grid">
            <MiniMetric icon={<Zap size={14} />} label="Load" value={metrics.loadAverage || "-"} />
            <MiniMetric icon={<Wifi size={14} />} label="Ping" value={`${metrics.latencyMs || 0}ms`} />
            <MiniMetric icon={<Download size={14} />} label="Down" value={formatBytes(metrics.networkRxPerSec)} />
            <MiniMetric icon={<Upload size={14} />} label="Up" value={formatBytes(metrics.networkTxPerSec)} />
          </div>
          <div className="panel dense">
            <div className="mb-1 text-xs font-medium text-muted">Top processes</div>
            {metrics.topProcesses?.slice(0, 5).map((p) => (
              <div key={`${p.pid}-${p.command}`} className="process-row">
                <span className="truncate">{p.command}</span><span>{p.memory.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ icon, label, value, detail }: { icon: JSX.Element; label: string; value: number; detail?: string }) {
  const safe = Math.max(0, Math.min(100, value || 0));
  const tone = safe >= 85 ? "bad" : safe >= 60 ? "warn" : "ok";
  return (
    <div className="metric-card">
      <div className={clsx("metric-icon", `metric-${tone}`)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex justify-between gap-2 text-xs">
          <span>{label}</span><span className="truncate text-muted">{detail || `${safe.toFixed(1)}%`}</span>
        </div>
        <div className="meter"><div className={clsx("meter-fill", `meter-${tone}`)} style={{ width: `${safe}%` }} /></div>
      </div>
    </div>
  );
}

function MiniMetric({ icon, label, value }: { icon: JSX.Element; label: string; value: string }) {
  return <div className="mini-metric"><div className="flex items-center gap-1 text-[11px] text-muted">{icon}{label}</div><div className="truncate text-xs">{value}</div></div>;
}

function SftpView(props: { active?: Tab; path: string; files: types.RemoteFile[]; busy: boolean; onRefresh: (path?: string) => void; onNotify: (text: string, tone?: Toast["tone"]) => void }) {
  const { active, path, files, busy, onRefresh, onNotify } = props;
  const [draftPath, setDraftPath] = useState(path);
  useEffect(() => setDraftPath(path), [path]);
  if (!active) return <div className="empty compact">Connect first to browse SFTP.</div>;
  const upload = async () => {
    const local = await SelectUploadFile();
    if (!local) return;
    const name = local.split(/[\\/]/).pop() || "upload.bin";
    await UploadFile(active.id, local, `${path.replace(/\/$/, "")}/${name}`);
    onRefresh(path);
  };
  const download = async (file: types.RemoteFile) => {
    const target = await SelectDownloadPath(file.name);
    if (!target) return;
    await DownloadFile(active.id, file.path, target);
    onNotify("Download finished", "success");
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <input className="input compact-input" value={draftPath} onChange={(e) => setDraftPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onRefresh(draftPath)} />
        <button className="icon-btn compact-icon" onClick={() => onRefresh(draftPath)}><RefreshCw size={13} /></button>
        <button className="icon-btn compact-icon" onClick={upload}><Upload size={13} /></button>
        <button className="icon-btn compact-icon" onClick={async () => { const name = prompt("Folder name"); if (name) { await CreateRemoteDir(active.id, `${path}/${name}`); onRefresh(path); } }}><FolderPlus size={13} /></button>
      </div>
      <div className="file-table">
        {busy && <div className="empty compact">Loading...</div>}
        {!busy && files.map((file) => (
          <div key={file.path} className="file-row" onDoubleClick={() => file.isDir ? onRefresh(file.path) : download(file)}>
            {file.isDir ? <Folder size={14} className="text-accent" /> : <File size={14} className="text-muted" />}
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="w-14 text-right text-muted">{file.isDir ? "dir" : formatFileSize(file.size)}</span>
            <span className="hidden w-16 text-muted xl:inline">{file.permissions || file.mode}</span>
            <div className="file-actions">
              <button className="mini-btn" onClick={() => navigator.clipboard?.writeText(file.path)}><Copy size={11} /></button>
              {!file.isDir && <button className="mini-btn" onClick={() => download(file)}><Download size={11} /></button>}
              <button className="mini-btn" onClick={async () => { const next = prompt("Rename to", file.name); if (next) { await RenameRemoteFile(active.id, file.path, `${path}/${next}`); onRefresh(path); } }}><Edit3 size={11} /></button>
              <button className="mini-btn danger" onClick={async () => { if (confirm(`Delete ${file.name}?`)) { await DeleteRemoteFile(active.id, file.path); onRefresh(path); } }}><Trash2 size={11} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandsView(props: { commands: types.CommandTemplate[]; active?: Tab; onRun: (cmd: types.CommandTemplate) => void; onEdit: (cmd: types.CommandTemplate) => void; onDelete: (id: string) => void; onNew: () => void }) {
  return (
    <div className="space-y-2">
      <button className="btn-secondary w-full" onClick={props.onNew}><Plus size={15} /> New command</button>
      {props.commands.map((cmd) => (
        <div key={cmd.id} className="command-row">
          <Command size={14} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{cmd.name}</div>
            <div className="truncate font-mono text-[11px] text-muted">{cmd.command}</div>
          </div>
          <button className="mini-btn" disabled={!props.active} onClick={() => props.onRun(cmd)}><Play size={11} /></button>
          <button className="mini-btn" onClick={() => props.onEdit(new types.CommandTemplate(cmd))}><Edit3 size={11} /></button>
          <button className="mini-btn danger" onClick={() => props.onDelete(cmd.id)}><Trash2 size={11} /></button>
        </div>
      ))}
    </div>
  );
}

function SettingsView({ settings, onSave, onOpenData, dataDir }: { settings: types.AppSettings; onSave: (settings: types.AppSettings) => void; onOpenData: () => void; dataDir: string }) {
  const [draft, setDraft] = useState(new types.AppSettings(settings));
  const update = (patch: any) => setDraft(new types.AppSettings({ ...draft, ...patch }));
  const updateTerm = (patch: any) => setDraft(new types.AppSettings({ ...draft, terminal: { ...draft.terminal, ...patch } }));
  const setAppTheme = (theme: string) => {
    update({ themeName: theme, terminal: { ...draft.terminal, themeName: theme } });
  };
  return (
    <div className="space-y-2">
      <div className="panel dense space-y-2">
        <Label text="App theme"><select className="input compact-input" value={normalizeAppTheme(draft.themeName)} onChange={(e) => setAppTheme(e.target.value)}>{appThemes.map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text="Terminal theme"><select className="input compact-input" value={draft.terminal.themeName} onChange={(e) => updateTerm({ themeName: e.target.value })}>{Object.keys(terminalThemes).map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text="Font"><input className="input compact-input" value={draft.terminal.fontFamily} onChange={(e) => updateTerm({ fontFamily: e.target.value })} /></Label>
        <div className="grid grid-cols-2 gap-2">
          <Label text="Size"><input className="input compact-input" type="number" value={draft.terminal.fontSize} onChange={(e) => updateTerm({ fontSize: Number(e.target.value) })} /></Label>
          <Label text="Monitor"><input className="input compact-input" type="number" value={draft.monitorIntervalSec} onChange={(e) => update({ monitorIntervalSec: Number(e.target.value) })} /></Label>
        </div>
        <label className="check"><input type="checkbox" checked={draft.monitorEnabled} onChange={(e) => update({ monitorEnabled: e.target.checked })} /> Enable monitor</label>
        <label className="check"><input type="checkbox" checked={draft.smartHighlight} onChange={(e) => update({ smartHighlight: e.target.checked })} /> Smart Highlight placeholder</label>
      </div>
      <button className="btn-primary w-full" onClick={() => onSave(draft)}><Save size={15} /> Save settings</button>
      <button className="btn-secondary w-full" onClick={onOpenData}><HardDrive size={15} /> Open data</button>
      <div className="truncate text-[11px] text-muted">{dataDir}</div>
    </div>
  );
}

function GlobalSearchModal({ query, onQuery, results, onClose }: { query: string; onQuery: (value: string) => void; results: { type: string; title: string; subtitle: string; action: () => void }[]; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="search-box">
        <Search size={17} className="text-muted" />
        <input autoFocus className="search-input" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} placeholder="Search servers, commands, settings" />
        <kbd>Ctrl K</kbd>
      </div>
      <div className="search-results">
        {results.map((item, index) => (
          <button key={`${item.type}-${item.title}-${index}`} className="search-result" onClick={() => { item.action(); onClose(); }}>
            <span className="result-kind">{item.type}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.title}</span><span className="block truncate text-xs text-muted">{item.subtitle}</span></span>
          </button>
        ))}
        {!results.length && <div className="empty compact">Type to search.</div>}
      </div>
    </ModalShell>
  );
}

function TerminalSearchModal({ query, onQuery, onNext, onClose }: { query: string; onQuery: (value: string) => void; onNext: () => void; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="search-box">
        <Search size={17} className="text-muted" />
        <input autoFocus className="search-input" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onNext(); if (e.key === "Escape") onClose(); }} placeholder="Find in current terminal" />
        <kbd>Ctrl F</kbd>
      </div>
      <button className="btn-primary mt-3 w-full" onClick={onNext}>Find next</button>
    </ModalShell>
  );
}

function ProfileModal(props: { profile: types.Profile; onClose: () => void; onSave: (profile: types.Profile) => void; onPickKey: () => Promise<string>; onDelete: (id: string) => void; onDuplicate: (id: string) => void }) {
  const [draft, setDraft] = useState(new types.Profile(props.profile));
  const update = (patch: any) => setDraft(new types.Profile({ ...draft, ...patch }));
  return (
    <Modal title={draft.id ? "Edit server" : "New server"} onClose={props.onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Label text="Name"><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text="Group"><input className="input" value={draft.group} onChange={(e) => update({ group: e.target.value })} /></Label>
        <Label text="Host"><input className="input" value={draft.host} onChange={(e) => update({ host: e.target.value })} /></Label>
        <Label text="Port"><input className="input" type="number" value={draft.port} onChange={(e) => update({ port: Number(e.target.value) })} /></Label>
        <Label text="Username"><input className="input" value={draft.username} onChange={(e) => update({ username: e.target.value })} /></Label>
        <Label text="Auth"><select className="input" value={draft.authType} onChange={(e) => update({ authType: e.target.value })}><option value="password">Password</option><option value="privateKey">Private key</option></select></Label>
        {draft.authType === "password" ? <Label text="Password"><input className="input" type="password" value={draft.password || ""} onChange={(e) => update({ password: e.target.value })} /></Label> : <>
          <Label text="Private key"><div className="flex gap-2"><input className="input" value={draft.privateKeyPath || ""} onChange={(e) => update({ privateKeyPath: e.target.value })} /><button className="icon-btn" onClick={async () => update({ privateKeyPath: await props.onPickKey() })}><MoreHorizontal size={15} /></button></div></Label>
          <Label text="Passphrase"><input className="input" type="password" value={draft.privateKeyPassphrase || ""} onChange={(e) => update({ privateKeyPassphrase: e.target.value })} /></Label>
        </>}
        <label className="check col-span-2"><input type="checkbox" checked={draft.favorite} onChange={(e) => update({ favorite: e.target.checked })} /> Favorite</label>
        <label className="check col-span-2"><input type="checkbox" checked={draft.rememberPassword || false} onChange={(e) => update({ rememberPassword: e.target.checked })} /> Save password or passphrase in system credential store</label>
        <Label text="Description"><textarea className="input min-h-[70px]" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
      </div>
      <div className="mt-4 flex justify-between">
        <div>{draft.id && <><button className="btn-danger" onClick={() => props.onDelete(draft.id)}><Trash2 size={15} /> Delete</button><button className="btn-secondary ml-2" onClick={() => props.onDuplicate(draft.id)}><Copy size={15} /> Duplicate</button></>}</div>
        <button className="btn-primary" onClick={() => props.onSave(draft)}><Save size={15} /> Save</button>
      </div>
    </Modal>
  );
}

function CommandModal({ command, onClose, onSave }: { command: types.CommandTemplate; onClose: () => void; onSave: (command: types.CommandTemplate) => void }) {
  const [draft, setDraft] = useState(new types.CommandTemplate(command));
  const update = (patch: any) => setDraft(new types.CommandTemplate({ ...draft, ...patch }));
  return <Modal title="Command" onClose={onClose}><div className="space-y-3"><Label text="Name"><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label><Label text="Category"><input className="input" value={draft.category} onChange={(e) => update({ category: e.target.value })} /></Label><Label text="Command"><textarea className="input min-h-[90px] font-mono" value={draft.command} onChange={(e) => update({ command: e.target.value })} /></Label><Label text="Description"><input className="input" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label><button className="btn-primary w-full" onClick={() => onSave(draft)}><Save size={15} /> Save command</button></div></Modal>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <ModalShell onClose={onClose}><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">{title}</h2><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>{children}</ModalShell>;
}

function ModalShell({ children, onClose, compact }: { children: React.ReactNode; onClose: () => void; compact?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className={clsx("modal", compact && "modal-compact")} onMouseDown={(e) => e.stopPropagation()}>{children}</div></div>;
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return <label className="block text-xs text-muted"><span className="mb-1 block">{text}</span>{children}</label>;
}

function formatBytes(value: number) {
  if (!value) return "-";
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
  if (value > 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${value} B/s`;
}

function formatFileSize(value: number) {
  if (!value) return "0 B";
  if (value > 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)}G`;
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}M`;
  if (value > 1024) return `${(value / 1024).toFixed(1)}K`;
  return `${value}B`;
}

export default App;
