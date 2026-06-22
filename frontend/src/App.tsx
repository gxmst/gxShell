import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { types } from "../wailsjs/go/models";
import { CreateCommand, DeleteCommand, ListCommands, ListTextFilesInDir, ListRemoteTextFilesInDir, OpenDataDir, OpenRecentTextFile, ReadLogFile, SelectTextFile, SelectPrivateKey, SendCommandToAll, SendCommandToTerminal, StartMonitor, UpdateCommand } from "../wailsjs/go/main/App";
import { emptyProfile } from "./constants";
import type { Drawer, MarkdownOpenTarget, RecentMarkdownItem, SplitPane, Tab } from "./types";
import { normalizeAppTheme } from "./utils/format";
import { useToasts } from "./hooks/useToasts";
import { useProfiles } from "./hooks/useProfiles";
import { useMonitor } from "./hooks/useMonitor";
import { useTerminal } from "./hooks/useTerminal";
import { useSessions } from "./hooks/useSessions";
import { useSftp } from "./hooks/useSftp";
import { useHotkeys } from "./hooks/useHotkeys";
import { usePersistedState } from "./hooks/usePersistedState";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TerminalArea } from "./components/TerminalArea/TerminalArea";
import { FloatingTerminal } from "./components/FloatingTerminal/FloatingTerminal";
import { ProfileModal } from "./components/modals/ProfileModal";
import { CommandModal } from "./components/modals/CommandModal";
import { SecretModal } from "./components/modals/SecretModal";
import { GlobalSearchModal, TerminalSearchModal } from "./components/modals/SearchModals";
import { ProgressBar } from "./components/ProgressBar/ProgressBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastStack } from "./components/ToastStack";
import { TransfersProvider } from "./hooks/useTransfers";
import { EventsOn, OnFileDrop, OnFileDropOff } from "../wailsjs/runtime/runtime";
import { isSupportedTextPath } from "./utils/textFiles";
import { t } from "./i18n";

const normalizeLocalPath = (filePath: string) => filePath.replace(/\\/g, "/");

const newMarkdownTabId = () => `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const fileNameFromPath = (filePath: string) => filePath.split(/[\\/]/).pop() || "Text file";

const recentMarkdownId = (item: Pick<RecentMarkdownItem, "source" | "path" | "profileId" | "sessionId">) => {
  if (item.source === "local") return `local:${normalizeLocalPath(item.path).toLowerCase()}`;
  return `remote:${item.profileId || item.sessionId || ""}:${item.path}`;
};

function App() {
  const { toasts, notify } = useToasts();
  const profileState = useProfiles(notify);
  const { metrics } = useMonitor();
  const [drawer, setDrawer] = usePersistedState<Drawer>("gx:drawer", "monitor");
  const [profileModal, setProfileModal] = useState<types.Profile | null>(null);
  const [commandModal, setCommandModal] = useState<types.CommandTemplate | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearch, setTerminalSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState("gx:sidebarCollapsed", false);
  const [logViewer, setLogViewer] = useState<{ name: string; content: string } | null>(null);
  const [floatingTabIds, setFloatingTabIds] = usePersistedState<string[]>("gx:floatingTabIds", []);
  const [splitPane, setSplitPane] = useState<SplitPane | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{x:number, y:number, items:{label:string, action:()=>void, danger?:boolean}[]} | null>(null);
  const [markdownSiblings, setMarkdownSiblings] = useState<string[]>([]);
  const [recentMarkdown, setRecentMarkdown] = usePersistedState<RecentMarkdownItem[]>("gx:recentMarkdown", []);

  useEffect(() => {
    const hide = () => setCtxMenu(null);
    window.addEventListener("click", hide);
    return () => window.removeEventListener("click", hide);
  }, []);

  const terminalBridge = useRef<{ disposeTerminal: (id: string) => void }>({ disposeTerminal: () => undefined });
  const sessions = useSessions({
    profiles: profileState.profiles,
    notify,
    reload: profileState.reload,
    disposeTerminal: (id) => terminalBridge.current.disposeTerminal(id),
    confirmOnDisconnect: profileState.settings?.confirmOnDisconnect,
  });
  const tabsRef = useRef(sessions.tabs);
  tabsRef.current = sessions.tabs;

  const activeMetrics = sessions.active ? metrics[sessions.active.id] : undefined;
  const sftp = useSftp(sessions.active, drawer, notify);

  const activeIsTerminal = !!sessions.active && sessions.active.type !== "markdown";
  const activeTerminal = useTerminal(sessions.activeTab, activeIsTerminal, profileState.settings, notify, sidebarCollapsed, splitPane);
  const { writeOutput, disposeTerminal, findNext, focusTerminal, refitTerminal, reattachTerminal } = activeTerminal;
  terminalBridge.current.disposeTerminal = disposeTerminal;

  const rememberMarkdown = useCallback((item: Omit<RecentMarkdownItem, "id" | "openedAt">) => {
    const nextItem: RecentMarkdownItem = {
      ...item,
      id: recentMarkdownId(item),
      openedAt: Date.now(),
    };
    setRecentMarkdown((prev) => [nextItem, ...prev.filter((old) => old.id !== nextItem.id)].slice(0, 30));
  }, [setRecentMarkdown]);

  const openMarkdownFile = useCallback(async (filePath: string) => {
    const normalizedPath = normalizeLocalPath(filePath);
    const existing = tabsRef.current.find((tab) => tab.type === "markdown" && tab.filePath && normalizeLocalPath(tab.filePath) === normalizedPath);
    rememberMarkdown({ source: "local", path: filePath, title: fileNameFromPath(filePath) });
    if (existing) {
      sessions.setActiveTab(existing.id);
      setDrawer("sftp");
      try {
        const siblings = await ListTextFilesInDir(filePath);
        setMarkdownSiblings(siblings || []);
      } catch {
        setMarkdownSiblings([]);
      }
      return;
    }

    const fileName = fileNameFromPath(filePath);
    const newTab: Tab = {
      id: newMarkdownTabId(),
      profileId: "",
      title: fileName,
      state: "connected",
      type: "markdown",
      markdownSource: "local",
      filePath: filePath
    };

    sessions.setTabs(prev => [...prev, newTab]);
    sessions.setActiveTab(newTab.id);
    setDrawer("sftp");

    try {
      const siblings = await ListTextFilesInDir(filePath);
      setMarkdownSiblings(siblings || []);
    } catch {
      setMarkdownSiblings([]);
    }
  }, [rememberMarkdown, sessions.setActiveTab, sessions.setTabs, setDrawer]);

  const openRemoteMarkdownFile = useCallback(async (sessionID: string, remotePath: string) => {
    const sessionTab = tabsRef.current.find((tab) => tab.id === sessionID);
    const profile = sessionTab ? profileState.profiles.find((item) => item.id === sessionTab.profileId) : undefined;
    const existing = tabsRef.current.find((tab) => (
      tab.type === "markdown" &&
      tab.markdownSource === "remote" &&
      tab.remoteSessionId === sessionID &&
      tab.remotePath === remotePath
    ));
    rememberMarkdown({
      source: "remote",
      path: remotePath,
      title: fileNameFromPath(remotePath),
      sessionId: sessionID,
      profileId: sessionTab?.profileId,
      host: profile ? `${profile.username}@${profile.host}` : sessionTab?.title,
    });
    if (existing) {
      sessions.setActiveTab(existing.id);
      setDrawer("sftp");
      try {
        const siblings = await ListRemoteTextFilesInDir(sessionID, remotePath);
        setMarkdownSiblings(siblings || []);
      } catch {
        setMarkdownSiblings([]);
      }
      return;
    }

    const newTab: Tab = {
      id: newMarkdownTabId(),
      profileId: sessionTab?.profileId || "",
      title: fileNameFromPath(remotePath),
      state: "connected",
      type: "markdown",
      markdownSource: "remote",
      remotePath,
      remoteSessionId: sessionID,
    };

    sessions.setTabs(prev => [...prev, newTab]);
    sessions.setActiveTab(newTab.id);
    setDrawer("sftp");

    try {
      const siblings = await ListRemoteTextFilesInDir(sessionID, remotePath);
      setMarkdownSiblings(siblings || []);
    } catch {
      setMarkdownSiblings([]);
    }
  }, [profileState.profiles, rememberMarkdown, sessions.setActiveTab, sessions.setTabs, setDrawer]);

  const openMarkdownTarget = useCallback((target: MarkdownOpenTarget) => {
    if (target.source === "remote") {
      openRemoteMarkdownFile(target.sessionId, target.path);
    } else {
      openMarkdownFile(target.path);
    }
  }, [openMarkdownFile, openRemoteMarkdownFile]);

  const handleOpenMarkdown = useCallback(async () => {
    try {
      const filePath = await SelectTextFile();
      if (filePath) {
        openMarkdownFile(filePath);
      }
    } catch (err) {
      notify(String(err), "error");
    }
  }, [openMarkdownFile, notify]);

  const handleOpenRecentMarkdown = useCallback(async (item: RecentMarkdownItem) => {
    try {
      if (item.source === "local") {
        const allowed = await OpenRecentTextFile(item.path);
        if (allowed) openMarkdownFile(allowed);
        return;
      }

      const liveSession = sessions.tabs.find((tab) => (
        tab.type !== "markdown" &&
        (tab.id === item.sessionId || (!!item.profileId && tab.profileId === item.profileId)) &&
        tab.state === "connected"
      ));
      if (!liveSession) {
        notify(t(profileState.settings?.language || "en", "connectServerFirstTextFile"), "info");
        return;
      }
      openRemoteMarkdownFile(liveSession.id, item.path);
    } catch (err) {
      notify(String(err), "error");
    }
  }, [notify, openMarkdownFile, openRemoteMarkdownFile, sessions.tabs]);

  const handleRemoveRecentMarkdown = useCallback((id: string) => {
    setRecentMarkdown((prev) => prev.filter((item) => item.id !== id));
  }, [setRecentMarkdown]);

  const handleOpenMarkdownSibling = useCallback((path: string) => {
    const activeTab = tabsRef.current.find((tab) => tab.id === sessions.activeTab);
    if (activeTab?.type === "markdown" && activeTab.markdownSource === "remote" && activeTab.remoteSessionId) {
      openRemoteMarkdownFile(activeTab.remoteSessionId, path);
      return;
    }
    openMarkdownFile(path);
  }, [openMarkdownFile, openRemoteMarkdownFile, sessions.activeTab]);

  useEffect(() => {
    OnFileDrop((_x, _y, _paths) => {
      // The browser-side callback only installs Wails' drop listener. The
      // trusted open path is handled in Go, where dropped paths are confirmed
      // with a native dialog before they are added to the local-file allowlist.
    }, false);

    const unsubFileOpen = EventsOn("file:open", (filePath: string) => {
      if (isSupportedTextPath(filePath)) {
        openMarkdownFile(filePath);
      }
    });

    // 托盘菜单事件监听
    const unsubTrayNewConnection = EventsOn("tray:new-connection", () => {
      setProfileModal(emptyProfile());
    });

    const unsubTrayOpenMarkdown = EventsOn("tray:open-markdown", () => {
      handleOpenMarkdown();
    });

    const unsubTraySettings = EventsOn("tray:settings", () => {
      setDrawer("settings");
    });

    return () => {
      if (unsubFileOpen) unsubFileOpen();
      if (unsubTrayNewConnection) unsubTrayNewConnection();
      if (unsubTrayOpenMarkdown) unsubTrayOpenMarkdown();
      if (unsubTraySettings) unsubTraySettings();
      OnFileDropOff();
    };
  }, [openMarkdownFile, handleOpenMarkdown, setDrawer]);

  const handleTearOff = useCallback((tab: Tab) => {
    setFloatingTabIds((prev) => prev.includes(tab.id) ? prev : [...prev, tab.id]);
    if (sessions.activeTab === tab.id) {
      const remaining = sessions.tabs.filter((t) => t.id !== tab.id);
      if (remaining.length > 0) {
        sessions.setActiveTab(remaining[0].id);
      }
    }
    setTimeout(() => refitTerminal(tab.id), 50);
  }, [refitTerminal, sessions.activeTab, sessions.tabs, sessions.setActiveTab]);

  const handleDockFloating = useCallback((id: string) => {
    setFloatingTabIds((prev) => prev.filter((fid) => fid !== id));
    sessions.setActiveTab(id);
    // reattachTerminal is called from FloatingTerminal's cleanup effect,
    // which includes a delayed refitTerminal, so no extra call is needed here.
  }, [sessions.setActiveTab]);

  const handleCloseFloating = useCallback(async (id: string) => {
    await sessions.closeTab(id);
    setFloatingTabIds((prev) => prev.filter((fid) => fid !== id));
  }, [sessions.closeTab]);

  useEffect(() => {
    const tabIds = new Set(sessions.tabs.map((t) => t.id));
    setFloatingTabIds((prev) => prev.filter((id) => tabIds.has(id)));
    if (splitPane && (!tabIds.has(splitPane.left) || !tabIds.has(splitPane.right))) {
      setSplitPane(null);
    }
  }, [sessions.tabs]);

  useEffect(() => {
    const activeTab = sessions.tabs.find(t => t.id === sessions.activeTab);
    if (activeTab?.type === 'markdown' && activeTab.markdownSource === "remote" && activeTab.remoteSessionId && activeTab.remotePath) {
      ListRemoteTextFilesInDir(activeTab.remoteSessionId, activeTab.remotePath).then(siblings => {
        setMarkdownSiblings(siblings || []);
      }).catch(() => {
        setMarkdownSiblings([]);
      });
    } else if (activeTab?.type === 'markdown' && activeTab.filePath) {
      ListTextFilesInDir(activeTab.filePath).then(siblings => {
        setMarkdownSiblings(siblings || []);
      }).catch(() => {
        setMarkdownSiblings([]);
      });
    } else {
      setMarkdownSiblings([]);
    }
  }, [sessions.activeTab, sessions.tabs]);

  useEffect(() => {
    const offData = EventsOn("terminal:data", (payload: { sessionId: string; data: string }) => {
      writeOutput(payload.sessionId, payload.data);
    });
    return () => offData();
  }, [writeOutput]);

  useHotkeys({
    activeTab: sessions.activeTab,
    activeIsMarkdown: sessions.active?.type === "markdown",
    onGlobalSearch: () => { setGlobalQuery(""); setGlobalSearchOpen(true); },
    onTerminalSearch: () => setTerminalSearchOpen(true),
    onCloseTab: sessions.closeTab
  });

  const saveProfile = async (profile: types.Profile) => {
    try {
      await profileState.saveProfile(profile);
      setProfileModal(null);
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
      profileState.setCommands(await ListCommands());
    } catch (err) {
      notify(String(err), "error");
    }
  };

  const profilesRef = useRef(profileState.profiles);
  profilesRef.current = profileState.profiles;
  const commandsRef = useRef(profileState.commands);
  commandsRef.current = profileState.commands;
  const activeRef = useRef(sessions.active);
  activeRef.current = sessions.active;

  const globalResults = useMemo(() => {
    const q = globalQuery.trim().toLowerCase();
    if (!q) return [];
    const pr = profilesRef.current;
    const cm = commandsRef.current;
    const ac = activeRef.current;
    const serverResults = pr
      .filter((profile) => [profile.name, profile.host, profile.username, profile.group].some((value) => (value || "").toLowerCase().includes(q)))
      .slice(0, 6)
      .map((profile) => ({ type: "server", title: profile.name || profile.host, subtitle: `${profile.username}@${profile.host}`, action: () => sessions.connectProfile(profile) }));
    const commandResults = cm
      .filter((cmd) => [cmd.name, cmd.command, cmd.category].some((value) => (value || "").toLowerCase().includes(q)))
      .slice(0, 6)
      .map((cmd) => ({ type: "command", title: cmd.name, subtitle: cmd.command, action: () => ac && SendCommandToTerminal(ac.id, cmd.command) }));
    const areaResults = (["monitor", "sftp", "commands", "settings"] as Drawer[])
      .filter((item) => item.includes(q))
      .map((item) => ({ type: "area", title: item, subtitle: "Open left panel", action: () => setDrawer(item) }));
    return [...serverResults, ...commandResults, ...areaResults];
  }, [globalQuery, sessions.active]);

  const themeName = normalizeAppTheme(profileState.settings?.themeName);

  const handleNewConnection = useCallback(() => setProfileModal(emptyProfile()), []);
  const handleToggleSidebar = useCallback(() => setSidebarCollapsed(v => !v), []);

  return (
    <ErrorBoundary>
    <TransfersProvider>
    <div className="app-shell" onContextMenu={() => setCtxMenu(null)} data-theme={themeName} data-collapsed={sidebarCollapsed ? "true" : "false"} >
      <main className="workspace">
        <Sidebar
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          setCtxMenu={setCtxMenu}
          drawer={drawer}          setDrawer={setDrawer}
          profiles={profileState.profiles}
          commands={profileState.commands}
          settings={profileState.settings}
          appInfo={profileState.appInfo}
          active={sessions.active}
          activeMetrics={activeMetrics}
          remotePath={sftp.remotePath}
          remoteFiles={sftp.remoteFiles}
          sftpBusy={sftp.sftpBusy}
          markdownSiblings={markdownSiblings}
          recentMarkdown={recentMarkdown}
          onOpenMarkdownFile={handleOpenMarkdownSibling}
          onOpenRemoteMarkdownFile={openRemoteMarkdownFile}
          onOpenRecentMarkdown={handleOpenRecentMarkdown}
          onRemoveRecentMarkdown={handleRemoveRecentMarkdown}
          onNewProfile={() => setProfileModal(emptyProfile())}
          onEditProfile={(profile) => setProfileModal(new types.Profile(profile))}
          onConnectProfile={sessions.connectProfile}
          onDeleteProfile={async (id) => { await profileState.deleteProfile(id); }}
          onOpenSearch={() => setGlobalSearchOpen(true)}
          onStartMonitor={() => sessions.active && StartMonitor(sessions.active.id)}
          onRefreshSftp={sftp.refreshSftp}
          onNotify={notify}
          onRunCommand={(cmd) => { 
            if (sessions.active) {
                SendCommandToTerminal(sessions.active.id, cmd.command);
                setTimeout(() => focusTerminal(sessions.activeTab), 10);
            }
          }}     
          onRunCommandAll={(cmd) => {
            SendCommandToAll(cmd.command).catch(() => {});
          }}
          onEditCommand={(cmd) => setCommandModal(cmd)}
          onDeleteCommand={async (id) => { await DeleteCommand(id); profileState.setCommands(await ListCommands()); }}
          onNewCommand={() => setCommandModal(new types.CommandTemplate({ id: "", name: "", command: "", category: "Custom", description: "", tags: [] }))}
          onSaveSettings={async (next) => { await profileState.saveSettings(next); notify(t(profileState.settings?.language || "en", "settingsSaved"), "success"); }}
          onOpenData={OpenDataDir}
          onOpenLog={async (name) => {
            try {
              const content = await ReadLogFile(name);
              setLogViewer({ name, content });
            } catch { notify("Failed to read log file", "error"); }
          }}
          getTerminalLines={activeTerminal.getTerminalLines}
          activeTabId={sessions.activeTab}
        />
        <TerminalArea
          tabs={sessions.tabs}
          activeTab={sessions.activeTab}
          profiles={profileState.profiles}
          terminalHosts={activeTerminal.terminalHosts}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={handleToggleSidebar}
          onActive={sessions.setActiveTab}
          onClose={sessions.closeTab}
          onReconnect={sessions.reconnectTab}
          onNewConnection={handleNewConnection}
          onNewLocal={sessions.connectLocal}
          onOpenMarkdown={handleOpenMarkdown}
          onOpenMarkdownFile={openMarkdownTarget}
          onNotify={notify}
          onTearOff={handleTearOff}
          language={profileState.settings?.language || "en"}
          logViewer={logViewer}
          onCloseLogViewer={() => setLogViewer(null)}
          floatingTabIds={floatingTabIds}
          splitPane={splitPane}
          onSplitChange={setSplitPane}
          refitTerminal={refitTerminal}
        />
      </main>
      {floatingTabIds.map((id) => {
        const tab = sessions.tabs.find((t) => t.id === id);
        if (!tab) return null;
        return <FloatingTerminal key={id} tab={tab} terminalHosts={activeTerminal.terminalHosts} onDock={handleDockFloating} onClose={handleCloseFloating} refitTerminal={refitTerminal} reattachTerminal={reattachTerminal} />;
      })}
      {globalSearchOpen && <GlobalSearchModal query={globalQuery} onQuery={setGlobalQuery} results={globalResults} onClose={() => setGlobalSearchOpen(false)} locale={profileState.settings?.language || "en"} />}
      {terminalSearchOpen && <TerminalSearchModal query={terminalSearch} onQuery={setTerminalSearch} onNext={() => activeTerminal.findNext(sessions.activeTab, terminalSearch)} onClose={() => setTerminalSearchOpen(false)} locale={profileState.settings?.language || "en"} />}
      {profileModal && <ProfileModal profile={profileModal} profiles={profileState.profiles} language={profileState.settings?.language || "en"} onClose={() => setProfileModal(null)} onSave={saveProfile} onPickKey={SelectPrivateKey} onDelete={async (id) => { await profileState.deleteProfile(id); setProfileModal(null); }} onDuplicate={async (id) => { await profileState.duplicateProfile(id); notify(t(profileState.settings?.language || "en", "profileCopied"), "info"); }} />}
      {commandModal && <CommandModal command={commandModal} language={profileState.settings?.language || "en"} onClose={() => setCommandModal(null)} onSave={saveCommand} />}
      {sessions.secretRequest && <SecretModal request={sessions.secretRequest} language={profileState.settings?.language || "en"} onClose={() => sessions.setSecretRequest(null)} onSubmit={async (password, passphrase) => { const request = sessions.secretRequest; sessions.setSecretRequest(null); if (request) await sessions.submitSecret(request, password, passphrase); }} />}
      <ProgressBar />
      <ToastStack toasts={toasts} />
      {ctxMenu && (
        <div className="fixed z-[9999] border border-border rounded-lg shadow-2xl py-1 w-40 overflow-hidden" style={{ left: ctxMenu.x, top: ctxMenu.y, backgroundColor: "var(--panel-raised)" }} onClick={(e) => e.stopPropagation()}>
          {ctxMenu.items.map((item, i) => (
            <button key={i} className={clsx("w-full text-left px-4 py-2 text-[12px] hover:bg-white/10 transition-colors", item.danger && "text-bad")} onClick={() => { item.action(); setCtxMenu(null); }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
    </TransfersProvider>
    </ErrorBoundary>
  );
}

export default App;
