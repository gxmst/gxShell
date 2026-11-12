import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { types } from "../wailsjs/go/models";
import { AnswerKeyboardInteractive, ApplyBackup, CloseWindow, CreateCommand, DeleteCommand, ExportProfiles, ImportOpenSSHConfig, ImportProfiles, IsRecording, ListCommands, OpenDataDir, ReadLogFile, RegisterApprovalPanel, ResolveCliApproval, RevokeCliTrust, SelectPrivateKey, SendCommandToTerminal, SetWindowBackgroundColour, StartMonitor, StartRecording, StopRecording, UpdateCommand } from "../wailsjs/go/app/App";
import { emptyProfile } from "./constants";
import type { AutomationActivityEvent, AutomationActivityRecord, AutomationIndicator, CliApprovalEvent, CliApprovalPanelRequest, Drawer, SplitDirection, SplitPane, Tab } from "./types";
import { normalizeAppTheme, parseRgbColor } from "./utils/format";
import { useToasts } from "./hooks/useToasts";
import { useProfiles } from "./hooks/useProfiles";
import { useTerminal, type AppContextMenu, type TerminalPasteRequest } from "./hooks/useTerminal";
import { useSessions } from "./hooks/useSessions";
import { useAppFileEvents } from "./hooks/useAppFileEvents";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useSftp } from "./hooks/useSftp";
import { useHotkeys } from "./hooks/useHotkeys";
import { useMarkdownTabs } from "./hooks/useMarkdownTabs";
import { useContextualSidebar } from "./hooks/useContextualSidebar";
import { usePersistedState } from "./hooks/usePersistedState";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useRenderedLinkGuard } from "./hooks/useRenderedLinkGuard";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { AppTopBar } from "./components/AppTopBar/AppTopBar";
import { TabBar } from "./components/TabBar/TabBar";
import { orderTabs } from "./components/TabBar/tabLayout";
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
import type { TransferHistoryItem } from "./hooks/useTransfers";
import { TransfersProvider } from "./hooks/TransfersProvider";
import { BrowserOpenURL, EventsOn } from "../wailsjs/runtime/runtime";
import { ReadSessionLogFile, UpdateProfilesBatch } from "../wailsjs/go/app/App";
import { BulkProfilesModal } from "./components/modals/BulkProfilesModal";
import { reconcileSplit, replaceSplitIds, splitPaneIds } from "./utils/splitPane";
import { useNamedWorkspaces } from "./hooks/useNamedWorkspaces";
import { WorkspacesModal } from "./components/modals/WorkspacesModal";
import { BackupModal } from "./components/modals/BackupModal";
import { PanelsTopLeft } from "lucide-react";
import type { DocumentOutline } from "./utils/documentPresentation";
import { shellQuote } from "./utils/shellQuote";
import { t, type LangKey } from "./i18n";
import { formatAutomationTerminalEvent } from "./utils/automation";
import { CliApprovalQueue } from "./components/CliApprovalQueue/CliApprovalQueue";
import { CliApprovalPanel } from "./components/CliApprovalPanel/CliApprovalPanel";
import { PasteConfirmDialog } from "./components/modals/PasteConfirmDialog";
import { sameTerminalPasteTargets, terminalPasteTargets } from "./utils/terminalPaste";
import { TextInputDialog } from "./components/modals/TextInputDialog";
import { ActivityCenter } from "./components/ActivityCenter/ActivityCenter";
import { isValidOsType, saveStoredServerOs, type ServerOsType } from "./utils/serverOs";
import { parsePaletteQuery } from "./utils/paletteSearch";
import { createDefaultActionRegistry, type ActionContext } from "./actions/actionRegistry";
import { PanelLeftOpen, Type as TypeIcon } from "lucide-react";
import { BatchCommandDialog, type BatchCommandRequest } from "./components/modals/BatchCommandDialog";
import { sendBatchCommand, type BatchCommandOptions } from "./utils/batchCommand";
import { ShortcutHelpDialog } from "./components/modals/ShortcutHelpDialog";

function App() {
  const {
    toasts,
    activities,
    unreadActivityCount,
    notify,
    recordActivity,
    dismissToast,
    markActivityRead,
    markAllActivitiesRead,
    removeActivity,
    clearActivities,
  } = useToasts();
  const profileState = useProfiles(notify);
  const { settings: profileSettings, reload: profileReload, saveSettings: profileSaveSettings } = profileState;
  // Confirm dialogs and notifications all follow the settings language. `lang`
  // and `tr` exist so those call sites read as a key plus its parameters instead
  // of repeating the `settings?.language === "zh-CN"` ternary inline.
  const lang = profileSettings?.language || "en";
  const tr = useCallback((key: LangKey, params?: Record<string, string>) => t(lang, key, params), [lang]);
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
  const [bulkProfilesOpen, setBulkProfilesOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [backupMode, setBackupMode] = useState<"export" | "import" | null>(null);
  const backupBusyRef = useRef(false);
  const handleBackupBusyChange = useCallback((busy: boolean) => { backupBusyRef.current = busy; }, []);
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
  // The session the search bar acts on. Ctrl+F from a focused floating terminal
  // must search that terminal, not whichever tab is active in the main area.
  const [terminalSearchTab, setTerminalSearchTab] = useState("");
  const [terminalSearchResult, setTerminalSearchResult] = useState<{ id: string; index: number; count: number } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState("gx:sidebarCollapsed", false);
  const [logViewer, setLogViewer] = useState<{ name: string; content: string } | null>(null);
  const [floatingTabIds, setFloatingTabIds] = usePersistedState<string[]>("gx:floatingTabIds", []);
  const [splitPane, setSplitPane] = useState<SplitPane | null>(null);
  const layoutTabsRef = useRef<Tab[]>([]);
  const [ctxMenu, setCtxMenu] = useState<AppContextMenu | null>(null);
  const [pasteRequest, setPasteRequest] = useState<TerminalPasteRequest | null>(null);
  const [batchCommandRequest, setBatchCommandRequest] = useState<BatchCommandRequest | null>(null);
  const [batchCommandProgress, setBatchCommandProgress] = useState({ running: false, sent: 0, total: 0 });
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const batchCommandAbort = useRef<AbortController | null>(null);
  const [renameTabRequest, setRenameTabRequest] = useState<Tab | null>(null);
  const [activityCenterOpen, setActivityCenterOpen] = useState(false);
  const [zenMode, setZenMode] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [fontSizeHud, setFontSizeHud] = useState<number | null>(null);
  const fontSizeHudTimer = useRef<number | null>(null);
  const [broadcastInput, setBroadcastInput] = useState(false);
  const [detectedOsMap, setDetectedOsMap] = useState<Record<string, ServerOsType>>({});
  const detectedOsRef = useRef<Map<string, ServerOsType>>(new Map());
  // Session ids currently recording. Backend owns the real state; this mirror
  // drives the TabBar toggle. Cleared for a session when it stops or closes.
  const [recordingIds, setRecordingIds] = useState<string[]>([]);
  const recordingCheckedRef = useRef<Set<string>>(new Set());
  const [automationActivity, setAutomationActivity] = useState<Record<string, AutomationIndicator>>({});
  const [activityHistory, setActivityHistory] = useState<AutomationActivityRecord[]>([]);
  const [cliApprovals, setCliApprovals] = useState<CliApprovalEvent[]>([]);
  // The interactive approval panel. The backend serialises panels, so exactly
  // one is ever pending — this is a single slot, not a queue.
  const [cliApprovalPanel, setCliApprovalPanel] = useState<CliApprovalPanelRequest | null>(null);
  const cliApprovalPanelRef = useRef<CliApprovalPanelRequest | null>(null);
  cliApprovalPanelRef.current = cliApprovalPanel;
  const automationRunningRef = useRef<Record<string, Map<string, AutomationIndicator["source"]>>>({});
  const automationClearTimers = useRef<Record<string, number>>({});
  const dirtyDocumentsRef = useRef<Record<string, { save: () => Promise<boolean> }>>({});
  const [dirtyTabIds, setDirtyTabIds] = useState<string[]>([]);
  const [documentOutline, setDocumentOutline] = useState<{ tabId: string; outline: DocumentOutline } | null>(null);
  const handleDocumentOutlineChange = useCallback((tabId: string, outline: DocumentOutline | null) => {
    setDocumentOutline((current) => outline ? { tabId, outline } : current?.tabId === tabId ? null : current);
  }, []);
  const [unsavedPrompt, setUnsavedPrompt] = useState<{ tab: Tab; resolve: (close: boolean) => void } | null>(null);
  const [disconnectPrompt, setDisconnectPrompt] = useState<{ tab: Tab; resolve: (close: boolean) => void } | null>(null);

  const beforeCloseTab = useCallback((tab: Tab): boolean | Promise<boolean> => {
    if (dirtyDocumentsRef.current[tab.id]) {
      return new Promise<boolean>((resolve) => {
        setUnsavedPrompt({ tab, resolve });
      });
    }
    if (profileSettings?.confirmOnDisconnect && tab.state === "connected" && !tab.local && tab.type !== "markdown") {
      return new Promise<boolean>((resolve) => {
        setDisconnectPrompt({ tab, resolve });
      });
    }
    return true;
  }, [profileSettings?.confirmOnDisconnect]);

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
    reload: profileReload,
    disposeTerminal: (id) => terminalBridge.current.disposeTerminal(id),
    restoreWorkspace: profileSettings?.restoreWorkspace,
    language: profileSettings?.language,
    beforeCloseTab,
  });
  const {
    tabs: sessionTabs,
    activeTab: sessionActiveTab,
    active: sessionActive,
    setActiveTab: sessionSetActiveTab,
    setTabs: sessionSetTabs,
    restoreActiveTab: sessionRestoreActiveTab,
    isCurrentRuntimeEvent: sessionIsCurrentRuntimeEvent,
    closeTab: sessionCloseTab,
    closedTabCount: sessionClosedTabCount,
    reopenClosedTab: sessionReopenClosedTab,
    connectLocal: sessionConnectLocal,
    connectProfile: sessionConnectProfile,
    closeTabs: sessionCloseTabs,
    closingTabs: sessionClosingTabs,
    reconnectTab: sessionReconnectTab,
    reorderTabs: sessionReorderTabs,
    beginFocusRequest: sessionBeginFocusRequest,
    connectQuick: sessionConnectQuick,
    connectProfileWithSecrets: sessionConnectProfileWithSecrets,
    secretRequest: sessionSecretRequest,
    cancelSecretRequest: sessionCancelSecretRequest,
    submitSecret: sessionSubmitSecret,
    setSecretRequest: sessionSetSecretRequest,
  } = sessions;
  const tabsRef = useRef(sessionTabs);
  tabsRef.current = sessionTabs;
  const activeTabIdRef = useRef(sessionActiveTab);
  activeTabIdRef.current = sessionActiveTab;
  const splitPaneRef = useRef(splitPane);
  splitPaneRef.current = splitPane;
  const floatingTabIdsRef = useRef(floatingTabIds);
  floatingTabIdsRef.current = floatingTabIds;
  // Whether any tab has ever been present, so persisted floating ids are not
  // pruned against the empty list the first render always sees.
  const hadTabsRef = useRef(false);
  const previousSessionStates = useRef<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const tab of sessionTabs) {
      if (tab.local || tab.type === "markdown") continue;
      const identity = tab.runtimeId || tab.profileId || tab.id;
      next[identity] = tab.state;
      const previous = previousSessionStates.current[identity];
      if (!previous || previous === tab.state) continue;
      const severity = tab.state === "connected" ? "success" : tab.state === "error" ? "error" : tab.state === "connecting" || tab.state === "reconnecting" ? "info" : "warning";
      const stateText: Record<string, string> = {
        connected: tr("connectionStateConnected"),
        connecting: tr("connectionStateConnecting"),
        reconnecting: tr("connectionStateReconnecting"),
        restoring: tr("connectionStateRestoring"),
        disconnected: tr("connectionStateDisconnected"),
        error: tr("connectionStateError"),
      };
      recordActivity({
        text: tab.error || stateText[tab.state] || tab.state,
        title: tab.title,
        tone: severity,
        category: "connection",
        scope: identity,
        scopeLabel: tab.title,
        dedupeKey: `connection-state:${identity}:${tab.state}`,
        toast: false,
      });
    }
    previousSessionStates.current = next;
  }, [tr, recordActivity, sessionTabs]);

  // Broadcast (synchronized input) target set, kept in a ref so the terminal's
  // onData closure always reads the current value without re-binding. Targets are
  // the connected, non-floating SSH terminals; local and markdown tabs are excluded.
  const broadcastRef = useRef<{ enabled: boolean; targets: string[] }>({ enabled: false, targets: [] });
  const connectedSshTabs = useMemo(
    () => sessionTabs.filter((tab) => tab.type !== "markdown" && !tab.local && tab.state === "connected"),
    [sessionTabs]
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
      sessionTabs.filter((tab) => tab.state === "connected").map((tab) => tab.id)
    );
    setRecordingIds((prev) => {
      const next = prev.filter((id) => connected.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [sessionTabs]);

  useEffect(() => {
    for (const tab of sessionTabs) {
      if (tab.local || tab.type === "markdown" || tab.state !== "connected" || recordingCheckedRef.current.has(tab.id)) continue;
      recordingCheckedRef.current.add(tab.id);
      IsRecording(tab.id).then((recording) => {
        if (recording) setRecordingIds((prev) => prev.includes(tab.id) ? prev : [...prev, tab.id]);
      }).catch(() => undefined);
    }
  }, [sessionTabs]);

  const toggleRecording = useCallback(async (sessionId: string) => {
    const tab = tabsRef.current.find((item) => item.id === sessionId);
    if (!tab || tab.local || tab.type === "markdown") return;
    const isRecording = recordingIds.includes(sessionId);
    try {
      if (isRecording) {
        const file = await StopRecording(sessionId);
        setRecordingIds((prev) => prev.filter((id) => id !== sessionId));
        notify(t(profileSettings?.language || "en", "recordingSaved", { name: file }), "success");
      } else {
        const title = tab.title || "session";
        await StartRecording(sessionId, title);
        setRecordingIds((prev) => prev.includes(sessionId) ? prev : [...prev, sessionId]);
        notify(t(profileSettings?.language || "en", "recordingStarted"), "info");
      }
    } catch (err) {
      notify(String(err), "error");
    }
  }, [recordingIds, notify, profileSettings?.language]);

  const activeRecording = !!sessionActiveTab && recordingIds.includes(sessionActiveTab);

  const sftp = useSftp(sessionActive, drawer, notify);
  const { refreshSftp: sftpRefreshSftp } = sftp;

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
      sessionSetActiveTab(sessionId);
      requestDrawer("sftp");
      sftpRefreshSftp(dir, sessionId);
    },
  };

  const activeIsTerminal = !!sessionActive && sessionActive.type !== "markdown";
  useContextualSidebar(sessionActive, drawer, requestDrawer);
  const handleTerminalSearchResults = useCallback((id: string, index: number, count: number) => {
    setTerminalSearchResult({ id, index, count });
  }, []);
  const terminalPreferences = useMemo(() => new Map(profileState.profiles.map((profile) => [profile.id, profile.terminal])), [profileState.profiles]);
  const terminalOverrides = useMemo(() => Object.fromEntries(sessionTabs.flatMap((tab) => {
    const terminal = terminalPreferences.get(tab.profileId);
    return terminal ? [[tab.id, terminal]] : [];
  })), [sessionTabs, terminalPreferences]);
  const activeTerminal = useTerminal(sessionActiveTab, activeIsTerminal, profileSettings, notify, splitPane, broadcastRef, linkHandlersRef, setCtxMenu, handleTerminalSearchResults, setPasteRequest, terminalOverrides);
  const { adjustFontSize: terminalAdjustFontSize, resetFontSize: terminalResetFontSize, getCurrentDirectory: terminalGetCurrentDirectory } = activeTerminal;
  const { writeOutput, disposeTerminal, findNext, findPrev, focusTerminal, refitTerminal, reattachTerminal } = activeTerminal;
  terminalBridge.current.disposeTerminal = disposeTerminal;
  const {
    effectiveSidebarWidth, sidebarResizing, beginSidebarResize, resetSidebarResize,
    adjustSidebarWidth, sidebarPanelMin, sidebarPanelMax,
  } = useSidebarResize({ settings: profileSettings, saveSettings: profileSaveSettings, tabsRef, refitTerminal });

  const {
    markdownSiblings,
    markdownSiblingsBusy,
    markdownSiblingsError,
    refreshMarkdownSiblings,
    recentMarkdown,
    openMarkdownFile,
    openRemoteMarkdownFile,
    openMarkdownTarget,
    handleOpenMarkdown,
    handleOpenRecentMarkdown,
    handleRemoveRecentMarkdown,
    handleOpenMarkdownSibling,
  } = useMarkdownTabs({
    tabs: sessionTabs,
    activeTab: sessionActiveTab,
    profiles: profileState.profiles,
    setTabs: sessionSetTabs,
    setActiveTab: sessionSetActiveTab,
    restoreActiveTab: sessionRestoreActiveTab,
    setDrawer: requestDrawer,
    notify,
    language: profileSettings?.language || "en",
  });

  // Language for toasts fired from long-lived event listeners; a ref avoids
  // resubscribing those listeners whenever the language setting changes.
  const langRef = useRef(profileSettings?.language || "en");
  langRef.current = profileSettings?.language || "en";

  const { kiRequests, setKiRequests } = useAppFileEvents({
    openMarkdownFile, handleOpenMarkdown, setDrawer, setProfileModal, notify,
    sessionIsCurrentRuntimeEvent, sessionTabs, language: lang,
  });

  const handleTearOff = useCallback((tab: Tab) => {
    setFloatingTabIds((prev) => prev.includes(tab.id) ? prev : [...prev, tab.id]);
    if (sessionActiveTab === tab.id) {
      const remaining = sessionTabs.filter((t) => t.id !== tab.id);
      if (remaining.length > 0) {
        sessionSetActiveTab(remaining[0].id);
      }
    }
    setTimeout(() => refitTerminal(tab.id), 50);
  }, [refitTerminal, sessionActiveTab, sessionTabs, sessionSetActiveTab, setFloatingTabIds]);

  const handleDockFloating = useCallback((id: string) => {
    setFloatingTabIds((prev) => prev.filter((fid) => fid !== id));
    sessionSetActiveTab(id);
    // reattachTerminal is called from FloatingTerminal's cleanup effect,
    // which includes a delayed refitTerminal, so no extra call is needed here.
  }, [sessionSetActiveTab, setFloatingTabIds]);

  // Closing a tab that is floating must also clear its floating flag, and only
  // when the close really happened: closeTab returns false when the disconnect
  // confirmation was cancelled, and undocking a still-live session back into the
  // main area is not what "cancel" means.
  const closeTabForgettingFloating = useCallback(async (id: string) => {
    if (!id) return;
    if (await sessionCloseTab(id)) setFloatingTabIds((prev) => prev.filter((fid) => fid !== id));
  }, [sessionCloseTab, setFloatingTabIds]);

  const handleCloseFloating = useCallback(async (id: string) => {
    await closeTabForgettingFloating(id);
  }, [closeTabForgettingFloating]);

  useEffect(() => {
    const tabIds = new Set(sessionTabs.map((t) => t.id));
    // The workspace restores asynchronously, so the first render sees an empty
    // tab list. Pruning the persisted floating ids against it erased them before
    // their tabs existed — which is why a floating layout never survived a
    // restart. Once any tab has existed, pruning means "the user closed it".
    if (tabIds.size === 0 && !hadTabsRef.current) return;
    hadTabsRef.current = true;
    setFloatingTabIds((prev) => { const next = prev.filter((id) => tabIds.has(id)); return next.length === prev.length ? prev : next; });
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
    const before = layoutTabsRef.current;
    layoutTabsRef.current = sessionTabs;
    setSplitPane((split) => reconcileSplit(split, before, sessionTabs, floatingTabIds));
  }, [sessionTabs, floatingTabIds, setFloatingTabIds]);

  useEffect(() => {
    const offData = EventsOn("terminal:data", (payload: { sessionId: string; data: string; runtimeId?: string; generation?: number }) => {
      if (!sessionIsCurrentRuntimeEvent(payload)) return;
      writeOutput(payload.sessionId, payload.data);
      const split = splitPaneRef.current;
      const visibleInWorkspace = payload.sessionId === activeTabIdRef.current
        || (splitPaneIds(split).includes(activeTabIdRef.current) && splitPaneIds(split).includes(payload.sessionId))
        || floatingTabIdsRef.current.includes(payload.sessionId);
      const userCanSeeOutput = document.visibilityState === "visible" && document.hasFocus() && visibleInWorkspace;
      if (!userCanSeeOutput) {
        sessionSetTabs((items) => {
          let changed = false;
          const next = items.map((tab) => {
            if (tab.id !== payload.sessionId || tab.unread) return tab;
            changed = true;
            return { ...tab, unread: true };
          });
          return changed ? next : items;
        });
      }
    });
    return () => offData();
  }, [sessionIsCurrentRuntimeEvent, sessionSetTabs, writeOutput]);

  useEffect(() => {
    // Only monitor probes identify the remote OS; terminal output is arbitrary.
    const offMonitor = EventsOn("monitor:update", (metrics: types.Metrics) => {
      if (!metrics?.sessionId || !isValidOsType(metrics.os)) return;
      const tab = tabsRef.current.find((t) => t.id === metrics.sessionId);
      if (tab?.profileId && detectedOsRef.current.get(tab.profileId) !== metrics.os) {
        const os = metrics.os;
        detectedOsRef.current.set(tab.profileId, os);
        saveStoredServerOs(tab.profileId, os);
        setDetectedOsMap((prev) => prev[tab.profileId!] === os ? prev : { ...prev, [tab.profileId!]: os });
      }
    });
    return () => offMonitor();
  }, []);

  const clearVisibleUnread = useCallback(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    const visible = new Set<string>();
    if (activeTabIdRef.current) visible.add(activeTabIdRef.current);
    const panes = splitPaneIds(splitPaneRef.current);
    if (panes.includes(activeTabIdRef.current)) panes.forEach((id) => visible.add(id));
    floatingTabIdsRef.current.forEach((id) => visible.add(id));
    sessionSetTabs((items) => {
      let changed = false;
      const next = items.map((tab) => {
        if (!tab.unread || !visible.has(tab.id)) return tab;
        changed = true;
        return { ...tab, unread: false };
      });
      return changed ? next : items;
    });
  }, [sessionSetTabs]);

  useEffect(() => {
    clearVisibleUnread();
  }, [clearVisibleUnread, floatingTabIds, sessionActiveTab, splitPane]);

  useEffect(() => {
    window.addEventListener("focus", clearVisibleUnread);
    document.addEventListener("visibilitychange", clearVisibleUnread);
    return () => {
      window.removeEventListener("focus", clearVisibleUnread);
      document.removeEventListener("visibilitychange", clearVisibleUnread);
    };
  }, [clearVisibleUnread]);

  useEffect(() => {
    const offAutomation = EventsOn("terminal:automation", (payload: AutomationActivityEvent) => {
      if (!payload?.sessionId || !payload.activityId) return;
      if (!sessionIsCurrentRuntimeEvent(payload)) return;
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

      if (payload.phase !== "started") {
        recordActivity({
          text: payload.phase === "failed"
            ? (payload.error || payload.command || payload.tool || payload.activityId)
            : (payload.command || payload.tool || payload.activityId),
          title: title || (payload.source === "ai" ? "AI" : "CLI"),
          tone: payload.phase === "failed" ? "error" : "success",
          category: "automation",
          scope: payload.sessionId,
          scopeLabel: title,
          detail: payload.phase === "failed" ? payload.error?.slice(0, 800) : undefined,
          dedupeKey: `automation:${payload.activityId}:${payload.phase}`,
          toast: false,
        });
      }

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
  }, [recordActivity, sessionIsCurrentRuntimeEvent, writeOutput]);

  useEffect(() => {
    const offApproval = EventsOn("cli:approval", (payload: CliApprovalEvent) => {
      if (!payload?.id) return;
      setCliApprovals((previous) => {
        if (payload.phase !== "pending") return previous.filter((item) => item.id !== payload.id);
        const next = previous.filter((item) => item.id !== payload.id);
        return [...next, payload].slice(-8);
      });
    });
    return () => offApproval();
  }, []);

  // The interactive approval panel. RegisterApprovalPanel tells the backend the
  // listener below is attached: until it is, approvals fall back to the native
  // dialog, so an event emitted during startup can never leave a request
  // waiting on a panel nobody rendered.
  useEffect(() => {
    void RegisterApprovalPanel();
    const offPanel = EventsOn("cli:approval-panel", (payload: CliApprovalPanelRequest) => {
      if (!payload?.id || !payload.items?.length) return;
      setCliApprovalPanel(payload);
    });
    const offPanelClosed = EventsOn("cli:approval-panel:closed", (payload: { id?: string }) => {
      setCliApprovalPanel((current) => (current && current.id === payload?.id ? null : current));
    });
    return () => { offPanel(); offPanelClosed(); };
  }, []);

  // Rendered HTML — the Markdown preview, the AI assistant's replies, tool
  // output — can carry links, and the window is frameless, so following one
  // would replace the app with no way back. The document viewer routes its own
  // (it resolves relative paths against the file it is showing); this is the net
  // for everything else, including surfaces that have no handler of their own.
  const handleBlockedRenderedLink = useCallback(() => {
    notify(t(langRef.current, "linkBlocked"), "info");
  }, [notify]);
  useRenderedLinkGuard(handleBlockedRenderedLink);

  const handleCliApprovalResolve = useCallback((approvedIds: string[]) => {
    const current = cliApprovalPanelRef.current;
    setCliApprovalPanel(null);
    if (current) void ResolveCliApproval(current.id, approvedIds);
  }, []);

  useEffect(() => () => {
    Object.values(automationClearTimers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  // The close gate. Wails routes every close path — the top-bar button,
  // Alt+F4, the taskbar — through app:close-requested, because a DOM
  // beforeunload cannot reliably intercept a native quit; the confirmed path
  // finishes with CloseWindow, which quits without re-entering the gate. The
  // Both modal editors report their actual dirty state; merely opening an
  // editor is not unsaved work, while a command-template draft is protected in
  // the same way as a profile draft.
  const [quitConfirmOpen, setQuitConfirmOpen] = useState(false);
  const quitConfirmOpenRef = useRef(false);
  const profileDirtyRef = useRef(false);
  const commandDirtyRef = useRef(false);
  const handleProfileDirtyChange = useCallback((dirty: boolean) => { profileDirtyRef.current = dirty; }, []);
  const handleCommandDirtyChange = useCallback((dirty: boolean) => { commandDirtyRef.current = dirty; }, []);
  useEffect(() => {
    const offCloseRequest = EventsOn("app:close-requested", () => {
      if (backupBusyRef.current) {
        notify(tr("waitForBackupBeforeClose"), "info");
        return;
      }
      const hasUnsavedWork =
        Object.keys(dirtyDocumentsRef.current).length > 0 ||
        settingsDirtyRef.current.dirty ||
        profileDirtyRef.current ||
        commandDirtyRef.current;
      if (!hasUnsavedWork) {
        CloseWindow();
        return;
      }
      // Repeated requests while the dialog is up (a second Alt+F4) must not
      // stack prompts or quit behind the user's back.
      if (quitConfirmOpenRef.current) return;
      quitConfirmOpenRef.current = true;
      setQuitConfirmOpen(true);
    });
    return () => offCloseRequest();
  }, [notify, tr]);

  // Keyboard tab navigation walks the tab strip, so it has to see the same order
  // and the same membership the strip shows: torn-off terminals live in their own
  // windows and are not in it.
  const activateTab = useCallback((id: string, options: { keepFocus?: boolean } = {}) => {
    const target = tabsRef.current.find((tab) => tab.id === id);
    if (!target) return;
    setSplitPane((current) => {
      if (!current || target.type === "markdown" || splitPaneIds(current).includes(id)) return current;
      const ids = splitPaneIds(current);
      const index = Math.max(0, ids.indexOf(activeTabIdRef.current));
      ids[index] = id;
      return replaceSplitIds(current, ids);
    });
    sessionSetActiveTab(id);
    sessionSetTabs((items) => items.map((tab) => tab.id === id && tab.unread ? { ...tab, unread: false } : tab));
    // `keepFocus` marks an activation driven by the tab strip's own keyboard
    // navigation. That handler keeps the focus on the tab it just moved to, and
    // this focus move is a 10ms timer while the strip's is an animation frame:
    // on a display fast enough for the frame to fire first, the terminal took
    // the focus straight back and the next arrow key went to the shell instead
    // of the next tab.
    if (!options.keepFocus && target.type !== "markdown") window.setTimeout(() => focusTerminal(id), 10);
  }, [focusTerminal, sessionSetActiveTab, sessionSetTabs]);

  const activateTabByOffset = useCallback((offset: number) => {
    const visible = orderTabs(sessionTabs.filter((tab) => !floatingTabIds.includes(tab.id)));
    if (visible.length < 2) return;
    const current = visible.findIndex((tab) => tab.id === sessionActiveTab);
    // Wrap around; from an unknown/floating active tab, step in from the edge.
    const next = current === -1
      ? (offset > 0 ? 0 : visible.length - 1)
      : (current + offset + visible.length) % visible.length;
    const target = visible[next];
    activateTab(target.id);
  }, [activateTab, sessionTabs, sessionActiveTab, floatingTabIds]);

  const activateTabByIndex = useCallback((index: number) => {
    const visible = orderTabs(sessionTabs.filter((tab) => !floatingTabIds.includes(tab.id)));
    const target = visible[index];
    if (!target) return;
    activateTab(target.id);
  }, [activateTab, sessionTabs, floatingTabIds]);

  const togglePinTab = useCallback((tab: Tab) => {
    sessionSetTabs((items) => {
      const next = items.map((item) => item.id === tab.id ? { ...item, pinned: !item.pinned } : item);
      return [...next.filter((item) => item.pinned), ...next.filter((item) => !item.pinned)];
    });
  }, [sessionSetTabs]);

  // Torn-off terminals live in their own windows, so the strip and every action
  // that walks it must see the same membership.
  const visibleTabs = useMemo(
    () => orderTabs(sessionTabs.filter((tab) => !floatingTabIds.includes(tab.id))),
    [floatingTabIds, sessionTabs],
  );
  const namedWorkspaces = useNamedWorkspaces({
    sessions, profiles: profileState.profiles, floating: floatingTabIds, split: splitPane, setSplit: setSplitPane,
    dock: (ids) => setFloatingTabIds((current) => { const next = current.filter((id) => !ids.includes(id)); return next.length === current.length ? current : next; }),
    language: profileSettings?.language || "en",
  });
  const workspaceEligible = visibleTabs.filter((tab) => tab.type === "markdown"
    ? tab.markdownSource !== "remote" && !!tab.filePath
    : !tab.local && profileState.profiles.some((profile) => profile.id === tab.profileId)).length;

  // Split toggling moved up here with the tab strip. Toggling off refits both
  // panes after the layout settles; toggling on picks the neighbour that is not
  // already the active tab so the split never pairs a tab with itself.
  const handleSplitToggle = useCallback((tabId: string, direction: SplitDirection) => {
    const visible = tabsRef.current.filter((tab) => !floatingTabIdsRef.current.includes(tab.id) && tab.type !== "markdown");
    if (!visible.some((tab) => tab.id === tabId)) return;
    const current = splitPaneRef.current;
    const splitLive = !!current
      && visible.some((tab) => tab.id === current.left)
      && visible.some((tab) => tab.id === current.right);
    if (splitLive && current && current.direction === direction) {
      setSplitPane(null);
      window.setTimeout(() => splitPaneIds(current).forEach(refitTerminal), 80);
      return;
    }
    if (direction === "grid") {
      const ids = [tabId, ...visible.filter((tab) => tab.id !== tabId).map((tab) => tab.id)].slice(0, 4);
      if (ids.length < 4) return;
      setSplitPane({ left: ids[0], right: ids[1], bottom: [ids[2], ids[3]], direction, ratio: 0.5, rowRatio: 0.5 });
      return;
    }
    const other = visible.find((tab) => tab.id !== tabId && tab.id !== activeTabIdRef.current);
    const rightId = other?.id || visible.find((tab) => tab.id !== tabId)?.id;
    if (!rightId) return;
    setSplitPane({ left: tabId, right: rightId, direction, ratio: 0.5 });
    window.setTimeout(() => { refitTerminal(tabId); refitTerminal(rightId); }, 120);
  }, [refitTerminal]);

  // ── Sidebar width ─────────────────────────────────────────────────────────
  // Runtime font changes are deliberately session-local: they update every
  // open xterm immediately without rewriting preferences until the user saves
  // the terminal settings. A small HUD makes the otherwise invisible action
  // discoverable and confirms the effective (clamped) value.
  const showFontSizeHud = useCallback((value: number) => {
    setFontSizeHud(value);
    if (fontSizeHudTimer.current !== null) window.clearTimeout(fontSizeHudTimer.current);
    fontSizeHudTimer.current = window.setTimeout(() => {
      fontSizeHudTimer.current = null;
      setFontSizeHud(null);
    }, 1400);
  }, []);

  useEffect(() => () => {
    if (fontSizeHudTimer.current !== null) window.clearTimeout(fontSizeHudTimer.current);
  }, []);

  const adjustTerminalFontSize = useCallback((delta: number) => {
    if (!sessionActive || sessionActive.type === "markdown") return;
    showFontSizeHud(terminalAdjustFontSize(delta));
  }, [terminalAdjustFontSize, sessionActive, showFontSizeHud]);

  const resetTerminalFontSize = useCallback(() => {
    if (!sessionActive || sessionActive.type === "markdown") return;
    showFontSizeHud(terminalResetFontSize());
  }, [terminalResetFontSize, sessionActive, showFontSizeHud]);

  const reopenClosedTab = useCallback(async () => {
    const hadClosedTab = sessionClosedTabCount > 0;
    const restored = await sessionReopenClosedTab();
    if (!restored && !hadClosedTab) {
      notify(tr("noClosedTabs"), "info");
    }
  }, [notify, tr, sessionClosedTabCount, sessionReopenClosedTab]);

  const renameActiveTab = useCallback(() => {
    const tab = tabsRef.current.find((item) => item.id === activeTabIdRef.current);
    if (tab) setRenameTabRequest(tab);
  }, []);

  // This is the sole action registry for the keyboard, command palette, menus,
  // conflict detection, and future shortcut help/customization.
  const appActionRegistry = useMemo(() => {
    const registry = createDefaultActionRegistry({
      onGlobalSearch: () => { setGlobalQuery(""); setGlobalSearchOpen(true); },
      onTerminalSearch: (tabId) => { setTerminalSearchTab(tabId); setTerminalSearchOpen(true); },
      onCloseTab: (tabId) => { void closeTabForgettingFloating(tabId); },
      onNextTab: () => activateTabByOffset(1),
      onPrevTab: () => activateTabByOffset(-1),
      onSelectTab: activateTabByIndex,
      locale: lang,
    });
    registry.registerMany([
      {
        id: "workspace.reopen-closed-tab",
        label: tr("actionReopenClosedTab"),
        category: "Tabs",
        scope: "global",
        defaultShortcuts: ["Ctrl+Shift+T"],
        shortcuts: [{ key: "t", mod: true, shift: true }],
        allowInEditable: true,
        run: () => { void reopenClosedTab(); },
      },
      {
        id: "terminal.increase-font-size",
        label: tr("actionIncreaseFont"),
        category: "Terminal",
        scope: "terminal",
        defaultShortcuts: ["Ctrl+="],
        // Some keyboard layouts report the shifted plus key as `+` instead of
        // `=`. `matches` keeps both physical forms ergonomic without claiming
        // Ctrl+Alt combinations used by international layouts.
        matches: (event, context) => !!context.activeTab
          && !context.activeIsMarkdown
          && (event.ctrlKey || event.metaKey)
          && !event.altKey
          && (event.key === "=" || event.key === "+"),
        run: () => adjustTerminalFontSize(1),
      },
      {
        id: "terminal.decrease-font-size",
        label: tr("actionDecreaseFont"),
        category: "Terminal",
        scope: "terminal",
        defaultShortcuts: ["Ctrl+-"],
        matches: (event, context) => !!context.activeTab
          && !context.activeIsMarkdown
          && (event.ctrlKey || event.metaKey)
          && !event.altKey
          && event.key === "-",
        run: () => adjustTerminalFontSize(-1),
      },
      {
        id: "terminal.reset-font-size",
        label: tr("actionResetFont"),
        category: "Terminal",
        scope: "terminal",
        defaultShortcuts: ["Ctrl+0"],
        shortcuts: [{ key: "0", mod: true }],
        availability: (context) => !!context.activeTab && !context.activeIsMarkdown,
        run: resetTerminalFontSize,
      },
      {
        id: "workspace.rename-tab",
        label: tr("actionRenameTab"),
        category: "Tabs",
        scope: "workspace",
        defaultShortcuts: ["F2"],
        shortcuts: [{ key: "F2" }],
        // Terminal function keys belong to the remote TUI while xterm owns
        // focus. F2 remains available from the tab strip and command palette.
        availability: (context) => !!context.activeTab && !context.isTerminalInput,
        run: renameActiveTab,
      },
      {
        id: "workspace.toggle-zen-mode",
        label: zenMode
          ? tr("exitZenMode")
          : tr("enterZenMode"),
        category: "Workspace",
        scope: "global",
        defaultShortcuts: ["Ctrl+Shift+F11"],
        shortcuts: [{ key: "F11", mod: true, shift: true }],
        allowInEditable: true,
        run: () => setZenMode((value) => !value),
      },
      {
        id: "workspace.toggle-activity-center",
        label: activityCenterOpen
          ? tr("closeNotificationCenter")
          : tr("openNotificationCenter"),
        category: "Workspace",
        scope: "global",
        // Ctrl+Shift+N is a widely established new-window/incognito binding.
        // The center already has a persistent bell trigger, so keep this as a
        // palette/menu action instead of stealing that accelerator.
        defaultShortcuts: [],
        run: () => setActivityCenterOpen((value) => !value),
      },
      {
        id: "workspace.shortcut-help",
        label: tr("actionKeyboardShortcuts"),
        category: "Workspace",
        scope: "global",
        defaultShortcuts: [],
        run: () => setShortcutHelpOpen(true),
      },
    ]);
    return registry;
  }, [activityCenterOpen, activateTabByIndex, activateTabByOffset, adjustTerminalFontSize, closeTabForgettingFloating, lang, tr, renameActiveTab, reopenClosedTab, resetTerminalFontSize, setActivityCenterOpen, zenMode]);

  useHotkeys({
    activeTab: sessionActiveTab,
    activeIsMarkdown: sessionActive?.type === "markdown",
    registry: appActionRegistry,
  });

  const automationByProfile = useMemo(() => {
    const byProfile: Record<string, AutomationIndicator> = {};
    for (const tab of sessionTabs) {
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
  }, [automationActivity, sessionTabs]);

  const profileStates = useMemo(() => {
    const states: Record<string, { state: string; count: number; error?: string }> = {};
    const priority: Record<string, number> = {
      disconnected: 1,
      error: 2,
      connecting: 3,
      reconnecting: 3,
      restoring: 3,
      connected: 4,
    };
    for (const tab of sessionTabs) {
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
  }, [sessionTabs]);

  const saveProfile = async (profile: types.Profile) => {
    try {
      await profileState.saveProfile(profile);
      setProfileModal(null);
      notify(t(profileSettings?.language || "en", "profileSaved"), "success");
    } catch (err) {
      notify(String(err), "error");
      throw err;
    }
  };

  const importProfiles = useCallback(async (openSSH = false) => {
    try {
      const result = openSSH ? await ImportOpenSSHConfig() : await ImportProfiles();
      if (!result || result.cancelled) return;
      await profileReload();
      notify(t(profileSettings?.language || "en", "profilesImported", {
        added: String(result.added || 0),
        updated: String(result.updated || 0),
        skipped: String(result.skipped || 0),
      }), "success");
    } catch (err) {
      notify(String(err), "error");
    }
  }, [notify, profileReload, profileSettings?.language]);

  const exportProfiles = useCallback(async () => {
    try {
      const filePath = await ExportProfiles(false);
      if (filePath) notify(t(profileSettings?.language || "en", "profilesExported", { path: filePath }), "success");
    } catch (err) {
      notify(String(err), "error");
    }
  }, [notify, profileSettings?.language]);

  const openBackup = useCallback((mode: "export" | "import") => {
    if (settingsDirtyRef.current.dirty || namedWorkspaces.busy) {
      notify(tr("saveSettingsAndWorkspaceFirst"), "info");
      return;
    }
    setBackupMode(mode);
  }, [namedWorkspaces.busy, notify, tr]);

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

  const themeName = normalizeAppTheme(profileSettings?.themeName);

  // The frameless window's own background shows before the webview paints and
  // at the edges while a resize outruns it. No single hardcoded value can match
  // six themes, so push the resolved --bg down after every theme change.
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) return;
    const colour = parseRgbColor(window.getComputedStyle(shell).backgroundColor);
    if (!colour) return;
    try {
      // Absent until Wails injects its bindings, and absent entirely in tests.
      SetWindowBackgroundColour(colour.r, colour.g, colour.b)?.catch?.(() => undefined);
    } catch {
      /* bindings not injected yet */
    }
  }, [themeName]);

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
      const target = sessionActive;
      if (!target || target.type === "markdown" || target.state !== "connected") {
        notify(tr("selectConnectedTerminal"), "error");
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
  }, [runCommandTemplate, sessionActive, focusTerminal, notify, tr]);

  const runInSession = useCallback((cmd: types.CommandTemplate, sessionId: string) => {
    runCommandTemplate(cmd, async (command) => {
      const target = sessionTabs.find((tab) => tab.id === sessionId);
      if (!target || target.type === "markdown" || target.state !== "connected") {
        notify(tr("targetSessionDisconnected"), "error");
        return;
      }
      try {
        await SendCommandToTerminal(sessionId, command);
        notify(`${cmd.name} → ${target.title}`, "success");
        sessionSetActiveTab(sessionId);
        setTimeout(() => focusTerminal(sessionId), 10);
      } catch (err) {
        notify(String(err), "error");
      }
    });
  }, [focusTerminal, notify, tr, runCommandTemplate, sessionSetActiveTab, sessionTabs]);

  const runOnAll = useCallback((cmd: types.CommandTemplate) => {
    runCommandTemplate(cmd, (command) => {
      const targets = connectedSshTabs.map((tab) => ({ id: tab.id, title: tab.title }));
      if (targets.length === 0) {
        notify(tr("noConnectedSshSessions"), "error");
        return;
      }
      setBatchCommandProgress({ running: false, sent: 0, total: 0 });
      setBatchCommandRequest({ commandName: cmd.name, command, targets });
    });
  }, [connectedSshTabs, notify, tr, runCommandTemplate]);

  const startBatchCommand = useCallback(async (options: BatchCommandOptions) => {
    const request = batchCommandRequest;
    if (!request || batchCommandProgress.running) return;
    const currentTargets = connectedSshTabs.map((tab) => ({ id: tab.id, title: tab.title }));
    if (!sameTerminalPasteTargets(request.targets.map((target) => target.id), currentTargets.map((target) => target.id))) {
      setBatchCommandRequest({ ...request, targets: currentTargets });
      setBatchCommandProgress({ running: false, sent: 0, total: 0 });
      notify(tr("onlineTargetsChanged"), "error");
      return;
    }

    const controller = new AbortController();
    batchCommandAbort.current = controller;
    setBatchCommandProgress({ running: true, sent: 0, total: 0 });
    try {
      const result = await sendBatchCommand({
        command: request.command,
        targetIds: request.targets.map((target) => target.id),
        options,
        signal: controller.signal,
        send: SendCommandToTerminal,
        onProgress: (sent, total) => setBatchCommandProgress({ running: true, sent, total }),
      });
      if (result.cancelled) {
        notify(tr("broadcastStopped", { sent: String(result.sent), total: String(result.total) }), "info");
        setBatchCommandProgress({ running: false, sent: result.sent, total: result.total });
      } else {
        notify(tr("broadcastCompleted", { sent: String(result.sent) }), "success");
        setBatchCommandRequest(null);
        setBatchCommandProgress({ running: false, sent: result.sent, total: result.total });
      }
    } catch (err) {
      notify(String(err), "error");
      setBatchCommandProgress((current) => ({ ...current, running: false }));
    } finally {
      if (batchCommandAbort.current === controller) batchCommandAbort.current = null;
    }
  }, [batchCommandProgress.running, batchCommandRequest, connectedSshTabs, notify, tr]);

  const stopBatchCommand = useCallback(() => {
    batchCommandAbort.current?.abort();
  }, []);

  useEffect(() => () => batchCommandAbort.current?.abort(), []);

  const handleNewConnection = useCallback(() => setProfileModal(emptyProfile()), []);
  // From SFTP: jump the session terminal into the browsed directory and focus it.
  // OSC 7 is an enhancement here, not a prerequisite: a default server bash
  // never reports it, so requiring it would disable this action almost
  // everywhere. It is only consulted to veto the POSIX `cd` when the shell has
  // told us it uses a different path syntax (a Windows drive path).
  const handleOpenTerminalInDir = useCallback(async (sessionId: string, dirPath: string) => {
    const reportedDirectory = terminalGetCurrentDirectory(sessionId)?.path || "";
    if (reportedDirectory && !reportedDirectory.startsWith("/")) {
      notify(tr("remoteNonPosixPaths"), "error");
      return false;
    }
    const cmd = dirPath && dirPath !== "."
      ? `cd ${shellQuote(dirPath)}\n`
      : "pwd\n";
    try {
      await SendCommandToTerminal(sessionId, cmd);
    } catch (err) {
      notify(String(err), "error");
      return false;
    }
    sessionSetActiveTab(sessionId);
    setTimeout(() => focusTerminal(sessionId), 30);
    return true;
  }, [terminalGetCurrentDirectory, focusTerminal, notify, tr, sessionSetActiveTab]);
  const handleOpenCurrentDirectory = useCallback((sessionId: string, dirPath: string) => {
    const tab = tabsRef.current.find((item) => item.id === sessionId);
    if (!tab || tab.local || tab.type === "markdown" || tab.state !== "connected") return;
    sessionSetActiveTab(sessionId);
    requestDrawer("sftp");
    void sftpRefreshSftp(dirPath, sessionId);
  }, [requestDrawer, sessionSetActiveTab, sftpRefreshSftp]);
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
  }, [setKiRequests]);
  const searchConnectLocal = sessionConnectLocal;
  const searchConnectProfile = sessionConnectProfile;
  const searchSetActiveTab = activateTab;
  const searchTabs = sessionTabs;

  const globalResults = useMemo(() => {
    const parsedQuery = parsePaletteQuery(globalQuery);
    const q = parsedQuery.query.trim();
    const hasQuery = q.length > 0;
    // Candidates are deliberately unfiltered and unranked here: paletteSearch
    // owns matching (including subsequence matches like "dkr" -> "docker"),
    // scoring, and the >/@/# mode filter. Filtering with a substring test or
    // slicing per section first would hide exactly what it exists to find, so
    // everything searchable has to travel in `keywords`. With no query the
    // palette is a short suggestion list instead, which is what the caps below
    // are for.
    const suggestions = <T,>(items: T[]) => hasQuery ? items : items.slice(0, 4);
    const paletteContext: ActionContext = {
      event: new KeyboardEvent("keydown"),
      target: null,
      isTerminalInput: false,
      isEditable: false,
      isOverlay: false,
      activeTab: sessionActiveTab,
      activeIsMarkdown: sessionActive?.type === "markdown",
      floatingTabId: "",
    };
    const registeredActionResults = appActionRegistry.list()
      .filter((action) => !action.availability || action.availability(paletteContext))
      .map((action) => ({
        type: "action",
        title: action.label,
        subtitle: tr("actionSubtitle", { category: action.category }),
        keywords: `${action.id} ${action.category} ${action.label}`,
        category: action.category,
        scope: action.scope,
        defaultShortcuts: action.defaultShortcuts,
        mruKey: `action:${action.id}`,
        action: () => action.run({ ...paletteContext, event: new KeyboardEvent("keydown") }),
      }));
    const actionResults = [
      { type: "action", title: t(lang, "newConnection"), subtitle: tr("paletteNewConnection"), keywords: "new connection server ssh 新建 连接 服务器", action: () => setProfileModal(emptyProfile()) },
      { type: "action", title: t(lang, "quickConnect"), subtitle: t(lang, "quickConnectHint"), keywords: "quick connect temporary 快速 临时 连接", action: () => setQuickConnectOpen(true) },
      { type: "action", title: t(lang, "localTerminal"), subtitle: tr("paletteLocalTerminal"), keywords: "local terminal shell 本地 终端", action: () => { searchConnectLocal().catch((err) => notify(String(err), "error")); } },
      { type: "action", title: t(lang, "openDocument"), subtitle: tr("paletteOpenDocument"), keywords: "open document pdf text markdown file 打开 文档 PDF 文本 文件", action: handleOpenMarkdown },
    ];

    const serverResults = suggestions(profilesRef.current
      .slice()
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || String(b.lastConnectedAt || "").localeCompare(String(a.lastConnectedAt || ""))))
      .map((profile) => ({
        type: "server",
        title: profile.name || profile.host,
        subtitle: `${profile.username}@${profile.host}`,
        keywords: [profile.name, profile.host, profile.username, profile.group, ...(profile.tags || [])].filter(Boolean).join(" "),
        action: () => searchConnectProfile(profile),
      }));

    const tabResults = suggestions(searchTabs).map((tab) => ({
      type: "terminal",
      title: tab.title,
      subtitle: tr("paletteSwitchTab"),
      keywords: `${tab.title} ${tab.local ? "local terminal 本地终端" : "terminal session 终端 会话"}`,
      action: () => searchSetActiveTab(tab.id),
    }));

    const commandResults = (hasQuery || parsedQuery.mode === "commands") ? commandsRef.current
      .map((cmd) => ({
        type: "command",
        title: cmd.name,
        subtitle: cmd.command,
        keywords: [cmd.name, cmd.command, cmd.category, cmd.description, ...(cmd.tags || [])].filter(Boolean).join(" "),
        action: () => runOnActive(cmd),
      })) : [];

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
    const areaResults = hasQuery ? drawerMeta.map((item) => ({
      type: "area",
      title: item.title,
      subtitle: tr("paletteOpenWorkspace"),
      keywords: `${item.title} ${item.drawer} ${item.keywords}`,
      action: () => requestDrawer(item.drawer),
    })) : [];

    return [...registeredActionResults, ...actionResults, ...tabResults, ...serverResults, ...commandResults, ...areaResults];
  }, [appActionRegistry, globalQuery, handleOpenMarkdown, notify, lang, tr, requestDrawer, runOnActive, searchConnectLocal, searchConnectProfile, searchSetActiveTab, searchTabs, sessionActive?.type, sessionActiveTab]);

  const resolveTransferSession = (item: Pick<TransferHistoryItem, "sessionId" | "runtimeId" | "profileId">) => {
    const current = connectedSshTabs.find((tab) => (
      (item.runtimeId && tab.runtimeId === item.runtimeId)
      || (!item.runtimeId && item.profileId && tab.profileId === item.profileId)
      || (!item.runtimeId && !item.profileId && tab.id === item.sessionId)
    ));
    return current?.id;
  };

  return (
    <TransfersProvider resolveSessionId={resolveTransferSession}>
    <div
      className="app-shell"
      onContextMenu={() => setCtxMenu(null)}
      data-theme={themeName}
      data-document-active={sessionActive?.type === 'markdown' ? 'true' : 'false'}
      data-collapsed={sidebarCollapsed ? "true" : "false"}
      data-zen={zenMode ? "true" : "false"}
      data-maximized={windowMaximized ? "true" : "false"}
      data-resizing={sidebarResizing ? "true" : "false"}
      style={{ ["--sidebar-panel-width" as string]: `${effectiveSidebarWidth}px` } as React.CSSProperties}
    >
      {zenMode && (
        <button
          type="button"
          className="zen-mode-exit"
          aria-label={tr("exitZenMode")}
          title={tr("exitZenMode")}
          onClick={() => setZenMode(false)}
        >
          <PanelLeftOpen size={15} />
        </button>
      )}
      {fontSizeHud !== null && (
        <div className="terminal-font-hud" role="status" aria-live="polite">
          <TypeIcon size={14} aria-hidden="true" />
          <span>{fontSizeHud}px</span>
        </div>
      )}
      <AppTopBar
        language={profileSettings?.language || "en"}
        onMaximizedChange={setWindowMaximized}
        tabbar={<TabBar
          tabs={visibleTabs}
          activeTab={sessionActiveTab}
          profiles={profileState.profiles}
          onActive={activateTab}
          onClose={sessionCloseTab}
          onCloseMany={sessionCloseTabs}
          closingTabs={sessionClosingTabs}
          onReconnect={sessionReconnectTab}
          onNewTerminal={(tab) => { const profile = profileState.profiles.find((p) => p.id === tab.profileId); if (profile) void sessionConnectProfile(profile, { instanceId: crypto.randomUUID() }); }}
          onTearOff={handleTearOff}
          onReorder={sessionReorderTabs}
          onSplitToggle={handleSplitToggle}
          onNewConnection={handleNewConnection}
          onNewLocal={sessionConnectLocal}
          onOpenMarkdown={handleOpenMarkdown}
          onRename={setRenameTabRequest}
          onTogglePin={togglePinTab}
          broadcastInput={broadcastInput}
          broadcastAvailable={connectedSshCount > 1}
          onToggleBroadcast={handleToggleBroadcast}
          recording={activeRecording}
          onToggleRecording={toggleRecording}
          automationActivity={automationActivity}
          dirtyTabIds={dirtyTabIds}
          language={profileSettings?.language || "en"}
          rightAccessory={<><button className="tab-action" title={tr("workspacesTitle")} aria-label={tr("workspacesTitle")} onClick={() => { sessionBeginFocusRequest(); setWorkspacesOpen(true); }}><PanelsTopLeft size={15} /></button><ActivityCenter
            activities={activities}
            unreadCount={unreadActivityCount}
            locale={profileSettings?.language || "en"}
            open={activityCenterOpen}
            onOpenChange={setActivityCenterOpen}
            onMarkRead={markActivityRead}
            onMarkAllRead={markAllActivitiesRead}
            onDismiss={removeActivity}
            onClear={clearActivities}
          /></>}
        />}
      />
      <main className="workspace">
        <Sidebar
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          onResizeStart={beginSidebarResize}
          onResizeReset={resetSidebarResize}
          onResizeAdjust={adjustSidebarWidth}
          panelWidth={effectiveSidebarWidth}
          panelWidthMin={sidebarPanelMin}
          panelWidthMax={sidebarPanelMax}
          setCtxMenu={setCtxMenu}
          drawer={drawer}          setDrawer={requestDrawer}
          onSettingsDirtyChange={handleSettingsDirtyChange}
          profiles={profileState.profiles}
          commands={profileState.commands}
          settings={profileSettings}
          appInfo={profileState.appInfo}
          active={sessionActive}
          remotePath={sftp.remotePath}
          remoteFiles={sftp.remoteFiles}
          sftpBusy={sftp.sftpBusy}
          markdownSiblings={markdownSiblings}
          markdownSiblingsBusy={markdownSiblingsBusy}
          markdownSiblingsError={markdownSiblingsError}
          documentOutline={documentOutline?.tabId === sessionActiveTab ? documentOutline.outline : undefined}
          onRefreshMarkdownSiblings={refreshMarkdownSiblings}
          recentMarkdown={recentMarkdown}
          onOpenMarkdownFile={handleOpenMarkdownSibling}
          onOpenRemoteMarkdownFile={openRemoteMarkdownFile}
          onPickTextFile={handleOpenMarkdown}
          onOpenRecentMarkdown={handleOpenRecentMarkdown}
          onRemoveRecentMarkdown={handleRemoveRecentMarkdown}
          onNewProfile={() => setProfileModal(emptyProfile())}
          onBulkProfiles={() => setBulkProfilesOpen(true)}
          onQuickConnect={() => setQuickConnectOpen(true)}
          onEditProfile={(profile) => setProfileModal(new types.Profile(profile))}
          onConnectProfile={sessionConnectProfile}
          onToggleFavorite={async (profile) => {
            try { await profileState.saveProfile(new types.Profile({ ...profile, favorite: !profile.favorite })); }
            catch (err) { notify(String(err), "error"); }
          }}
          revokingCliTrustID={revokingCliTrustID}
          onRevokeCliTrust={async (profileID) => {
            setRevokingCliTrustID(profileID);
            try {
              await RevokeCliTrust(profileID);
              await profileReload();
              notify(t(profileSettings?.language || "en", "cliTrustRevoked"), "success");
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
          onExportBackup={() => openBackup("export")}
          onImportBackup={() => openBackup("import")}
          onOpenSearch={() => setGlobalSearchOpen(true)}
          onStartMonitor={() => sessionActive && StartMonitor(sessionActive.id)}
          onRefreshSftp={sftpRefreshSftp}
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
            await profileSaveSettings(next);
            notify(t(profileSettings?.language || "en", "settingsSaved"), "success");
          }}
          onOpenData={OpenDataDir}
          onOpenLog={async (name, sessionLog) => {
            try {
              const content = await (sessionLog ? ReadSessionLogFile(name) : ReadLogFile(name));
              setLogViewer({ name, content });
            } catch { notify(t(profileSettings?.language || "en", "logReadFailed"), "error"); }
          }}
          getTerminalLines={activeTerminal.getTerminalLines}
          activeTabId={sessionActiveTab}
          tabs={sessionTabs}
          profileStates={profileStates}
          detectedOsMap={detectedOsMap}
          activityHistory={activityHistory}
          automationByProfile={automationByProfile}
        />
        <TerminalArea
          tabs={sessionTabs}
          activeTab={sessionActiveTab}
          profiles={profileState.profiles}
          terminalHosts={activeTerminal.terminalHosts}
          getDimensions={activeTerminal.getDimensions}
          getCurrentDirectory={terminalGetCurrentDirectory}
          onOpenCurrentDirectory={handleOpenCurrentDirectory}
          onActive={activateTab}
          onClose={sessionCloseTab}
          onReconnect={sessionReconnectTab}
          onNewConnection={handleNewConnection}
          onOpenMarkdownFile={openMarkdownTarget}
          onNotify={notify}
          language={profileSettings?.language || "en"}
          logViewer={logViewer}
          onCloseLogViewer={handleCloseLogViewer}
          floatingTabIds={floatingTabIds}
          splitPane={splitPane}
          onSplitChange={setSplitPane}
          refitTerminal={refitTerminal}
          broadcastInput={broadcastInput}
          broadcastCount={connectedSshCount}
          onToggleBroadcast={handleToggleBroadcast}
          onMarkdownDirtyChange={handleMarkdownDirtyChange}
          onDocumentOutlineChange={handleDocumentOutlineChange}
        />
      </main>
      <CliApprovalQueue approvals={cliApprovals} locale={profileSettings?.language || "en"} />
      {cliApprovalPanel && (
        <CliApprovalPanel
          // Keyed by request id so a replacement request mounts with a fresh
          // selection instead of inheriting the previous request's checkboxes.
          key={cliApprovalPanel.id}
          request={cliApprovalPanel}
          locale={profileSettings?.language || "en"}
          onResolve={handleCliApprovalResolve}
        />
      )}
      {floatingTabIds.map((id) => {
        const tab = sessionTabs.find((t) => t.id === id);
        if (!tab) return null;
        return <FloatingTerminal key={id} tab={tab} terminalHosts={activeTerminal.terminalHosts} onDock={handleDockFloating} onClose={handleCloseFloating} refitTerminal={refitTerminal} reattachTerminal={reattachTerminal} />;
      })}
      {globalSearchOpen && <GlobalSearchModal query={globalQuery} onQuery={setGlobalQuery} results={globalResults} onClose={() => setGlobalSearchOpen(false)} locale={profileSettings?.language || "en"} />}
      {terminalSearchOpen && <TerminalSearchModal
        query={terminalSearch}
        onQuery={(value) => {
          setTerminalSearch(value);
          if (value) findNext(terminalSearchTab, value);
          else setTerminalSearchResult(null);
        }}
        onNext={() => findNext(terminalSearchTab, terminalSearch)}
        onPrev={() => findPrev(terminalSearchTab, terminalSearch)}
        onClose={() => { setTerminalSearchOpen(false); setTerminalSearchResult(null); }}
        matchIndex={terminalSearchResult?.id === terminalSearchTab ? terminalSearchResult.index : undefined}
        matchCount={terminalSearchResult?.id === terminalSearchTab ? terminalSearchResult.count : undefined}
        locale={profileSettings?.language || "en"}
      />}
      {pasteRequest && <PasteConfirmDialog
        request={pasteRequest}
        language={profileSettings?.language || "en"}
        onCancel={() => setPasteRequest(null)}
        onConfirm={() => {
          const request = pasteRequest;
          setPasteRequest(null);
          const connected = new Set(tabsRef.current.filter((tab) => tab.state === "connected").map((tab) => tab.id));
          const currentTargets = request.broadcast
            ? (broadcastRef.current.enabled ? terminalPasteTargets(request.sessionId, broadcastRef.current) : [])
            : [request.sessionId];
          const targetsChanged = !sameTerminalPasteTargets(request.targetIds, currentTargets)
            || request.targetIds.some((id) => !connected.has(id));
          if (targetsChanged) {
            notify(tr("pasteTargetsChanged"), "error");
            return;
          }
          request.commit();
        }}
      />}
      {batchCommandRequest && <BatchCommandDialog
        request={batchCommandRequest}
        language={profileSettings?.language || "en"}
        running={batchCommandProgress.running}
        sent={batchCommandProgress.sent}
        total={batchCommandProgress.total}
        onClose={() => setBatchCommandRequest(null)}
        onStart={(options) => { void startBatchCommand(options); }}
        onStop={stopBatchCommand}
      />}
      {shortcutHelpOpen && <ShortcutHelpDialog
        actions={appActionRegistry.list()}
        conflicts={appActionRegistry.conflicts()}
        language={profileSettings?.language || "en"}
        onClose={() => setShortcutHelpOpen(false)}
      />}
      {renameTabRequest && <TextInputDialog
        title={tr("renameTab")}
        label={tr("tabName")}
        initialValue={renameTabRequest.title}
        locale={profileSettings?.language || "en"}
        onClose={() => setRenameTabRequest(null)}
        onSubmit={(title) => {
          sessionSetTabs((items) => items.map((tab) => tab.id === renameTabRequest.id ? { ...tab, title, customTitle: true } : tab));
          setRenameTabRequest(null);
        }}
      />}
      {profileModal && <ProfileModal profile={profileModal} profiles={profileState.profiles} language={profileSettings?.language || "en"} terminalDefaults={profileSettings?.terminal} sessionLogDefaults={profileSettings?.sessionLog} onClose={() => setProfileModal(null)} onSave={saveProfile} onPickKey={SelectPrivateKey} onDelete={(id) => setDeleteProfileRequest({ id, name: profileModal.name || profileModal.host, closeEditor: true })} onDuplicate={async (id) => { await profileState.duplicateProfile(id); notify(t(profileSettings?.language || "en", "profileCopied"), "info"); }} onDirtyChange={handleProfileDirtyChange} />}
      {bulkProfilesOpen && <BulkProfilesModal profiles={profileState.profiles} language={profileSettings?.language || "en"} onClose={() => setBulkProfilesOpen(false)} onSave={async (ids, patch) => { await UpdateProfilesBatch(ids, patch); await profileReload(); notify(tr("batchChangesSaved"), "success"); }} />}
      {workspacesOpen && <WorkspacesModal manager={namedWorkspaces} language={profileSettings?.language || "en"} eligible={workspaceEligible} excluded={visibleTabs.length - workspaceEligible} onClose={() => setWorkspacesOpen(false)} />}
      {backupMode && <BackupModal
        mode={backupMode}
        language={profileSettings?.language || "en"}
        onClose={() => setBackupMode(null)}
        onBusyChange={handleBackupBusyChange}
        onApply={(token, previous, workspaces) => namedWorkspaces.restoreBackup(previous, workspaces, () => ApplyBackup(token, previous || "[]"))}
        onImported={() => {
          notify(tr("backupRestored"), "success");
          void profileReload().catch((err) => notify(`${tr("backupRestoredRefreshFailed")}: ${String(err)}`, "error"));
        }}
        onExported={(path) => notify(tr("backupExported", { path }), "success")}
      />}
      {quickConnectOpen && <QuickConnectModal
        language={profileSettings?.language || "en"}
        onClose={() => setQuickConnectOpen(false)}
        onPickKey={SelectPrivateKey}
        onSave={async (profile) => {
          const saved = await profileState.saveProfile(profile);
          notify(t(profileSettings?.language || "en", "profileSaved"), "success");
          return saved;
        }}
        onConnect={async (profile) => {
          if (profile.id.startsWith("quick-")) await sessionConnectQuick(profile);
          else await sessionConnectProfileWithSecrets(profile, profile.password || "", profile.privateKeyPassphrase || "");
        }}
      />}
      {commandModal && <CommandModal command={commandModal} language={profileSettings?.language || "en"} onClose={() => setCommandModal(null)} onSave={saveCommand} onDirtyChange={handleCommandDirtyChange} />}
      {deleteProfileRequest && <ConfirmDialog
        locale={profileSettings?.language || "en"}
        title={tr("deleteProfileConfirm")}
        body={tr("deleteProfileConfirmBody", { name: deleteProfileRequest.name })}
        confirmText={t(profileSettings?.language || "en", "delete")}
        onClose={() => setDeleteProfileRequest(null)}
        onConfirm={async () => {
          await profileState.deleteProfile(deleteProfileRequest.id);
          if (deleteProfileRequest.closeEditor) setProfileModal(null);
          setDeleteProfileRequest(null);
          notify(tr("profileDeleted"), "success");
        }}
      />}
      {deleteCommandRequest && <ConfirmDialog
        locale={profileSettings?.language || "en"}
        title={tr("deleteCommandConfirm")}
        body={tr("deleteCommandConfirmBody", { name: deleteCommandRequest.name })}
        confirmText={t(profileSettings?.language || "en", "delete")}
        onClose={() => setDeleteCommandRequest(null)}
        onConfirm={async () => {
          await DeleteCommand(deleteCommandRequest.id);
          profileState.setCommands(await ListCommands());
          setDeleteCommandRequest(null);
          notify(tr("commandDeleted"), "success");
        }}
      />}
      {quitConfirmOpen && <ConfirmDialog
        locale={profileSettings?.language || "en"}
        title={tr("quitConfirm")}
        body={tr("quitConfirmBody")}
        confirmText={tr("quitAction")}
        onClose={() => { quitConfirmOpenRef.current = false; setQuitConfirmOpen(false); }}
        onConfirm={() => CloseWindow()}
      />}
      {commandVars && <CommandVarsDialog commandName={commandVars.commandName} template={commandVars.template} placeholders={commandVars.placeholders} locale={profileSettings?.language || "en"} onClose={() => setCommandVars(null)} onSubmit={(resolved) => { const send = commandVars.send; setCommandVars(null); send(resolved); }} />}
      {sessionSecretRequest && <SecretModal request={sessionSecretRequest} language={profileSettings?.language || "en"} onClose={sessionCancelSecretRequest} onSubmit={async (password, passphrase) => { const request = sessionSecretRequest; if (!request) return; await sessionSubmitSecret(request, password, passphrase); sessionSetSecretRequest(null); }} />}
      {activeKiRequest && <KeyboardInteractiveDialog key={activeKiRequest.requestId} request={activeKiRequest} language={profileSettings?.language || "en"} onSubmit={(answers) => answerKiRequest(activeKiRequest, answers, false)} onCancel={() => answerKiRequest(activeKiRequest, [], true)} />}
      {settingsPrompt && <UnsavedChangesDialog
        title={t(profileSettings?.language || "en", "unsavedSettingsTitle")}
        body={t(profileSettings?.language || "en", "unsavedSettingsBody")}
        locale={profileSettings?.language || "en"}
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
        locale={profileSettings?.language || "en"}
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
        locale={profileSettings?.language || "en"}
        title={tr("disconnectConfirm")}
        body={tr("disconnectConfirmBody", { title: disconnectPrompt.tab.title })}
        confirmText={tr("disconnectAction")}
        onClose={() => { disconnectPrompt.resolve(false); setDisconnectPrompt(null); }}
        onConfirm={() => { disconnectPrompt.resolve(true); setDisconnectPrompt(null); }}
      />}
      {updateCheck.promptOpen && updateCheck.result && <UpdateDialog
        result={updateCheck.result}
        locale={profileSettings?.language || "en"}
        onSkip={updateCheck.skipVersion}
        onClose={updateCheck.dismissPrompt}
      />}
      <ProgressBar />
      <ToastStack toasts={toasts} onDismiss={dismissToast} locale={profileSettings?.language || "en"} />
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
