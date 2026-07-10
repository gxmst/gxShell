import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { types } from "../wailsjs/go/models";
import { AnswerKeyboardInteractive, CreateCommand, DeleteCommand, GetStartupFile, ListCommands, OpenDataDir, ReadLogFile, SelectPrivateKey, SendCommandToAll, SendCommandToTerminal, StartMonitor, StartRecording, StopRecording, UpdateCommand } from "../wailsjs/go/main/App";
import { emptyProfile } from "./constants";
import type { AutomationActivityEvent, AutomationIndicator, Drawer, SplitPane, Tab } from "./types";
import { normalizeAppTheme } from "./utils/format";
import { useToasts } from "./hooks/useToasts";
import { useProfiles } from "./hooks/useProfiles";
import { useMonitor } from "./hooks/useMonitor";
import { useTerminal } from "./hooks/useTerminal";
import { useSessions } from "./hooks/useSessions";
import { useSftp } from "./hooks/useSftp";
import { useHotkeys } from "./hooks/useHotkeys";
import { useMarkdownTabs } from "./hooks/useMarkdownTabs";
import { usePersistedState } from "./hooks/usePersistedState";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TerminalArea } from "./components/TerminalArea/TerminalArea";
import { FloatingTerminal } from "./components/FloatingTerminal/FloatingTerminal";
import { ProfileModal } from "./components/modals/ProfileModal";
import { CommandModal } from "./components/modals/CommandModal";
import { CommandVarsDialog } from "./components/modals/CommandVarsDialog";
import { extractPlaceholders } from "./utils/commandVars";
import { SecretModal } from "./components/modals/SecretModal";
import { KeyboardInteractiveDialog, type KiRequest } from "./components/modals/KeyboardInteractiveDialog";
import { GlobalSearchModal, TerminalSearchModal } from "./components/modals/SearchModals";
import { ProgressBar } from "./components/ProgressBar/ProgressBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastStack } from "./components/ToastStack";
import { TransfersProvider } from "./hooks/useTransfers";
import { BrowserOpenURL, EventsOn, OnFileDrop, OnFileDropOff } from "../wailsjs/runtime/runtime";
import { isSupportedTextPath } from "./utils/textFiles";
import { shellQuote } from "./utils/shellQuote";
import { t } from "./i18n";
import { formatAutomationTerminalEvent } from "./utils/automation";

function App() {
  const { toasts, notify } = useToasts();
  const profileState = useProfiles(notify);
  const { metrics } = useMonitor();
  const [drawer, setDrawer] = usePersistedState<Drawer>("gx:drawer", "monitor");
  const [profileModal, setProfileModal] = useState<types.Profile | null>(null);
  const [commandModal, setCommandModal] = useState<types.CommandTemplate | null>(null);
  const [commandVars, setCommandVars] = useState<{ commandName: string; template: string; placeholders: string[]; send: (command: string) => void } | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearch, setTerminalSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState("gx:sidebarCollapsed", false);
  const [logViewer, setLogViewer] = useState<{ name: string; content: string } | null>(null);
  const [floatingTabIds, setFloatingTabIds] = usePersistedState<string[]>("gx:floatingTabIds", []);
  const [splitPane, setSplitPane] = useState<SplitPane | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{x:number, y:number, items:{label:string, action:()=>void, danger?:boolean}[]} | null>(null);
  const [broadcastInput, setBroadcastInput] = useState(false);
  // Session ids currently recording. Backend owns the real state; this mirror
  // drives the TabBar toggle. Cleared for a session when it stops or closes.
  const [recordingIds, setRecordingIds] = useState<string[]>([]);
  const [kiRequests, setKiRequests] = useState<KiRequest[]>([]);
  const [automationActivity, setAutomationActivity] = useState<Record<string, AutomationIndicator>>({});
  const automationRunningRef = useRef<Record<string, Map<string, AutomationIndicator["source"]>>>({});
  const automationClearTimers = useRef<Record<string, number>>({});

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

  // Broadcast (synchronized input) target set, kept in a ref so the terminal's
  // onData closure always reads the current value without re-binding. Targets are
  // the connected, non-floating SSH terminals; local and markdown tabs are excluded.
  const broadcastRef = useRef<{ enabled: boolean; targets: string[] }>({ enabled: false, targets: [] });
  const connectedSshTabs = useMemo(
    () => sessions.tabs.filter((tab) => tab.type !== "markdown" && !tab.local && tab.state === "connected"),
    [sessions.tabs]
  );
  const connectedSshCount = connectedSshTabs.length;
  broadcastRef.current = {
    enabled: broadcastInput,
    targets: connectedSshTabs
      .filter((tab) => !floatingTabIds.includes(tab.id))
      .map((tab) => tab.id),
  };
  // Turn broadcast off automatically once fewer than two terminals remain.
  useEffect(() => {
    if (broadcastInput && connectedSshCount < 2) setBroadcastInput(false);
  }, [broadcastInput, connectedSshCount]);

  // Drop recording flags for sessions that no longer exist (closed/disconnected).
  useEffect(() => {
    // A session records only while connected. Drop ids whose tab is gone OR is no
    // longer connected (the backend stops and finalizes the recording on
    // disconnect/error), so the toolbar toggle never shows a stale "recording"
    // state on a dropped session.
    const connected = new Set(
      sessions.tabs.filter((tab) => tab.state === "connected").map((tab) => tab.id)
    );
    setRecordingIds((prev) => {
      const next = prev.filter((id) => connected.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [sessions.tabs]);

  const toggleRecording = useCallback(async (sessionId: string) => {
    const tab = tabsRef.current.find((item) => item.id === sessionId);
    if (!tab || tab.local || tab.type === "markdown") return;
    const isRecording = recordingIds.includes(sessionId);
    try {
      if (isRecording) {
        const file = await StopRecording(sessionId);
        setRecordingIds((prev) => prev.filter((id) => id !== sessionId));
        notify(t(profileState.settings?.language || "en", "recordingSaved", { name: file }), "success");
      } else {
        const title = tab.title || "session";
        await StartRecording(sessionId, title);
        setRecordingIds((prev) => prev.includes(sessionId) ? prev : [...prev, sessionId]);
        notify(t(profileState.settings?.language || "en", "recordingStarted"), "info");
      }
    } catch (err) {
      notify(String(err), "error");
    }
  }, [recordingIds, notify, profileState.settings?.language]);

  const activeRecording = !!sessions.activeTab && recordingIds.includes(sessions.activeTab);

  const activeMetrics = sessions.active ? metrics[sessions.active.id] : undefined;
  const sftp = useSftp(sessions.active, drawer, notify);

  // Clickable terminal links. Kept in a ref so useTerminal's per-terminal link
  // provider always calls the current handlers. openUrl opens the system browser;
  // openPath reveals the clicked path's directory in the SFTP drawer for the
  // session that produced the link, which matters in split view.
  const linkHandlersRef = useRef<{ openUrl: (url: string) => void; openPath: (sessionId: string, path: string) => void }>({ openUrl: () => undefined, openPath: () => undefined });
  linkHandlersRef.current = {
    openUrl: (url) => { BrowserOpenURL(url); },
    openPath: (sessionId, path) => {
      const tab = tabsRef.current.find((item) => item.id === sessionId);
      if (!tab || tab.local || tab.type === "markdown") return;
      const dir = path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
      sessions.setActiveTab(sessionId);
      setDrawer("sftp");
      sftp.refreshSftp(dir, sessionId);
    },
  };

  const activeIsTerminal = !!sessions.active && sessions.active.type !== "markdown";
  const activeTerminal = useTerminal(sessions.activeTab, activeIsTerminal, profileState.settings, notify, sidebarCollapsed, splitPane, broadcastRef, linkHandlersRef);
  const { writeOutput, disposeTerminal, findNext, findPrev, focusTerminal, refitTerminal, reattachTerminal } = activeTerminal;
  terminalBridge.current.disposeTerminal = disposeTerminal;

  const {
    markdownSiblings,
    recentMarkdown,
    openMarkdownFile,
    openRemoteMarkdownFile,
    openMarkdownTarget,
    handleOpenMarkdown,
    handleOpenRecentMarkdown,
    handleRemoveRecentMarkdown,
    handleOpenMarkdownSibling,
  } = useMarkdownTabs({
    tabs: sessions.tabs,
    activeTab: sessions.activeTab,
    profiles: profileState.profiles,
    setTabs: sessions.setTabs,
    setActiveTab: sessions.setActiveTab,
    setDrawer,
    notify,
    language: profileState.settings?.language || "en",
  });

  // Language for toasts fired from long-lived event listeners; a ref avoids
  // resubscribing those listeners whenever the language setting changes.
  const langRef = useRef(profileState.settings?.language || "en");
  langRef.current = profileState.settings?.language || "en";

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

    const unsubRecordingError = EventsOn("recording:error", (payload: { error?: string }) => {
      notify(payload?.error || "Failed to finalize recording", "error");
    });

    // Surface local CLI HTTP server startup failures (e.g. port already in
    // use); otherwise the external gxshell-cli silently cannot connect.
    const unsubCliServerError = EventsOn("cli:server-error", (payload: { address?: string; error?: string }) => {
      notify(t(langRef.current, "cliServerError", { error: payload?.error || "unknown error" }), "error");
    });

    // Keyboard-interactive (2FA/OTP/PAM) prompts raised mid-handshake. The Go
    // side blocks the SSH handshake until AnswerKeyboardInteractive resolves the
    // matching requestId; the :closed event fires if the handshake gives up
    // (timeout) so we can dismiss a dialog the user never answered.
    const unsubKi = EventsOn("terminal:keyboard-interactive", (payload: KiRequest) => {
      setKiRequests((prev) => prev.some((item) => item.requestId === payload.requestId) ? prev : [...prev, payload]);
    });
    const unsubKiClosed = EventsOn("terminal:keyboard-interactive:closed", (payload: { requestId: string }) => {
      setKiRequests((prev) => prev.filter((item) => item.requestId !== payload.requestId));
    });

    // Pull side of the file-open handshake. On first launch the Go side may emit
    // "file:open" during OnDomReady, before this listener exists, so the pushed
    // event is lost and the app opens without the document. Pulling once here,
    // right after the listener is registered, recovers that file. Both paths are
    // idempotent because openMarkdownFile de-duplicates by tab.
    GetStartupFile().then((filePath) => {
      if (filePath && isSupportedTextPath(filePath)) {
        openMarkdownFile(filePath);
      }
    }).catch(() => undefined);

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
      if (unsubRecordingError) unsubRecordingError();
      if (unsubCliServerError) unsubCliServerError();
      if (unsubTrayNewConnection) unsubTrayNewConnection();
      if (unsubTrayOpenMarkdown) unsubTrayOpenMarkdown();
      if (unsubTraySettings) unsubTraySettings();
      if (unsubKi) unsubKi();
      if (unsubKiClosed) unsubKiClosed();
      OnFileDropOff();
    };
  }, [openMarkdownFile, handleOpenMarkdown, setDrawer, notify]);

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
    setAutomationActivity((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => tabIds.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    for (const id of Object.keys(automationRunningRef.current)) {
      if (tabIds.has(id)) continue;
      delete automationRunningRef.current[id];
      if (automationClearTimers.current[id]) {
        window.clearTimeout(automationClearTimers.current[id]);
        delete automationClearTimers.current[id];
      }
    }
    if (splitPane && (!tabIds.has(splitPane.left) || !tabIds.has(splitPane.right))) {
      setSplitPane(null);
    }
  }, [sessions.tabs]);

  useEffect(() => {
    const offData = EventsOn("terminal:data", (payload: { sessionId: string; data: string }) => {
      writeOutput(payload.sessionId, payload.data);
    });
    return () => offData();
  }, [writeOutput]);

  useEffect(() => {
    const offAutomation = EventsOn("terminal:automation", (payload: AutomationActivityEvent) => {
      if (!payload?.sessionId || !payload.activityId) return;
      writeOutput(payload.sessionId, formatAutomationTerminalEvent(payload));

      const running = automationRunningRef.current[payload.sessionId] || new Map<string, AutomationIndicator["source"]>();
      automationRunningRef.current[payload.sessionId] = running;
      if (payload.phase === "started") running.set(payload.activityId, payload.source);
      else running.delete(payload.activityId);

      const existingTimer = automationClearTimers.current[payload.sessionId];
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        delete automationClearTimers.current[payload.sessionId];
      }

      const updatedAt = Date.now();
      const runningCount = running.size;
      const runningSources = Array.from(running.values());
      const runningSource = runningCount > 0
        ? runningSources[runningSources.length - 1] || payload.source
        : payload.source;
      setAutomationActivity((prev) => ({
        ...prev,
        [payload.sessionId]: {
          source: runningSource,
          phase: runningCount > 0 ? "started" : payload.phase,
          running: runningCount,
          updatedAt,
        },
      }));

      if (runningCount === 0) {
        automationClearTimers.current[payload.sessionId] = window.setTimeout(() => {
          setAutomationActivity((prev) => {
            if (prev[payload.sessionId]?.updatedAt !== updatedAt) return prev;
            const next = { ...prev };
            delete next[payload.sessionId];
            return next;
          });
          delete automationClearTimers.current[payload.sessionId];
        }, 8000);
      }
    });
    return () => offAutomation();
  }, [writeOutput]);

  useEffect(() => () => {
    Object.values(automationClearTimers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  useHotkeys({
    activeTab: sessions.activeTab,
    activeIsMarkdown: sessions.active?.type === "markdown",
    onGlobalSearch: () => { setGlobalQuery(""); setGlobalSearchOpen(true); },
    onTerminalSearch: () => setTerminalSearchOpen(true),
    onCloseTab: sessions.closeTab
  });

  const automationByProfile = useMemo(() => {
    const byProfile: Record<string, AutomationIndicator> = {};
    for (const tab of sessions.tabs) {
      const activity = automationActivity[tab.id];
      if (!activity || !tab.profileId) continue;
      const current = byProfile[tab.profileId];
      const activityRunning = activity.phase === "started";
      const currentRunning = current?.phase === "started";
      if (!current || (activityRunning && !currentRunning) || (activityRunning === currentRunning && activity.updatedAt > current.updatedAt)) {
        byProfile[tab.profileId] = activity;
      }
    }
    return byProfile;
  }, [automationActivity, sessions.tabs]);

  const saveProfile = async (profile: types.Profile) => {
    try {
      await profileState.saveProfile(profile);
      setProfileModal(null);
      notify(t(profileState.settings?.language || "en", "profileSaved"), "success");
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

  // Running a saved command first checks for <name> placeholders. If present, we
  // open the fill dialog and only send once the user resolves them; otherwise the
  // command is sent as-is. `send` performs the actual delivery on the resolved
  // string, so the placeholder path and the direct path share one code path.
  const runCommandTemplate = useCallback((cmd: types.CommandTemplate, send: (command: string) => void) => {
    const placeholders = extractPlaceholders(cmd.command);
    if (placeholders.length === 0) {
      send(cmd.command);
      return;
    }
    setCommandVars({ commandName: cmd.name, template: cmd.command, placeholders, send });
  }, []);

  const runOnActive = useCallback((cmd: types.CommandTemplate) => {
    runCommandTemplate(cmd, (command) => {
      if (sessions.active) {
        SendCommandToTerminal(sessions.active.id, command);
        setTimeout(() => focusTerminal(sessions.activeTab), 10);
      }
    });
  }, [runCommandTemplate, sessions.active, sessions.activeTab, focusTerminal]);

  const runOnAll = useCallback((cmd: types.CommandTemplate) => {
    runCommandTemplate(cmd, (command) => { SendCommandToAll(command).catch(() => {}); });
  }, [runCommandTemplate]);

  const handleNewConnection = useCallback(() => setProfileModal(emptyProfile()), []);
  const handleToggleSidebar = useCallback(() => setSidebarCollapsed(v => !v), []);
  // From SFTP: jump the session terminal into the browsed directory and focus it.
  const handleOpenTerminalInDir = useCallback((sessionId: string, dirPath: string) => {
    const cmd = dirPath && dirPath !== "."
      ? `cd ${shellQuote(dirPath)}\n`
      : "pwd\n";
    SendCommandToTerminal(sessionId, cmd).catch((err) => notify(String(err), "error"));
    sessions.setActiveTab(sessionId);
    setTimeout(() => focusTerminal(sessionId), 30);
  }, [focusTerminal, notify, sessions.setActiveTab]);
  // Stable identities so a monitor:update tick (which updates metrics state and
  // re-renders App) does not break the memo(TerminalArea) boundary and re-render
  // the whole terminal/markdown subtree every few seconds.
  const handleCloseLogViewer = useCallback(() => setLogViewer(null), []);
  const handleToggleBroadcast = useCallback(() => setBroadcastInput((v) => !v), []);
  const activeKiRequest = kiRequests[0] || null;
  const answerKiRequest = useCallback((request: KiRequest, answers: string[], cancelled: boolean) => {
    setKiRequests((prev) => prev.filter((item) => item.requestId !== request.requestId));
    AnswerKeyboardInteractive(request.requestId, answers, cancelled).catch(() => {});
  }, []);

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
          onPickTextFile={handleOpenMarkdown}
          onOpenRecentMarkdown={handleOpenRecentMarkdown}
          onRemoveRecentMarkdown={handleRemoveRecentMarkdown}
          onNewProfile={() => setProfileModal(emptyProfile())}
          onEditProfile={(profile) => setProfileModal(new types.Profile(profile))}
          onConnectProfile={sessions.connectProfile}
          onDeleteProfile={async (id) => { await profileState.deleteProfile(id); }}
          onOpenSearch={() => setGlobalSearchOpen(true)}
          onStartMonitor={() => sessions.active && StartMonitor(sessions.active.id)}
          onRefreshSftp={sftp.refreshSftp}
          onOpenTerminalInDir={handleOpenTerminalInDir}
          onNotify={notify}
          onRunCommand={runOnActive}
          onRunCommandAll={runOnAll}
          onEditCommand={(cmd) => setCommandModal(cmd)}
          onDeleteCommand={async (id) => { await DeleteCommand(id); profileState.setCommands(await ListCommands()); }}
          onNewCommand={() => setCommandModal(new types.CommandTemplate({ id: "", name: "", command: "", category: "Custom", description: "", tags: [] }))}
          onSaveSettings={async (next) => { await profileState.saveSettings(next); notify(t(profileState.settings?.language || "en", "settingsSaved"), "success"); }}
          onOpenData={OpenDataDir}
          onOpenLog={async (name) => {
            try {
              const content = await ReadLogFile(name);
              setLogViewer({ name, content });
            } catch { notify(t(profileState.settings?.language || "en", "logReadFailed"), "error"); }
          }}
          getTerminalLines={activeTerminal.getTerminalLines}
          activeTabId={sessions.activeTab}
          automationByProfile={automationByProfile}
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
          onReorder={sessions.reorderTabs}
          onOpenMarkdown={handleOpenMarkdown}
          onOpenMarkdownFile={openMarkdownTarget}
          onNotify={notify}
          onTearOff={handleTearOff}
          language={profileState.settings?.language || "en"}
          logViewer={logViewer}
          onCloseLogViewer={handleCloseLogViewer}
          floatingTabIds={floatingTabIds}
          splitPane={splitPane}
          onSplitChange={setSplitPane}
          refitTerminal={refitTerminal}
          broadcastInput={broadcastInput}
          broadcastCount={connectedSshCount}
          onToggleBroadcast={() => setBroadcastInput((v) => !v)}
          activeRecording={activeRecording}
          onToggleRecording={toggleRecording}
          automationActivity={automationActivity}
        />
      </main>
      {floatingTabIds.map((id) => {
        const tab = sessions.tabs.find((t) => t.id === id);
        if (!tab) return null;
        return <FloatingTerminal key={id} tab={tab} terminalHosts={activeTerminal.terminalHosts} onDock={handleDockFloating} onClose={handleCloseFloating} refitTerminal={refitTerminal} reattachTerminal={reattachTerminal} />;
      })}
      {globalSearchOpen && <GlobalSearchModal query={globalQuery} onQuery={setGlobalQuery} results={globalResults} onClose={() => setGlobalSearchOpen(false)} locale={profileState.settings?.language || "en"} />}
      {terminalSearchOpen && <TerminalSearchModal query={terminalSearch} onQuery={setTerminalSearch} onNext={() => findNext(sessions.activeTab, terminalSearch)} onPrev={() => findPrev(sessions.activeTab, terminalSearch)} onClose={() => setTerminalSearchOpen(false)} locale={profileState.settings?.language || "en"} />}
      {profileModal && <ProfileModal profile={profileModal} profiles={profileState.profiles} language={profileState.settings?.language || "en"} onClose={() => setProfileModal(null)} onSave={saveProfile} onPickKey={SelectPrivateKey} onDelete={async (id) => { await profileState.deleteProfile(id); setProfileModal(null); }} onDuplicate={async (id) => { await profileState.duplicateProfile(id); notify(t(profileState.settings?.language || "en", "profileCopied"), "info"); }} />}
      {commandModal && <CommandModal command={commandModal} language={profileState.settings?.language || "en"} onClose={() => setCommandModal(null)} onSave={saveCommand} />}
      {commandVars && <CommandVarsDialog commandName={commandVars.commandName} template={commandVars.template} placeholders={commandVars.placeholders} locale={profileState.settings?.language || "en"} onClose={() => setCommandVars(null)} onSubmit={(resolved) => { const send = commandVars.send; setCommandVars(null); send(resolved); }} />}
      {sessions.secretRequest && <SecretModal request={sessions.secretRequest} language={profileState.settings?.language || "en"} onClose={() => sessions.setSecretRequest(null)} onSubmit={async (password, passphrase) => { const request = sessions.secretRequest; sessions.setSecretRequest(null); if (request) await sessions.submitSecret(request, password, passphrase); }} />}
      {activeKiRequest && <KeyboardInteractiveDialog key={activeKiRequest.requestId} request={activeKiRequest} language={profileState.settings?.language || "en"} onSubmit={(answers) => answerKiRequest(activeKiRequest, answers, false)} onCancel={() => answerKiRequest(activeKiRequest, [], true)} />}
      <ProgressBar />
      <ToastStack toasts={toasts} />
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          {ctxMenu.items.map((item, i) => (
            <button key={i} className={clsx(item.danger && "danger")} onClick={() => { item.action(); setCtxMenu(null); }}>
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
