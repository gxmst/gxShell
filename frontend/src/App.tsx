import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { types } from "../wailsjs/go/models";
import { AnswerKeyboardInteractive, CreateCommand, DeleteCommand, ExportProfiles, GetStartupFile, ImportOpenSSHConfig, ImportProfiles, IsRecording, ListCommands, OpenDataDir, ReadLogFile, RevokeCliTrust, SelectPrivateKey, SendCommandToAll, SendCommandToTerminal, StartMonitor, StartRecording, StopRecording, UpdateCommand } from "../wailsjs/go/main/App";
import { emptyProfile } from "./constants";
import type { AutomationActivityEvent, AutomationActivityRecord, AutomationIndicator, Drawer, SplitPane, Tab } from "./types";
import { normalizeAppTheme } from "./utils/format";
import { useToasts } from "./hooks/useToasts";
import { useProfiles } from "./hooks/useProfiles";
import { useTerminal, type AppContextMenu } from "./hooks/useTerminal";
import { useSessions } from "./hooks/useSessions";
import { useSftp } from "./hooks/useSftp";
import { useHotkeys } from "./hooks/useHotkeys";
import { useMarkdownTabs } from "./hooks/useMarkdownTabs";
import { usePersistedState } from "./hooks/usePersistedState";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TerminalArea } from "./components/TerminalArea/TerminalArea";
import { FloatingTerminal } from "./components/FloatingTerminal/FloatingTerminal";
import { ProfileModal } from "./components/modals/ProfileModal";
import { CommandModal } from "./components/modals/CommandModal";
import { CommandVarsDialog } from "./components/modals/CommandVarsDialog";
import { extractPlaceholders } from "./utils/commandVars";
import { SecretModal } from "./components/modals/SecretModal";
import { QuickConnectModal } from "./components/modals/QuickConnectModal";
import { UnsavedChangesDialog } from "./components/modals/UnsavedChangesDialog";
import { KeyboardInteractiveDialog, type KiRequest } from "./components/modals/KeyboardInteractiveDialog";
import { GlobalSearchModal, TerminalSearchModal } from "./components/modals/SearchModals";
import { UpdateDialog } from "./components/modals/UpdateDialog";
import { ConfirmDialog } from "./components/modals/ConfirmDialog";
import { ProgressBar } from "./components/ProgressBar/ProgressBar";
import { ToastStack } from "./components/ToastStack";
import { TransfersProvider } from "./hooks/useTransfers";
import { BrowserOpenURL, EventsOn, OnFileDrop, OnFileDropOff } from "../wailsjs/runtime/runtime";
import { isSupportedDocumentPath } from "./utils/textFiles";
import { shellQuote } from "./utils/shellQuote";
import { t } from "./i18n";
import { formatAutomationTerminalEvent } from "./utils/automation";

function App() {
  const { toasts, notify } = useToasts();
  const profileState = useProfiles(notify);
  const updateCheck = useUpdateCheck();
  const [drawer, setDrawer] = usePersistedState<Drawer>("gx:drawer", "monitor");
  // Preferences only take effect on save, and leaving the drawer unmounts the
  // panel along with its draft. Everything that navigates the drawer goes
  // through requestDrawer below so the edits get a chance to be kept.
  const settingsDirtyRef = useRef<{ dirty: boolean; save: () => Promise<boolean> }>({ dirty: false, save: async () => true });
  const [settingsPrompt, setSettingsPrompt] = useState<{ next: Drawer } | null>(null);
  const handleSettingsDirtyChange = useCallback((dirty: boolean, save: () => Promise<boolean>) => {
    settingsDirtyRef.current = { dirty, save };
  }, []);
  const requestDrawer = useCallback((next: Drawer) => {
    if (next !== "settings" && settingsDirtyRef.current.dirty) {
      setSettingsPrompt({ next });
      return;
    }
    setDrawer(next);
  }, [setDrawer]);
  const [profileModal, setProfileModal] = useState<types.Profile | null>(null);
  const [revokingCliTrustID, setRevokingCliTrustID] = useState("");
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [commandModal, setCommandModal] = useState<types.CommandTemplate | null>(null);
  const [deleteProfileRequest, setDeleteProfileRequest] = useState<{ id: string; name: string; closeEditor: boolean } | null>(null);
  const [deleteCommandRequest, setDeleteCommandRequest] = useState<{ id: string; name: string } | null>(null);
  const [commandVars, setCommandVars] = useState<{ commandName: string; template: string; placeholders: string[]; send: (command: string) => void } | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearch, setTerminalSearch] = useState("");
  const [terminalSearchResult, setTerminalSearchResult] = useState<{ id: string; index: number; count: number } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState("gx:sidebarCollapsed", false);
  const [logViewer, setLogViewer] = useState<{ name: string; content: string } | null>(null);
  const [floatingTabIds, setFloatingTabIds] = usePersistedState<string[]>("gx:floatingTabIds", []);
  const [splitPane, setSplitPane] = useState<SplitPane | null>(null);
  const [ctxMenu, setCtxMenu] = useState<AppContextMenu | null>(null);
  const [broadcastInput, setBroadcastInput] = useState(false);
  // Session ids currently recording. Backend owns the real state; this mirror
  // drives the TabBar toggle. Cleared for a session when it stops or closes.
  const [recordingIds, setRecordingIds] = useState<string[]>([]);
  const recordingCheckedRef = useRef<Set<string>>(new Set());
  const [kiRequests, setKiRequests] = useState<KiRequest[]>([]);
  const [automationActivity, setAutomationActivity] = useState<Record<string, AutomationIndicator>>({});
  const [activityHistory, setActivityHistory] = useState<AutomationActivityRecord[]>([]);
  const automationRunningRef = useRef<Record<string, Map<string, AutomationIndicator["source"]>>>({});
  const automationClearTimers = useRef<Record<string, number>>({});
  const dirtyDocumentsRef = useRef<Record<string, { save: () => Promise<boolean> }>>({});
  const [dirtyTabIds, setDirtyTabIds] = useState<string[]>([]);
  const [unsavedPrompt, setUnsavedPrompt] = useState<{ tab: Tab; resolve: (close: boolean) => void } | null>(null);
  const [disconnectPrompt, setDisconnectPrompt] = useState<{ tab: Tab; resolve: (close: boolean) => void } | null>(null);

  const beforeCloseTab = useCallback((tab: Tab): boolean | Promise<boolean> => {
    if (dirtyDocumentsRef.current[tab.id]) {
      return new Promise<boolean>((resolve) => {
        setUnsavedPrompt({ tab, resolve });
      });
    }
    if (profileState.settings?.confirmOnDisconnect && tab.state === "connected" && !tab.local && tab.type !== "markdown") {
      return new Promise<boolean>((resolve) => {
        setDisconnectPrompt({ tab, resolve });
      });
    }
    return true;
  }, [profileState.settings?.confirmOnDisconnect]);

  const handleMarkdownDirtyChange = useCallback((id: string, dirty: boolean, save: () => Promise<boolean>) => {
    if (dirty) dirtyDocumentsRef.current[id] = { save };
    else delete dirtyDocumentsRef.current[id];
    setDirtyTabIds((prev) => {
      const has = prev.includes(id);
      if (dirty && !has) return [...prev, id];
      if (!dirty && has) return prev.filter((item) => item !== id);
      return prev;
    });
  }, []);

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
    restoreWorkspace: profileState.settings?.restoreWorkspace,
    language: profileState.settings?.language,
    beforeCloseTab,
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
  const broadcastTargetIds = useMemo(
    () => connectedSshTabs.filter((tab) => !floatingTabIds.includes(tab.id)).map((tab) => tab.id),
    [connectedSshTabs, floatingTabIds],
  );
  const connectedSshCount = broadcastTargetIds.length;
  broadcastRef.current = {
    enabled: broadcastInput,
    targets: broadcastTargetIds,
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

  useEffect(() => {
    for (const tab of sessions.tabs) {
      if (tab.local || tab.type === "markdown" || tab.state !== "connected" || recordingCheckedRef.current.has(tab.id)) continue;
      recordingCheckedRef.current.add(tab.id);
      IsRecording(tab.id).then((recording) => {
        if (recording) setRecordingIds((prev) => prev.includes(tab.id) ? prev : [...prev, tab.id]);
      }).catch(() => undefined);
    }
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
      requestDrawer("sftp");
      sftp.refreshSftp(dir, sessionId);
    },
  };

  const activeIsTerminal = !!sessions.active && sessions.active.type !== "markdown";
  const handleTerminalSearchResults = useCallback((id: string, index: number, count: number) => {
    setTerminalSearchResult({ id, index, count });
  }, []);
  const activeTerminal = useTerminal(sessions.activeTab, activeIsTerminal, profileState.settings, notify, sidebarCollapsed, splitPane, broadcastRef, linkHandlersRef, setCtxMenu, handleTerminalSearchResults);
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
    setDrawer: requestDrawer,
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
      if (isSupportedDocumentPath(filePath)) {
        openMarkdownFile(filePath);
      }
    });

    // Explorer's context-menu/Open With path is distinct from drag-and-drop.
    // Document-focused launches start with the sidebar tucked away, while an
    // in-app open or a dropped document preserves the user's current layout.
    const openExternalDocument = (filePath: string) => {
      if (!isSupportedDocumentPath(filePath)) return;
      setSidebarCollapsed(true);
      openMarkdownFile(filePath);
    };
    const unsubExternalFileOpen = EventsOn("file:open-external", openExternalDocument);

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
      if (filePath) openExternalDocument(filePath);
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
      if (unsubExternalFileOpen) unsubExternalFileOpen();
      if (unsubRecordingError) unsubRecordingError();
      if (unsubCliServerError) unsubCliServerError();
      if (unsubTrayNewConnection) unsubTrayNewConnection();
      if (unsubTrayOpenMarkdown) unsubTrayOpenMarkdown();
      if (unsubTraySettings) unsubTraySettings();
      if (unsubKi) unsubKi();
      if (unsubKiClosed) unsubKiClosed();
      OnFileDropOff();
    };
  }, [openMarkdownFile, handleOpenMarkdown, setDrawer, setSidebarCollapsed, notify]);

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
      const title = tabsRef.current.find((tab) => tab.id === payload.sessionId)?.title;
      setActivityHistory((previous) => [{
        ...payload,
        command: payload.command?.slice(0, 400),
        output: undefined,
        error: payload.error?.slice(0, 400),
        timestamp: Date.now(),
        title,
      }, ...previous].slice(0, 60));

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

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.keys(dirtyDocumentsRef.current).length === 0 && !settingsDirtyRef.current.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Keyboard tab navigation walks the tab strip, so it has to see the same order
  // and the same membership the strip shows: torn-off terminals live in their own
  // windows and are not in it.
  const activateTabByOffset = useCallback((offset: number) => {
    const visible = sessions.tabs.filter((tab) => !floatingTabIds.includes(tab.id));
    if (visible.length < 2) return;
    const current = visible.findIndex((tab) => tab.id === sessions.activeTab);
    // Wrap around; from an unknown/floating active tab, step in from the edge.
    const next = current === -1
      ? (offset > 0 ? 0 : visible.length - 1)
      : (current + offset + visible.length) % visible.length;
    const target = visible[next];
    sessions.setActiveTab(target.id);
    if (target.type !== "markdown") setTimeout(() => focusTerminal(target.id), 10);
  }, [sessions.tabs, sessions.activeTab, sessions.setActiveTab, floatingTabIds, focusTerminal]);

  const activateTabByIndex = useCallback((index: number) => {
    const visible = sessions.tabs.filter((tab) => !floatingTabIds.includes(tab.id));
    const target = visible[index];
    if (!target) return;
    sessions.setActiveTab(target.id);
    if (target.type !== "markdown") setTimeout(() => focusTerminal(target.id), 10);
  }, [sessions.tabs, sessions.setActiveTab, floatingTabIds, focusTerminal]);

  useHotkeys({
    activeTab: sessions.activeTab,
    activeIsMarkdown: sessions.active?.type === "markdown",
    onGlobalSearch: () => { setGlobalQuery(""); setGlobalSearchOpen(true); },
    onTerminalSearch: () => setTerminalSearchOpen(true),
    onCloseTab: sessions.closeTab,
    onNextTab: () => activateTabByOffset(1),
    onPrevTab: () => activateTabByOffset(-1),
    onSelectTab: activateTabByIndex,
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

  const profileStates = useMemo(() => {
    const states: Record<string, { state: string; count: number; error?: string }> = {};
    const priority: Record<string, number> = { disconnected: 1, error: 2, connecting: 3, connected: 4 };
    for (const tab of sessions.tabs) {
      if (!tab.profileId || tab.local || tab.type === "markdown") continue;
      const current = states[tab.profileId];
      const count = (current?.count || 0) + 1;
      if (!current || (priority[tab.state] || 0) > (priority[current.state] || 0)) {
        states[tab.profileId] = { state: tab.state, count, error: tab.error };
      } else {
        states[tab.profileId] = { ...current, count, error: current.error || tab.error };
      }
    }
    return states;
  }, [sessions.tabs]);

  const saveProfile = async (profile: types.Profile) => {
    try {
      await profileState.saveProfile(profile);
      setProfileModal(null);
      notify(t(profileState.settings?.language || "en", "profileSaved"), "success");
    } catch (err) {
      notify(String(err), "error");
      throw err;
    }
  };

  const importProfiles = useCallback(async (openSSH = false) => {
    try {
      const result = openSSH ? await ImportOpenSSHConfig() : await ImportProfiles();
      if (!result || result.cancelled) return;
      await profileState.reload();
      notify(t(profileState.settings?.language || "en", "profilesImported", {
        added: String(result.added || 0),
        updated: String(result.updated || 0),
        skipped: String(result.skipped || 0),
      }), "success");
    } catch (err) {
      notify(String(err), "error");
    }
  }, [notify, profileState.reload, profileState.settings?.language]);

  const exportProfiles = useCallback(async () => {
    try {
      const filePath = await ExportProfiles(false);
      if (filePath) notify(t(profileState.settings?.language || "en", "profilesExported", { path: filePath }), "success");
    } catch (err) {
      notify(String(err), "error");
    }
  }, [notify, profileState.settings?.language]);

  const saveCommand = async (command: types.CommandTemplate) => {
    try {
      if (command.id) await UpdateCommand(command);
      else await CreateCommand(command);
      setCommandModal(null);
      profileState.setCommands(await ListCommands());
    } catch (err) {
      notify(String(err), "error");
      throw err;
    }
  };

  const profilesRef = useRef(profileState.profiles);
  profilesRef.current = profileState.profiles;
  const commandsRef = useRef(profileState.commands);
  commandsRef.current = profileState.commands;

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
    runCommandTemplate(cmd, async (command) => {
      const target = sessions.active;
      if (!target || target.type === "markdown" || target.state !== "connected") {
        notify(profileState.settings?.language === "zh-CN" ? "请先选择一个已连接的终端" : "Select a connected terminal first", "error");
        return;
      }
      try {
        await SendCommandToTerminal(target.id, command);
        notify(`${cmd.name} → ${target.title}`, "success");
        setTimeout(() => focusTerminal(target.id), 10);
      } catch (err) {
        notify(String(err), "error");
      }
    });
  }, [runCommandTemplate, sessions.active, focusTerminal, notify, profileState.settings?.language]);

  const runInSession = useCallback((cmd: types.CommandTemplate, sessionId: string) => {
    runCommandTemplate(cmd, async (command) => {
      const target = sessions.tabs.find((tab) => tab.id === sessionId);
      if (!target || target.type === "markdown" || target.state !== "connected") {
        notify(profileState.settings?.language === "zh-CN" ? "目标会话已断开" : "The target session is disconnected", "error");
        return;
      }
      try {
        await SendCommandToTerminal(sessionId, command);
        notify(`${cmd.name} → ${target.title}`, "success");
        sessions.setActiveTab(sessionId);
        setTimeout(() => focusTerminal(sessionId), 10);
      } catch (err) {
        notify(String(err), "error");
      }
    });
  }, [focusTerminal, notify, profileState.settings?.language, runCommandTemplate, sessions.setActiveTab, sessions.tabs]);

  const runOnAll = useCallback((cmd: types.CommandTemplate) => {
    runCommandTemplate(cmd, async (command) => {
      try {
        await SendCommandToAll(command);
        notify(profileState.settings?.language === "zh-CN" ? `已发送到 ${connectedSshCount} 个在线会话` : `Sent to ${connectedSshCount} online sessions`, "success");
      } catch (err) {
        notify(String(err), "error");
      }
    });
  }, [connectedSshCount, notify, profileState.settings?.language, runCommandTemplate]);

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
  // Stable identities so an App re-render does not break the memo(TerminalArea)
  // boundary and re-render the whole terminal/markdown subtree. (Metrics no
  // longer live in App state; monitor:update consumers subscribe individually
  // via useSessionMetrics.)
  const handleCloseLogViewer = useCallback(() => setLogViewer(null), []);
  const handleToggleBroadcast = useCallback(() => setBroadcastInput((v) => !v), []);
  const activeKiRequest = kiRequests[0] || null;
  const answerKiRequest = useCallback((request: KiRequest, answers: string[], cancelled: boolean) => {
    setKiRequests((prev) => prev.filter((item) => item.requestId !== request.requestId));
    AnswerKeyboardInteractive(request.requestId, answers, cancelled).catch(() => {});
  }, []);
  const searchConnectLocal = sessions.connectLocal;
  const searchConnectProfile = sessions.connectProfile;
  const searchSetActiveTab = sessions.setActiveTab;
  const searchTabs = sessions.tabs;

  const globalResults = useMemo(() => {
    const q = globalQuery.trim().toLowerCase();
    const lang = profileState.settings?.language || "en";
    const zh = lang === "zh-CN";
    const includesQuery = (...values: Array<string | undefined>) => !q || values.some((value) => (value || "").toLowerCase().includes(q));
    const actionResults = [
      { type: "action", title: t(lang, "newConnection"), subtitle: zh ? "创建并保存 SSH 连接" : "Create and save an SSH connection", keywords: "new connection server ssh 新建 连接 服务器", action: () => setProfileModal(emptyProfile()) },
      { type: "action", title: t(lang, "quickConnect"), subtitle: t(lang, "quickConnectHint"), keywords: "quick connect temporary 快速 临时 连接", action: () => setQuickConnectOpen(true) },
      { type: "action", title: t(lang, "localTerminal"), subtitle: zh ? "打开本机命令行" : "Open a local shell", keywords: "local terminal shell 本地 终端", action: () => { searchConnectLocal().catch((err) => notify(String(err), "error")); } },
      { type: "action", title: t(lang, "openTextFile"), subtitle: zh ? "查看或编辑本地文本文件" : "View or edit a local text file", keywords: "open text markdown file 打开 文本 文件", action: handleOpenMarkdown },
    ].filter((item) => includesQuery(item.title, item.subtitle, item.keywords));

    const serverResults = profilesRef.current
      .filter((profile) => includesQuery(profile.name, profile.host, profile.username, profile.group, ...(profile.tags || [])))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || String(b.lastConnectedAt || "").localeCompare(String(a.lastConnectedAt || "")))
      .slice(0, q ? 6 : 4)
      .map((profile) => ({ type: "server", title: profile.name || profile.host, subtitle: `${profile.username}@${profile.host}`, action: () => searchConnectProfile(profile) }));

    const tabResults = searchTabs
      .filter((tab) => includesQuery(tab.title, tab.local ? "local terminal 本地终端" : "terminal session 终端 会话"))
      .slice(0, q ? 6 : 4)
      .map((tab) => ({ type: "terminal", title: tab.title, subtitle: zh ? "切换到已打开的标签" : "Switch to open tab", action: () => searchSetActiveTab(tab.id) }));

    const commandResults = q ? commandsRef.current
      .filter((cmd) => includesQuery(cmd.name, cmd.command, cmd.category, cmd.description, ...(cmd.tags || [])))
      .slice(0, 6)
      .map((cmd) => ({ type: "command", title: cmd.name, subtitle: cmd.command, action: () => runOnActive(cmd) })) : [];

    const drawerMeta: Array<{ drawer: Drawer; title: string; keywords: string }> = [
      { drawer: "monitor", title: t(lang, "monitor"), keywords: "monitor metrics cpu memory 监控 指标" },
      { drawer: "sftp", title: "SFTP", keywords: "files remote transfer 文件 远程 传输" },
      { drawer: "commands", title: t(lang, "cmd"), keywords: "commands templates 命令 模板" },
      { drawer: "tunnels", title: t(lang, "sshTunnels"), keywords: "tunnel forwarding socks 隧道 转发" },
      { drawer: "containers", title: t(lang, "containers"), keywords: "docker containers 容器" },
      { drawer: "services", title: t(lang, "services"), keywords: "systemd service 服务" },
      { drawer: "firewall", title: t(lang, "firewall"), keywords: "firewall ufw iptables 防火墙" },
      { drawer: "cron", title: t(lang, "cronJobs"), keywords: "cron schedule jobs 定时 任务" },
      { drawer: "websites", title: t(lang, "websites"), keywords: "website nginx web 站点 网站" },
      { drawer: "logs", title: t(lang, "logs"), keywords: "logs history activity 日志 历史" },
      { drawer: "recordings", title: t(lang, "recordings"), keywords: "recordings cast video 录制 回放" },
      { drawer: "ai", title: t(lang, "ai"), keywords: "ai assistant model 助手 模型" },
      { drawer: "settings", title: t(lang, "settings"), keywords: "settings preferences 设置 偏好" },
    ];
    const areaResults = q ? drawerMeta
      .filter((item) => includesQuery(item.title, item.drawer, item.keywords))
      .map((item) => ({ type: "area", title: item.title, subtitle: zh ? "打开工作区" : "Open workspace", action: () => requestDrawer(item.drawer) })) : [];

    return [...actionResults, ...tabResults, ...serverResults, ...commandResults, ...areaResults].slice(0, q ? 18 : 10);
  }, [globalQuery, handleOpenMarkdown, notify, profileState.settings?.language, requestDrawer, runOnActive, searchConnectLocal, searchConnectProfile, searchSetActiveTab, searchTabs]);

  return (
    <TransfersProvider>
    <div className="app-shell" onContextMenu={() => setCtxMenu(null)} data-theme={themeName} data-collapsed={sidebarCollapsed ? "true" : "false"} >
      <main className="workspace">
        <Sidebar
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          setCtxMenu={setCtxMenu}
          drawer={drawer}          setDrawer={requestDrawer}
          onSettingsDirtyChange={handleSettingsDirtyChange}
          profiles={profileState.profiles}
          commands={profileState.commands}
          settings={profileState.settings}
          appInfo={profileState.appInfo}
          active={sessions.active}
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
          onQuickConnect={() => setQuickConnectOpen(true)}
          onEditProfile={(profile) => setProfileModal(new types.Profile(profile))}
          onConnectProfile={sessions.connectProfile}
          onToggleFavorite={async (profile) => {
            try { await profileState.saveProfile(new types.Profile({ ...profile, favorite: !profile.favorite })); }
            catch (err) { notify(String(err), "error"); }
          }}
          revokingCliTrustID={revokingCliTrustID}
          onRevokeCliTrust={async (profileID) => {
            setRevokingCliTrustID(profileID);
            try {
              await RevokeCliTrust(profileID);
              await profileState.reload();
              notify(t(profileState.settings?.language || "en", "cliTrustRevoked"), "success");
            } catch (err) {
              notify(String(err), "error");
            } finally {
              setRevokingCliTrustID("");
            }
          }}
          onDeleteProfile={(id) => {
            const profile = profileState.profiles.find((item) => item.id === id);
            if (profile) setDeleteProfileRequest({ id, name: profile.name || profile.host, closeEditor: false });
          }}
          onImportProfiles={() => importProfiles(false)}
          onImportOpenSSH={() => importProfiles(true)}
          onExportProfiles={exportProfiles}
          onOpenSearch={() => setGlobalSearchOpen(true)}
          onStartMonitor={() => sessions.active && StartMonitor(sessions.active.id)}
          onRefreshSftp={sftp.refreshSftp}
          onOpenTerminalInDir={handleOpenTerminalInDir}
          onNotify={notify}
          onRunCommand={runOnActive}
          onRunCommandInSession={runInSession}
          onRunCommandAll={runOnAll}
          onEditCommand={(cmd) => setCommandModal(cmd)}
          onDeleteCommand={(id) => {
            const command = profileState.commands.find((item) => item.id === id);
            if (command) setDeleteCommandRequest({ id, name: command.name });
          }}
          onNewCommand={() => setCommandModal(new types.CommandTemplate({ id: "", name: "", command: "", category: "Custom", description: "", tags: [] }))}
          onSaveSettings={async (next) => {
            // Failures propagate: SettingsPanel awaits this to decide whether
            // the unsaved-changes prompt may close, and it owns the error toast.
            await profileState.saveSettings(next);
            notify(t(profileState.settings?.language || "en", "settingsSaved"), "success");
          }}
          onOpenData={OpenDataDir}
          onOpenLog={async (name) => {
            try {
              const content = await ReadLogFile(name);
              setLogViewer({ name, content });
            } catch { notify(t(profileState.settings?.language || "en", "logReadFailed"), "error"); }
          }}
          getTerminalLines={activeTerminal.getTerminalLines}
          activeTabId={sessions.activeTab}
          tabs={sessions.tabs}
          profileStates={profileStates}
          activityHistory={activityHistory}
          automationByProfile={automationByProfile}
        />
        <TerminalArea
          tabs={sessions.tabs}
          activeTab={sessions.activeTab}
          profiles={profileState.profiles}
          terminalHosts={activeTerminal.terminalHosts}
          getDimensions={activeTerminal.getDimensions}
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
          onToggleBroadcast={handleToggleBroadcast}
          activeRecording={activeRecording}
          onToggleRecording={toggleRecording}
          automationActivity={automationActivity}
          dirtyTabIds={dirtyTabIds}
          onMarkdownDirtyChange={handleMarkdownDirtyChange}
        />
      </main>
      {floatingTabIds.map((id) => {
        const tab = sessions.tabs.find((t) => t.id === id);
        if (!tab) return null;
        return <FloatingTerminal key={id} tab={tab} terminalHosts={activeTerminal.terminalHosts} onDock={handleDockFloating} onClose={handleCloseFloating} refitTerminal={refitTerminal} reattachTerminal={reattachTerminal} />;
      })}
      {globalSearchOpen && <GlobalSearchModal query={globalQuery} onQuery={setGlobalQuery} results={globalResults} onClose={() => setGlobalSearchOpen(false)} locale={profileState.settings?.language || "en"} />}
      {terminalSearchOpen && <TerminalSearchModal
        query={terminalSearch}
        onQuery={(value) => {
          setTerminalSearch(value);
          if (value) findNext(sessions.activeTab, value);
          else setTerminalSearchResult(null);
        }}
        onNext={() => findNext(sessions.activeTab, terminalSearch)}
        onPrev={() => findPrev(sessions.activeTab, terminalSearch)}
        onClose={() => { setTerminalSearchOpen(false); setTerminalSearchResult(null); }}
        matchIndex={terminalSearchResult?.id === sessions.activeTab ? terminalSearchResult.index : undefined}
        matchCount={terminalSearchResult?.id === sessions.activeTab ? terminalSearchResult.count : undefined}
        locale={profileState.settings?.language || "en"}
      />}
      {profileModal && <ProfileModal profile={profileModal} profiles={profileState.profiles} language={profileState.settings?.language || "en"} onClose={() => setProfileModal(null)} onSave={saveProfile} onPickKey={SelectPrivateKey} onDelete={(id) => setDeleteProfileRequest({ id, name: profileModal.name || profileModal.host, closeEditor: true })} onDuplicate={async (id) => { await profileState.duplicateProfile(id); notify(t(profileState.settings?.language || "en", "profileCopied"), "info"); }} />}
      {quickConnectOpen && <QuickConnectModal
        language={profileState.settings?.language || "en"}
        onClose={() => setQuickConnectOpen(false)}
        onPickKey={SelectPrivateKey}
        onSave={async (profile) => {
          const saved = await profileState.saveProfile(profile);
          notify(t(profileState.settings?.language || "en", "profileSaved"), "success");
          return saved;
        }}
        onConnect={async (profile) => {
          if (profile.id.startsWith("quick-")) await sessions.connectQuick(profile);
          else await sessions.connectProfileWithSecrets(profile, profile.password || "", profile.privateKeyPassphrase || "");
        }}
      />}
      {commandModal && <CommandModal command={commandModal} language={profileState.settings?.language || "en"} onClose={() => setCommandModal(null)} onSave={saveCommand} />}
      {deleteProfileRequest && <ConfirmDialog
        locale={profileState.settings?.language || "en"}
        title={profileState.settings?.language === "zh-CN" ? "删除服务器配置？" : "Delete server profile?"}
        body={profileState.settings?.language === "zh-CN"
          ? `“${deleteProfileRequest.name}”及其保存的凭据将被永久删除；引用它的跳板机设置也会被清除。`
          : `“${deleteProfileRequest.name}” and its saved credentials will be permanently deleted. ProxyJump references to it will also be cleared.`}
        confirmText={t(profileState.settings?.language || "en", "delete")}
        onClose={() => setDeleteProfileRequest(null)}
        onConfirm={async () => {
          await profileState.deleteProfile(deleteProfileRequest.id);
          if (deleteProfileRequest.closeEditor) setProfileModal(null);
          setDeleteProfileRequest(null);
          notify(profileState.settings?.language === "zh-CN" ? "服务器配置已删除" : "Server profile deleted", "success");
        }}
      />}
      {deleteCommandRequest && <ConfirmDialog
        locale={profileState.settings?.language || "en"}
        title={profileState.settings?.language === "zh-CN" ? "删除命令模板？" : "Delete command template?"}
        body={profileState.settings?.language === "zh-CN" ? `“${deleteCommandRequest.name}”将被永久删除。` : `“${deleteCommandRequest.name}” will be permanently deleted.`}
        confirmText={t(profileState.settings?.language || "en", "delete")}
        onClose={() => setDeleteCommandRequest(null)}
        onConfirm={async () => {
          await DeleteCommand(deleteCommandRequest.id);
          profileState.setCommands(await ListCommands());
          setDeleteCommandRequest(null);
          notify(profileState.settings?.language === "zh-CN" ? "命令模板已删除" : "Command template deleted", "success");
        }}
      />}
      {commandVars && <CommandVarsDialog commandName={commandVars.commandName} template={commandVars.template} placeholders={commandVars.placeholders} locale={profileState.settings?.language || "en"} onClose={() => setCommandVars(null)} onSubmit={(resolved) => { const send = commandVars.send; setCommandVars(null); send(resolved); }} />}
      {sessions.secretRequest && <SecretModal request={sessions.secretRequest} language={profileState.settings?.language || "en"} onClose={() => sessions.setSecretRequest(null)} onSubmit={async (password, passphrase) => { const request = sessions.secretRequest; if (!request) return; await sessions.submitSecret(request, password, passphrase); sessions.setSecretRequest(null); }} />}
      {activeKiRequest && <KeyboardInteractiveDialog key={activeKiRequest.requestId} request={activeKiRequest} language={profileState.settings?.language || "en"} onSubmit={(answers) => answerKiRequest(activeKiRequest, answers, false)} onCancel={() => answerKiRequest(activeKiRequest, [], true)} />}
      {settingsPrompt && <UnsavedChangesDialog
        title={t(profileState.settings?.language || "en", "unsavedSettingsTitle")}
        body={t(profileState.settings?.language || "en", "unsavedSettingsBody")}
        locale={profileState.settings?.language || "en"}
        onCancel={() => setSettingsPrompt(null)}
        onDiscard={() => {
          const next = settingsPrompt.next;
          settingsDirtyRef.current = { dirty: false, save: async () => true };
          setSettingsPrompt(null);
          setDrawer(next);
        }}
        onSave={async () => {
          const ok = await settingsDirtyRef.current.save();
          if (ok) {
            const next = settingsPrompt.next;
            settingsDirtyRef.current = { dirty: false, save: async () => true };
            setSettingsPrompt(null);
            setDrawer(next);
          }
          return ok;
        }}
      />}
      {unsavedPrompt && <UnsavedChangesDialog
        title={unsavedPrompt.tab.title}
        locale={profileState.settings?.language || "en"}
        onCancel={() => { unsavedPrompt.resolve(false); setUnsavedPrompt(null); }}
        onDiscard={() => { delete dirtyDocumentsRef.current[unsavedPrompt.tab.id]; setDirtyTabIds((prev) => prev.filter((id) => id !== unsavedPrompt.tab.id)); unsavedPrompt.resolve(true); setUnsavedPrompt(null); }}
        onSave={async () => {
          const handle = dirtyDocumentsRef.current[unsavedPrompt.tab.id];
          const ok = !!handle && await handle.save();
          if (ok) {
            delete dirtyDocumentsRef.current[unsavedPrompt.tab.id];
            setDirtyTabIds((prev) => prev.filter((id) => id !== unsavedPrompt.tab.id));
            unsavedPrompt.resolve(true);
            setUnsavedPrompt(null);
          }
          return ok;
        }}
      />}
      {disconnectPrompt && <ConfirmDialog
        locale={profileState.settings?.language || "en"}
        title={profileState.settings?.language === "zh-CN" ? "断开当前连接？" : "Disconnect this session?"}
        body={profileState.settings?.language === "zh-CN" ? `“${disconnectPrompt.tab.title}”仍处于连接状态。` : `“${disconnectPrompt.tab.title}” is still connected.`}
        confirmText={profileState.settings?.language === "zh-CN" ? "断开" : "Disconnect"}
        onClose={() => { disconnectPrompt.resolve(false); setDisconnectPrompt(null); }}
        onConfirm={() => { disconnectPrompt.resolve(true); setDisconnectPrompt(null); }}
      />}
      {updateCheck.promptOpen && updateCheck.result && <UpdateDialog
        result={updateCheck.result}
        locale={profileState.settings?.language || "en"}
        onSkip={updateCheck.skipVersion}
        onClose={updateCheck.dismissPrompt}
      />}
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
  );
}

export default App;
