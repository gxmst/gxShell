import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { Connect, ConnectTerminal, ConnectQuick, ConnectWithSecrets, ConnectLocal, Disconnect, ListSessions, Reconnect, ReconnectWithSecrets, StopMonitor } from "../../wailsjs/go/app/App";
import { types } from "../../wailsjs/go/models";
import type { SecretRequest, Tab } from "../types";
import { needsSecret, tabTitle } from "../utils/format";
import { sameTerminal, terminalKey } from "../utils/sessionIdentity";
import { t } from "../i18n";

type UseSessionsOptions = {
  profiles: types.Profile[];
  notify: (text: string, tone?: "info" | "error" | "success") => void;
  reload: () => Promise<void>;
  disposeTerminal: (id: string) => void;
  restoreWorkspace?: boolean;
  language?: string;
  beforeCloseTab?: (tab: Tab) => boolean | Promise<boolean>;
};

const isSessionNotFoundError = (err: unknown) => String(err).toLowerCase().includes("session not found");

// A profile can be present in the tab strip while its transport is being
// replaced or restored. Treat those states as occupied so a second connect
// cannot race the recovery path and create duplicate sessions.
const isSessionBusy = (state: string) => (
  state === "connecting"
  || state === "connected"
  || state === "reconnecting"
  || state === "restoring"
);

type RuntimeEvent = {
  sessionId?: string;
  runtimeId?: string;
  generation?: number;
};

type ClosedTabRecord = {
  tab: Tab;
  quickProfile?: types.Profile;
};

type PendingRestoreMetadata = Pick<Tab, "title" | "customTitle" | "pinned"> & {
  closedRecord?: ClosedTabRecord;
};

type SessionOpenOptions = {
  preserveActiveTab?: boolean;
  focusRevision?: number;
  instanceId?: string;
};

const rememberRuntimeGeneration = (generations: Map<string, number>, runtimeID: string, generation: number) => {
  const current = generations.get(runtimeID) || 0;
  if (generation <= current) return;
  // Refresh insertion order so the bounded map behaves like a small LRU. Late
  // transport events are short-lived; 512 runtimes leaves a generous fence
  // without growing forever during a long-running app session.
  generations.delete(runtimeID);
  generations.set(runtimeID, generation);
  if (generations.size > 512) {
    const oldest = generations.keys().next().value;
    if (oldest) generations.delete(oldest);
  }
};

// Only the fields the backend actually reported are returned, so spreading the
// result onto an existing tab can never blank out an identity it already has.
const runtimeFields = (info: types.SessionInfo): Pick<Partial<Tab>, "runtimeId" | "connectionGeneration" | "instanceId"> => {
  const generation = Number(info.generation || 0);
  const runtimeId = info.runtimeId || (info.profileId ? `profile:${terminalKey(info.profileId, info.instanceId)}` : "");
  return {
    instanceId: info.instanceId || "",
    ...(runtimeId ? { runtimeId } : {}),
    ...(generation > 0 ? { connectionGeneration: generation } : {}),
  };
};

function replaceSessionTabs(items: Tab[], oldID: string, info: types.SessionInfo, title: string): Tab[] {
  const runtime = runtimeFields(info);
  return items.filter((tab) => tab.id !== info.id || tab.id === oldID).map((tab) => {
    if (tab.type === "markdown" && tab.remoteSessionId === oldID) {
      return { ...tab, ...runtime, profileId: info.profileId, remoteSessionId: info.id };
    }
    return tab.id === oldID
      ? { ...tab, id: info.id, ...runtime, profileId: info.profileId, title: tab.customTitle ? tab.title : title, state: info.state, error: undefined }
      : tab;
  });
}

type WorkspaceConnection = { profileId: string; instanceId?: string };

const readWorkspaceProfiles = (): { items: WorkspaceConnection[]; activeProfileId: string } => {
  try {
    const parsed = JSON.parse(localStorage.getItem("gx:workspaceProfiles") || "[]");
    const items: WorkspaceConnection[] = [];
    for (const value of Array.isArray(parsed) ? parsed.slice(0, 20) : []) {
      const item = typeof value === "string" ? { profileId: value } : value;
      if (!item || typeof item.profileId !== "string" || !item.profileId || item.profileId.length > 256 || (item.instanceId !== undefined && (typeof item.instanceId !== "string" || !/^[a-zA-Z0-9-]{0,64}$/.test(item.instanceId)))) continue;
      if (!items.some((prior) => sameTerminal(prior, item.profileId, item.instanceId))) items.push({ profileId: item.profileId, instanceId: item.instanceId });
    }
    return { items, activeProfileId: localStorage.getItem("gx:workspaceActiveProfile") || "" };
  } catch {
    return { items: [], activeProfileId: "" };
  }
};

export async function restoreProfilesInBatches<T>(
  profiles: T[],
  connect: (profile: T) => void | Promise<void>,
  batchSize = 3,
) {
  const size = Math.max(1, Math.floor(batchSize));
  for (let index = 0; index < profiles.length; index += size) {
    await Promise.all(profiles.slice(index, index + size).map((profile) => connect(profile)));
  }
}

export function useSessions(options: UseSessionsOptions) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTabState] = useState("");
  const focusRevision = useRef(0);
  const beginFocusRequest = useCallback(() => ++focusRevision.current, []);
  const isFocusRequestCurrent = useCallback((revision: number) => focusRevision.current === revision, []);
  const setActiveTab = useCallback((value: React.SetStateAction<string>) => {
    focusRevision.current += 1;
    setActiveTabState(value);
  }, []);
  const finishFocusRequest = useCallback((id: string, revision: number) => {
    setActiveTabState((current) => focusRevision.current === revision ? id : current);
  }, []);
  const restoreActiveTab = useCallback((id: string) => {
    finishFocusRequest(id, 0);
  }, [finishFocusRequest]);
  const [secretRequest, setSecretRequest] = useState<SecretRequest | null>(null);
  const workspaceProfiles = useRef(readWorkspaceProfiles());
  const workspaceRestoreStarted = useRef(false);
  const pendingWorkspaceActiveProfile = useRef("");
  const [workspaceRestoreReady, setWorkspaceRestoreReady] = useState(false);
  const [sessionsHydrated, setSessionsHydrated] = useState(false);
  const runtimeGenerations = useRef<Map<string, number>>(new Map());
  const closedTabs = useRef<ClosedTabRecord[]>([]);
  const [closedTabCount, setClosedTabCount] = useState(0);
  const pendingRestoreMetadata = useRef<Map<string, PendingRestoreMetadata>>(new Map());

  const active = useMemo(() => tabs.find((tab) => tab.id === activeTab), [tabs, activeTab]);

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const notifyRef = useRef(options.notify);
  notifyRef.current = options.notify;
  const reloadRef = useRef(options.reload);
  reloadRef.current = options.reload;
  const disposeTerminalRef = useRef(options.disposeTerminal);
  disposeTerminalRef.current = options.disposeTerminal;
  const profilesRef = useRef(options.profiles);
  profilesRef.current = options.profiles;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // One-off quick connections intentionally never reach profiles.json. Keep
  // their connection material in renderer memory so a tab can still be
  // manually reconnected during this app run.
  const quickProfiles = useRef<Map<string, types.Profile>>(new Map());

  // Only UI-initiated fresh connections create an optimistic "connecting"
  // tab from the backend event. External gxshell-cli connections emit the same
  // low-level event and must not steal focus from the user's current work.
  const creatingProfiles = useRef<Set<string>>(new Set());
  // Workspace restoration creates the same optimistic connecting tabs as a
  // user initiated connection. Keep those events from moving focus away from
  // a local document that was opened during startup.
  const preserveFocusProfiles = useRef<Set<string>>(new Set());
  const connectionFocus = useRef<Map<string, number>>(new Map());
  const connectingSessionProfiles = useRef<Map<string, string>>(new Map());
  // Connect failures are delivered both as terminal:error and as a rejected
  // Connect promise. Remember the profile whose event was already surfaced so
  // the Promise catch does not show the same message a second time.
  const recentConnectionErrorProfiles = useRef<Map<string, number>>(new Map());

  // Auto-reconnect bookkeeping. Keyed by the tab id that owned the session that
  // dropped. userClosing marks ids the user is intentionally closing so their
  // disconnect does not trigger a reconnect.
  const autoReconnect = useRef<Record<string, { attempts: number; timer: number; inFlight?: boolean; gaveUp?: boolean; cancelledByClose?: boolean }>>({});
  const userClosing = useRef<Set<string>>(new Set());
  // Session ids whose backend-owned reconnect this renderer observed on a live
  // tab. The cli-session-replaced handler consumes the record to tell a
  // user-closed tab (tab gone, record present: honor the close, disconnect the
  // unclaimed replacement) from a session this renderer never showed (reload
  // race: keep the session visible rather than killing live CLI work).
  const recoveringTabs = useRef<Set<string>>(new Set());
  const scheduleAutoReconnectRef = useRef<(tabId: string) => void>(() => undefined);

  const clearAutoReconnect = useCallback((tabId: string) => {
    const entry = autoReconnect.current[tabId];
    if (entry) {
      window.clearTimeout(entry.timer);
      delete autoReconnect.current[tabId];
    }
  }, []);

  const acceptRuntimeEvent = useCallback((event: RuntimeEvent) => {
    const runtimeID = event.runtimeId;
    const generation = Number(event.generation || 0);
    if (!runtimeID || generation <= 0) return true;
    const current = runtimeGenerations.current.get(runtimeID) || 0;
    if (generation < current) return false;
    if (generation > current) rememberRuntimeGeneration(runtimeGenerations.current, runtimeID, generation);
    return true;
  }, []);

  const rememberSessionInfo = useCallback((info: types.SessionInfo) => {
    const fields = runtimeFields(info);
    if (fields.runtimeId && fields.connectionGeneration) {
      rememberRuntimeGeneration(runtimeGenerations.current, fields.runtimeId, fields.connectionGeneration);
    }
    return fields;
  }, []);

  useEffect(() => {
    const offConnecting = EventsOn("terminal:connecting", (info: types.SessionInfo) => {
      const key = terminalKey(info?.profileId, info?.instanceId);
      if (!info?.id || !acceptRuntimeEvent(info) || !creatingProfiles.current.has(key)) return;
      const runtime = rememberSessionInfo(info);
      connectingSessionProfiles.current.set(info.id, info.profileId);
      const profile = profilesRef.current.find((item) => item.id === info.profileId) || quickProfiles.current.get(info.profileId);
      setTabs((items) => items.some((tab) => tab.id === info.id)
        ? items
        : [...items, { id: info.id, ...runtime, profileId: info.profileId, title: tabTitle(profile, info.name), state: "connecting" }]);
      const preserveActiveTab = preserveFocusProfiles.current.has(key);
      const revision = connectionFocus.current.get(key);
      if (preserveActiveTab) setActiveTabState((current) => current || info.id);
      else if (revision !== undefined) finishFocusRequest(info.id, revision);
      else setActiveTab(info.id);
    });
    const offConnected = EventsOn("terminal:connected", (info: types.SessionInfo) => {
      if (!acceptRuntimeEvent(info)) return;
      const runtime = rememberSessionInfo(info);
      connectingSessionProfiles.current.delete(info.id);
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, ...runtime, state: "connected", error: undefined } : tab));
      // No toast for the ordinary outcome: the tab's own state is the feedback,
      // and App records every connection state change in the activity history
      // already. Failures still toast, from terminal:error below.
    });
    const offDisconnected = EventsOn("terminal:disconnected", (info: types.SessionInfo) => {
      if (!acceptRuntimeEvent(info)) return;
      connectingSessionProfiles.current.delete(info.id);
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, state: "disconnected" } : tab));
      scheduleAutoReconnectRef.current(info.id);
    });
    const offError = EventsOn("terminal:error", (payload: { sessionId: string; error: string; runtimeId?: string; generation?: number }) => {
      if (!acceptRuntimeEvent(payload)) return;
      const failedTab = tabsRef.current.find((tab) => tab.id === payload.sessionId);
      const failedProfileId = failedTab?.profileId || connectingSessionProfiles.current.get(payload.sessionId);
      if (failedProfileId) {
        recentConnectionErrorProfiles.current.set(failedProfileId, Date.now());
      }
      connectingSessionProfiles.current.delete(payload.sessionId);
      setTabs((items) => items.map((tab) => tab.id === payload.sessionId ? { ...tab, state: "error", error: payload.error } : tab));
      notifyRef.current(payload.error, "error");
      scheduleAutoReconnectRef.current(payload.sessionId);
    });
    const offCliSession = EventsOn("terminal:cli-session", (info: types.SessionInfo) => {
      if (!info?.id || !acceptRuntimeEvent(info)) return;
      const runtime = rememberSessionInfo(info);
      const profile = profilesRef.current.find((item) => item.id === info.profileId) || quickProfiles.current.get(info.profileId);
      const title = tabTitle(profile, info.name);
      setTabs((items) => {
        const existing = items.find((tab) => tab.id === info.id);
        if (existing) {
          if (existing.profileId === info.profileId && existing.title === title && existing.state === info.state && !existing.error) return items;
          return items.map((tab) => tab.id === info.id
            ? { ...tab, ...runtime, profileId: info.profileId, title: tab.customTitle ? tab.title : title, state: info.state, error: undefined }
            : tab);
        }
        return [...items, { id: info.id, ...runtime, profileId: info.profileId, title, state: info.state }];
      });
      // Do not steal focus from the user's current terminal. If the CLI session
      // is the first tab, make it active so its buffered output has a visible
      // host immediately.
      setActiveTabState((current) => current || info.id);
    });
    const offCliSessionRecovering = EventsOn("terminal:cli-session-recovering", (payload: { sessionId: string; runtimeId?: string; generation?: number }) => {
      if (!payload?.sessionId || !acceptRuntimeEvent(payload)) return;
      clearAutoReconnect(payload.sessionId);
      // The backend owns this reconnect. Suppress the normal disconnected
      // event path so it cannot start a second connection in parallel.
      userClosing.current.add(payload.sessionId);
      // Record that this renderer showed a live tab for the reconnect — see
      // recoveringTabs above for how the replaced handler consumes it.
      if (tabsRef.current.some((tab) => tab.id === payload.sessionId)) {
        recoveringTabs.current.add(payload.sessionId);
      }
      setTabs((items) => items.map((tab) => tab.id === payload.sessionId
        ? { ...tab, state: "reconnecting", error: undefined }
        : tab));
    });
    const offCliSessionReplaced = EventsOn("terminal:cli-session-replaced", (payload: { oldSessionId: string; session: types.SessionInfo }) => {
      const info = payload?.session;
      if (!payload?.oldSessionId || !info?.id || !acceptRuntimeEvent(info)) return;
      const runtime = rememberSessionInfo(info);
      clearAutoReconnect(payload.oldSessionId);
      userClosing.current.delete(payload.oldSessionId);
      disposeTerminalRef.current(payload.oldSessionId);
      // This renderer showed the old tab as reconnecting and it is gone now:
      // the user closed it while the backend owned the reconnect. Honor the
      // close instead of resurrecting the tab, and disconnect the replacement
      // unless another tab already claimed it. Without that recoveringTabs
      // record the old id never had a tab here — a renderer reload, most
      // likely — and the session must stay visible.
      if (recoveringTabs.current.delete(payload.oldSessionId)
        && !tabsRef.current.some((tab) => tab.id === payload.oldSessionId)
        && !tabsRef.current.some((tab) => tab.id === info.id)) {
        void Disconnect(info.id).catch(() => undefined);
        return;
      }
      const profile = profilesRef.current.find((item) => item.id === info.profileId);
      setTabs((items) => {
        const oldTab = items.find((tab) => tab.id === payload.oldSessionId);
        const replaced = replaceSessionTabs(items, payload.oldSessionId, info, tabTitle(profile, info.name));
        if (!oldTab) {
          return [...replaced, {
            id: info.id, ...runtime, profileId: info.profileId, title: tabTitle(profile, info.name), state: info.state,
          }];
        }
        return replaced;
      });
      setActiveTabState((current) => current === payload.oldSessionId ? info.id : current);
    });
    return () => {
      offConnecting(); offConnected(); offDisconnected(); offError(); offCliSession(); offCliSessionRecovering(); offCliSessionReplaced();
    };
  }, [acceptRuntimeEvent, clearAutoReconnect, rememberSessionInfo, finishFocusRequest, setActiveTab]);

  // A renderer reload should not make still-running backend sessions vanish.
  // Hydrate the tab strip from the authoritative managers, while merging with
  // any CLI/session events that arrived during startup.
  useEffect(() => {
    let cancelled = false;
    ListSessions().then((items) => {
      if (cancelled || !items?.length) return;
      setTabs((current) => {
        const byID = new Map(current.map((tab) => [tab.id, tab]));
        for (const info of items) {
          if (!info?.id) continue;
          const profile = profilesRef.current.find((item) => item.id === info.profileId) || quickProfiles.current.get(info.profileId);
          const prior = byID.get(info.id);
          const runtime = rememberSessionInfo(info);
          byID.set(info.id, {
            ...(prior || {}),
            id: info.id,
            ...runtime,
            profileId: info.profileId || "",
            title: prior?.title || tabTitle(profile, info.name),
            state: info.state,
            local: !info.profileId,
            type: !info.profileId ? "local" : "ssh",
            error: info.error || undefined,
          });
        }
        return Array.from(byID.values());
      });
      setActiveTabState((current) => current || items[0]?.id || "");
    }).catch((err) => notifyRef.current(String(err), "error"))
      .finally(() => { if (!cancelled) setSessionsHydrated(true); });
    return () => { cancelled = true; };
  }, [rememberSessionInfo]);

  const appendSession = useCallback(async (profile: types.Profile, info: types.SessionInfo, sessionOptions: SessionOpenOptions = {}) => {
    const runtime = rememberSessionInfo(info);
    const key = terminalKey(profile.id, info.instanceId);
    const restore = pendingRestoreMetadata.current.get(key);
    pendingRestoreMetadata.current.delete(key);
    setTabs((items) => items.some((tab) => tab.id === info.id)
      ? items.map((tab) => tab.id === info.id ? { ...tab, ...runtime, profileId: info.profileId, title: restore?.customTitle ? restore.title : (tab.customTitle ? tab.title : tabTitle(profile, info.name)), customTitle: restore?.customTitle || tab.customTitle, pinned: restore?.pinned || tab.pinned, state: info.state, error: undefined } : tab)
      : [...items, { id: info.id, ...runtime, profileId: info.profileId, title: restore?.customTitle ? restore.title : tabTitle(profile, info.name), customTitle: restore?.customTitle, pinned: restore?.pinned, state: info.state }]);
    if (sessionOptions.preserveActiveTab) setActiveTabState((current) => current || info.id);
    else if (sessionOptions.focusRevision !== undefined) finishFocusRequest(info.id, sessionOptions.focusRevision);
    else setActiveTab(info.id);
    if (restore?.closedRecord) {
      const index = closedTabs.current.indexOf(restore.closedRecord);
      if (index >= 0) closedTabs.current.splice(index, 1);
      setClosedTabCount(closedTabs.current.length);
    }
    await reloadRef.current();
  }, [rememberSessionInfo, finishFocusRequest, setActiveTab]);

  // A reconnect can finish after the user closes its old tab. Do not leave the
  // newly-created backend session running without a renderer owner. If the new
  // id is already represented by another tab, that tab owns the session and it
  // must not be disconnected here.
  const discardUnclaimedSession = useCallback((oldID: string, info: types.SessionInfo) => {
    const currentTabs = tabsRef.current;
    if (currentTabs.some((item) => item.id === oldID)) return true;
    if (info.id && !currentTabs.some((item) => item.id === info.id) && !creatingProfiles.current.has(terminalKey(info.profileId, info.instanceId))) {
      void Disconnect(info.id).catch(() => undefined);
    }
    return false;
  }, []);

  const openSession = useCallback(async (profile: types.Profile, password: string, passphrase: string, sessionOptions: SessionOpenOptions = {}) => {
    const request = { ...sessionOptions, focusRevision: sessionOptions.preserveActiveTab ? undefined : sessionOptions.focusRevision ?? beginFocusRequest() };
    const key = terminalKey(profile.id, request.instanceId);
    notifyRef.current(`Connecting to ${profile.name || profile.host}...`, "info");
    creatingProfiles.current.add(key);
    if (sessionOptions.preserveActiveTab) preserveFocusProfiles.current.add(key);
    if (request.focusRevision !== undefined) connectionFocus.current.set(key, request.focusRevision);
    try {
      const info = request.instanceId
        ? await ConnectTerminal(profile.id, request.instanceId, password, passphrase, 120, 36)
        : profile.rememberPassword
        ? await Connect(profile.id, 120, 36)
        : await ConnectWithSecrets(profile.id, password, passphrase, 120, 36);
      await appendSession(profile, info, request);
      return info.id;
    } finally {
      creatingProfiles.current.delete(key);
      preserveFocusProfiles.current.delete(key);
      connectionFocus.current.delete(key);
    }
  }, [appendSession, beginFocusRequest]);

  const connectWorkspaceProfile = useCallback(async (profile: types.Profile, password = "", passphrase = "", instanceId = "") => {
    const existing = tabsRef.current.find((tab) => tab.type !== "markdown" && sameTerminal(tab, profile.id, instanceId) && isSessionBusy(tab.state));
    if (existing) return existing.id;
    if (creatingProfiles.current.has(terminalKey(profile.id, instanceId))) throw new Error("Connection already in progress");
    return openSession(profile, password, passphrase, { preserveActiveTab: true, instanceId });
  }, [openSession]);

  const connectProfile = useCallback(async (profile: types.Profile, sessionOptions: SessionOpenOptions = {}) => {
    if (creatingProfiles.current.has(terminalKey(profile.id, sessionOptions.instanceId))) {
      notifyRef.current(`${profile.name || profile.host}: connection already in progress`, "info");
      return;
    }
    const existing = tabsRef.current.find((tab) => tab.type !== "markdown" && sameTerminal(tab, profile.id, sessionOptions.instanceId) && isSessionBusy(tab.state));
    if (existing) {
      if (!sessionOptions.preserveActiveTab) setActiveTab(existing.id);
      notifyRef.current(existing.state !== "connected"
        ? `${existing.title}: connection already in progress`
        : `${existing.title}: already connected`, "info");
      return;
    }
    if (needsSecret(profile)) {
      setSecretRequest({ profile, mode: "connect", instanceId: sessionOptions.instanceId });
      return;
    }
    try {
      await openSession(profile, "", "", sessionOptions);
    } catch (err) {
      // The backend also emits terminal:error after a low-level SSH failure,
      // which updates the optimistic tab. This catch closes the Promise path
      // for failures that happen before a session id exists (profile/secrets,
      // rate limiting, etc.) instead of leaving an unhandled rejection.
      const eventAt = recentConnectionErrorProfiles.current.get(profile.id) || 0;
      const alreadySurfaced = Date.now() - eventAt < 2000;
      recentConnectionErrorProfiles.current.delete(profile.id);
      if (!alreadySurfaced && !String(err).toLowerCase().includes("connection cancelled")) {
        notifyRef.current(`${profile.name || profile.host}: ${String(err)}`, "error");
      }
    }
  }, [openSession, setActiveTab]);

  useEffect(() => {
    if (!sessionsHydrated || workspaceRestoreStarted.current || options.restoreWorkspace === undefined) return;
    if (!options.restoreWorkspace) {
      workspaceRestoreStarted.current = true;
      try {
        localStorage.removeItem("gx:workspaceProfiles");
        localStorage.removeItem("gx:workspaceActiveProfile");
      } catch {}
      setWorkspaceRestoreReady(true);
      return;
    }
    workspaceRestoreStarted.current = true;
    const matched = workspaceProfiles.current.items.flatMap((item) => {
      const profile = options.profiles.find((profile) => profile.id === item.profileId);
      return profile ? [{ profile, instanceId: item.instanceId }] : [];
    });
    const alreadyLive = new Set(tabsRef.current
      .filter((tab) => tab.type !== "markdown" && isSessionBusy(tab.state))
      .map((tab) => terminalKey(tab.profileId, tab.instanceId)));
    const pending = matched.filter((item) => !alreadyLive.has(terminalKey(item.profile.id, item.instanceId)));
    const restorable = pending.filter((item) => !needsSecret(item.profile));
    const skipped = pending.length - restorable.length;
    const zh = options.language === "zh-CN";
    if (skipped > 0) {
      notifyRef.current(zh ? `${skipped} 个工作区连接需要重新输入凭据，未自动恢复` : `${skipped} workspace connection${skipped === 1 ? "" : "s"} need credentials and were not restored`, "info");
    }
    if (restorable.length > 0) {
      notifyRef.current(zh ? `正在恢复 ${restorable.length} 个工作区连接` : `Restoring ${restorable.length} workspace connection${restorable.length === 1 ? "" : "s"}`, "info");
    }
    restoreProfilesInBatches(restorable, (item) => connectProfile(item.profile, { preserveActiveTab: true, instanceId: item.instanceId })).finally(() => {
      pendingWorkspaceActiveProfile.current = workspaceProfiles.current.activeProfileId;
      setWorkspaceRestoreReady(true);
    });
  }, [connectProfile, options.language, options.profiles, options.restoreWorkspace, sessionsHydrated]);

  useEffect(() => {
    if (!workspaceRestoreReady || !pendingWorkspaceActiveProfile.current) return;
    // Read committed tabs. A zero-delay timer can beat React's batched updates
    // and miss the saved session, leaving the first restored tab selected.
    const activeProfileId = pendingWorkspaceActiveProfile.current;
    pendingWorkspaceActiveProfile.current = "";
    const restoredActive = tabs.find((tab) => tab.type !== "markdown" && terminalKey(tab.profileId, tab.instanceId) === activeProfileId && tab.state === "connected");
    if (restoredActive) restoreActiveTab(restoredActive.id);
  }, [workspaceRestoreReady, tabs, restoreActiveTab]);

  useEffect(() => {
    if (!workspaceRestoreReady || options.restoreWorkspace !== true) return;
    const savedProfiles = new Set(options.profiles.map((profile) => profile.id));
    const open = tabs.filter((tab) => tab.type !== "markdown" && !tab.local && savedProfiles.has(tab.profileId) && isSessionBusy(tab.state));
    const ids = open.map((tab) => tab.instanceId ? { profileId: tab.profileId, instanceId: tab.instanceId } : tab.profileId);
    const active = open.find((tab) => tab.id === activeTab);
    try {
      localStorage.setItem("gx:workspaceProfiles", JSON.stringify(ids));
      localStorage.setItem("gx:workspaceActiveProfile", active ? terminalKey(active.profileId, active.instanceId) : "");
    } catch {}
  }, [activeTab, options.profiles, options.restoreWorkspace, tabs, workspaceRestoreReady]);

  const connectProfileWithSecrets = useCallback(async (profile: types.Profile, password: string, passphrase: string, instanceId = "") => {
    if (creatingProfiles.current.has(terminalKey(profile.id, instanceId))) return;
    const existing = tabsRef.current.find((tab) => tab.type !== "markdown" && sameTerminal(tab, profile.id, instanceId) && isSessionBusy(tab.state));
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    await openSession(profile, password, passphrase, { instanceId });
  }, [openSession, setActiveTab]);

  const connectQuick = useCallback(async (input: types.Profile) => {
    const revision = beginFocusRequest();
    const profile = new types.Profile({
      ...input,
      id: input.id && input.id.startsWith("quick-") ? input.id : `quick-${crypto.randomUUID()}`,
      rememberPassword: false,
    });
    quickProfiles.current.set(profile.id, profile);
    const staleTab = tabsRef.current.find((tab) => tab.type !== "markdown" && tab.profileId === profile.id && (tab.state === "error" || tab.state === "disconnected"));
    if (!staleTab) creatingProfiles.current.add(profile.id);
    connectionFocus.current.set(profile.id, revision);
    notifyRef.current(`Connecting to ${profile.name || profile.host}...`, "info");
    try {
      const info = await ConnectQuick(profile, 120, 36);
      rememberSessionInfo(info);
      if (staleTab) {
        disposeTerminalRef.current(staleTab.id);
        setTabs((items) => replaceSessionTabs(items, staleTab.id, info, tabTitle(profile, info.name)));
        finishFocusRequest(info.id, revision);
      } else {
        await appendSession(profile, info, { focusRevision: revision });
      }
    } finally {
      creatingProfiles.current.delete(profile.id);
      connectionFocus.current.delete(profile.id);
    }
  }, [appendSession, rememberSessionInfo, beginFocusRequest, finishFocusRequest]);

  const replaceReconnectedTab = useCallback((oldID: string, info: types.SessionInfo) => {
    // A reconnect answered with the same session id means the backend reused a
    // healthy transport. Tearing the xterm down in that case would throw away
    // the scrollback of a connection that never actually changed.
    if (!discardUnclaimedSession(oldID, info)) return false;
    if (oldID !== info.id) disposeTerminalRef.current(oldID);
    const profile = profilesRef.current.find((item) => item.id === info.profileId);
    rememberSessionInfo(info);
    setTabs((items) => {
      // A concurrent CLI attach can already represent info.id — the backend
      // reuses a healthy session for the same profile. Drop that tab rather
      // than producing two tabs with one session id: the survivor adopts the
      // session's terminal, which is keyed by id.
      return replaceSessionTabs(items, oldID, info, tabTitle(profile, info.name));
    });
    setActiveTabState((current) => current === oldID ? info.id : current);
    return true;
  }, [discardUnclaimedSession, rememberSessionInfo]);

  const connectLocal = useCallback(async () => {
    const revision = beginFocusRequest();
    notifyRef.current("Opening local terminal...", "info");
    const info = await ConnectLocal(120, 36);
    const runtime = rememberSessionInfo(info);
    setTabs((items) => [...items, { id: info.id, ...runtime, profileId: "", title: info.name || "Local Terminal", state: info.state, local: true }]);
    finishFocusRequest(info.id, revision);
  }, [rememberSessionInfo, beginFocusRequest, finishFocusRequest]);

  const reopenClosedTab = useCallback(async () => {
    const record = closedTabs.current[0];
    if (!record) return false;
    const revision = beginFocusRequest();
    const tab = record.tab;
    if (tab.local) {
      try {
        const info = await ConnectLocal(120, 36);
        const runtime = rememberSessionInfo(info);
        setTabs((items) => [...items, { id: info.id, ...runtime, profileId: "", title: tab.customTitle ? tab.title : (info.name || "Local Terminal"), customTitle: tab.customTitle, pinned: tab.pinned, state: info.state, local: true }]);
        finishFocusRequest(info.id, revision);
        const index = closedTabs.current.indexOf(record);
        if (index >= 0) closedTabs.current.splice(index, 1);
        setClosedTabCount(closedTabs.current.length);
        return true;
      } catch (err) {
        notifyRef.current(String(err), "error");
        return false;
      }
    }

    const profile = profilesRef.current.find((item) => item.id === tab.profileId);
    const quickProfile = record.quickProfile;
    if (!profile && !quickProfile) {
      notifyRef.current("The closed connection profile is no longer available", "error");
      return false;
    }
    const target = quickProfile || profile!;
    pendingRestoreMetadata.current.set(terminalKey(target.id, tab.instanceId), { title: tab.title, customTitle: tab.customTitle, pinned: tab.pinned, closedRecord: record });
    if (quickProfile) quickProfiles.current.set(target.id, new types.Profile(quickProfile));
    if (!quickProfile && needsSecret(target)) {
      setSecretRequest({ profile: target, mode: "connect", instanceId: tab.instanceId });
      return true;
    }
    try {
      if (quickProfile) {
        const info = await ConnectQuick(target, 120, 36);
        await appendSession(target, info, { focusRevision: revision });
      } else {
        await openSession(target, "", "", { focusRevision: revision, instanceId: tab.instanceId });
      }
      return true;
    } catch (err) {
      pendingRestoreMetadata.current.delete(terminalKey(target.id, tab.instanceId));
      notifyRef.current(String(err), "error");
      return false;
    }
  }, [appendSession, openSession, rememberSessionInfo, beginFocusRequest, finishFocusRequest]);

  const reconnectTab = useCallback(async (tab: Tab) => {
    setActiveTab(tab.id);
    // A manual reconnect supersedes any pending auto-reconnect for this tab.
    clearAutoReconnect(tab.id);
    if (tab.local) {
      await connectLocal();
      return;
    }
    const quickProfile = quickProfiles.current.get(tab.profileId);
    if (quickProfile) {
      notifyRef.current(`Reconnecting to ${tab.title}...`, "info");
      setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, state: "reconnecting", error: undefined } : item));
      try {
        // Drop the current transport first. The backend hands a caller the
        // existing session while one is still healthy for this profile, so
        // reconnecting without disconnecting would come back with the same
        // session and only replay its post-connect actions. The saved-profile
        // path below gets this for free from the backend's Reconnect.
        userClosing.current.add(tab.id);
        try {
          await Disconnect(tab.id);
        } catch {
          // Already gone; the connect below is exactly the right recovery.
        }
        const info = await ConnectQuick(quickProfile, 120, 36);
        userClosing.current.delete(tab.id);
        replaceReconnectedTab(tab.id, info);
      } catch (err) {
        userClosing.current.delete(tab.id);
        const message = String(err);
        setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, state: "error", error: message } : item));
        notifyRef.current(`${tab.title}: reconnect failed: ${message}`, "error");
      }
      return;
    }
    const profile = profilesRef.current.find((item) => item.id === tab.profileId);
    if (profile && needsSecret(profile)) {
      setSecretRequest({ profile, mode: "reconnect", sessionId: tab.id, instanceId: tab.instanceId });
      return;
    }
    notifyRef.current(`Reconnecting to ${tab.title}...`, "info");
    setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, state: "reconnecting", error: undefined } : item));
    try {
      let info: types.SessionInfo;
      try {
        userClosing.current.add(tab.id);
        info = await Reconnect(tab.id);
      } catch (err) {
        userClosing.current.delete(tab.id);
        if (!isSessionNotFoundError(err)) throw err;
        info = tab.instanceId
          ? await ConnectTerminal(tab.profileId, tab.instanceId, "", "", 120, 36)
          : await Connect(profile?.id || tab.profileId, 120, 36);
      }
      userClosing.current.delete(tab.id);
      replaceReconnectedTab(tab.id, info);
      await reloadRef.current();
    } catch (err) {
      userClosing.current.delete(tab.id);
      const message = String(err);
      setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, state: "error", error: message } : item));
      notifyRef.current(`${tab.title}: reconnect failed: ${message}`, "error");
    }
  }, [connectLocal, replaceReconnectedTab, clearAutoReconnect, setActiveTab]);

  const submitSecret = useCallback(async (request: SecretRequest, password: string, passphrase: string) => {
    if (request.mode === "connect") {
      await openSession(request.profile, password, passphrase, { instanceId: request.instanceId });
      return;
    }
    if (!request.sessionId) return;
    setActiveTab(request.sessionId);
    try {
      let info: types.SessionInfo;
      try {
        userClosing.current.add(request.sessionId);
        info = await ReconnectWithSecrets(request.sessionId, password, passphrase);
      } catch (err) {
        userClosing.current.delete(request.sessionId);
        if (!isSessionNotFoundError(err)) throw err;
        info = request.instanceId
          ? await ConnectTerminal(request.profile.id, request.instanceId, password, passphrase, 120, 36)
          : await ConnectWithSecrets(request.profile.id, password, passphrase, 120, 36);
      }
      userClosing.current.delete(request.sessionId);
      replaceReconnectedTab(request.sessionId, info);
      await reloadRef.current();
    } catch (err) {
      userClosing.current.delete(request.sessionId);
      notifyRef.current(`${request.profile.name || request.profile.host}: reconnect failed: ${String(err)}`, "error");
	  throw err;
    }
  }, [openSession, replaceReconnectedTab, setActiveTab]);

  const cancelSecretRequest = useCallback(() => {
    const request = secretRequest;
    if (request?.mode === "connect") {
      pendingRestoreMetadata.current.delete(terminalKey(request.profile.id, request.instanceId));
    }
    setSecretRequest(null);
  }, [secretRequest]);

  // scheduleAutoReconnect fires when a session drops unexpectedly (disconnect or
  // error event). It only acts when the owning profile opted into AutoReconnect
  // and the tab still exists and was not closed by the user. Reconnect goes
  // through Connect(profile) — not Reconnect(oldId) — because the backend has
  // already removed the dropped session, so the old id no longer resolves. On
  // success the tab id is replaced in place, preserving tab order. Backoff is
  // 3s / 6s / 12s with a hard cap of 3 attempts; a successful reconnect resets
  // the counter via the terminal:connected handler path.
  const AUTO_RECONNECT_MAX = 3;
  const autoReconnectBackoffMs = (attempt: number) => 3000 * Math.pow(2, attempt);

  const scheduleAutoReconnect = useCallback((tabId: string) => {
    if (userClosing.current.has(tabId)) {
      userClosing.current.delete(tabId);
      return;
    }
    // A single drop can surface as both terminal:error and terminal:disconnected.
    // If a reconnect timer is already pending for this tab, do not schedule a
    // second one — that would double-Connect and race two id replacements. The
    // failed-attempt path stores timer: 0, so retries are not blocked by this.
    const pending = autoReconnect.current[tabId];
    if (pending?.timer || pending?.inFlight || pending?.gaveUp || navigator.onLine === false) return;
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab || tab.local || tab.type === "markdown") return;
    const profile = profilesRef.current.find((item) => item.id === tab.profileId);
    // Only silently reconnect profiles that can connect without prompting for a
    // secret; anything needing a password is left for the user to reconnect.
    if (!profile || !profile.autoReconnect || needsSecret(profile)) return;

    const prior = autoReconnect.current[tabId]?.attempts ?? 0;
    if (prior >= AUTO_RECONNECT_MAX) {
      autoReconnect.current[tabId] = { attempts: prior, timer: 0, gaveUp: true };
      const message = t(options.language || "en", "autoReconnectGaveUp", { count: String(AUTO_RECONNECT_MAX) });
      setTabs((items) => items.map((item) => item.id === tabId
        ? { ...item, state: "error", error: message }
        : item));
      notifyRef.current(`${tab.title}: ${message}`, "error");
      return;
    }
    const attempt = prior;
    const delay = autoReconnectBackoffMs(attempt);
    setTabs((items) => items.map((item) => item.id === tabId ? { ...item, state: "reconnecting" } : item));
    notifyRef.current(`${tab.title}: ${t(options.language || "en", "autoReconnectAttempt", { attempt: String(attempt + 1), count: String(AUTO_RECONNECT_MAX) })}`, "info");

    const timer = window.setTimeout(async () => {
      const attemptState = autoReconnect.current[tabId];
      if (!attemptState) return;
      attemptState.timer = 0;
      // The tab may have been closed while we waited.
      const currentTab = tabsRef.current.find((item) => item.id === tabId);
      const currentProfile = profilesRef.current.find((item) => item.id === tab.profileId);
      if (!currentTab || currentTab.state === "connected" || !currentProfile || !currentProfile.autoReconnect || needsSecret(currentProfile)) {
        clearAutoReconnect(tabId);
        setTabs((items) => items.map((item) => item.id === tabId && item.state === "reconnecting" ? { ...item, state: "disconnected" } : item));
        return;
      }
      if (navigator.onLine === false) {
        // A timer that never started a connection does not consume an attempt.
        setTabs((items) => items.map((item) => item.id === tabId ? { ...item, state: "disconnected" } : item));
        return;
      }
      attemptState.inFlight = true;
      attemptState.attempts = attempt + 1;
      try {
        disposeTerminalRef.current(tabId);
        const info = tab.instanceId
          ? await ConnectTerminal(currentProfile.id, tab.instanceId, "", "", 120, 36)
          : await Connect(currentProfile.id, 120, 36);
        if (autoReconnect.current[tabId] !== attemptState) {
          // A closing tab stays mounted during backend cleanup, but can no
          // longer claim the replacement. Other consumers may still own it.
          const owned = tabsRef.current.some((item) => item.id === info.id || (!attemptState.cancelledByClose && item.id === tabId));
          if (!owned && !creatingProfiles.current.has(terminalKey(info.profileId, info.instanceId))) void Disconnect(info.id).catch(() => undefined);
          return;
        }
        if (!discardUnclaimedSession(tabId, info)) {
          clearAutoReconnect(tabId);
          return;
        }
        // Replace the old tab id in place so ordering and active state persist.
        rememberSessionInfo(info);
        // The same-session-id dedupe as replaceReconnectedTab: a concurrent CLI
        // attach may already show info.id on the strip.
        setTabs((items) => {
          return replaceSessionTabs(items, tabId, info, tabTitle(currentProfile, info.name));
        });
        setActiveTabState((current) => current === tabId ? info.id : current);
        clearAutoReconnect(tabId);
        await reloadRef.current();
      } catch (err) {
        if (autoReconnect.current[tabId] !== attemptState || !tabsRef.current.some((item) => item.id === tabId)) return;
        // Keep failures eligible for the online/visibility retry path when the
        // network disappears during the request and no new timer can start.
        setTabs((items) => items.map((item) => item.id === tabId
          ? { ...item, state: "error", error: String(err) }
          : item));
        autoReconnect.current[tabId] = { attempts: attempt + 1, timer: 0 };
        scheduleAutoReconnectRef.current(tabId);
      }
    }, delay);

    autoReconnect.current[tabId] = { attempts: attempt, timer };
  }, [clearAutoReconnect, discardUnclaimedSession, rememberSessionInfo, options.language]);

  scheduleAutoReconnectRef.current = scheduleAutoReconnect;

  useEffect(() => {
    const reconnects = autoReconnect.current;
    const retry = () => {
      if (navigator.onLine === false || document.visibilityState === "hidden") return;
      for (const tab of tabsRef.current) {
        if (tab.local || tab.type === "markdown" || !["error", "disconnected"].includes(tab.state)) continue;
        if (autoReconnect.current[tab.id]?.inFlight || autoReconnect.current[tab.id]?.gaveUp) continue;
        scheduleAutoReconnectRef.current(tab.id);
      }
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
      Object.keys(reconnects).forEach(clearAutoReconnect);
    };
  }, [clearAutoReconnect]);

  const reorderTabs = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setTabs((items) => {
      const from = items.findIndex((tab) => tab.id === draggedId);
      const to = items.findIndex((tab) => tab.id === targetId);
      if (from < 0 || to < 0 || from === to) return items;
      if (!!items[from].pinned !== !!items[to].pinned) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const beforeCloseTab = options.beforeCloseTab;
  const closeTab = useCallback(async (id: string, skipConfirm = false) => {
    const tab = tabs.find((item) => item.id === id);
    const isMarkdown = tab?.type === "markdown";
    if (!skipConfirm && tab && beforeCloseTab && !(await beforeCloseTab(tab))) {
      return;
    }
    if (tab && tab.type !== "markdown") {
      const quickProfile = tab.profileId ? quickProfiles.current.get(tab.profileId) : undefined;
      closedTabs.current = [{ tab: { ...tab }, quickProfile: quickProfile ? new types.Profile(quickProfile) : undefined }, ...closedTabs.current].slice(0, 20);
      setClosedTabCount(closedTabs.current.length);
    }
    // Mark this id as intentionally closing so the resulting
    // terminal:disconnected event does not schedule an auto-reconnect, and
    // cancel any reconnect already pending for it.
    userClosing.current.add(id);
    const pending = autoReconnect.current[id];
    if (pending) {
      pending.cancelledByClose = true;
      window.clearTimeout(pending.timer);
      delete autoReconnect.current[id];
    }
    if (!isMarkdown) {
      await StopMonitor(id).catch(() => undefined);
      await Disconnect(id).catch(() => undefined);
      disposeTerminalRef.current(id);
    }
    if (tab?.profileId && quickProfiles.current.has(tab.profileId)) {
      const otherQuickTab = tabsRef.current.some((item) => item.id !== id && item.profileId === tab.profileId);
      if (!otherQuickTab) quickProfiles.current.delete(tab.profileId);
    }
    setTabs((items) => {
      const closingIndex = items.findIndex((tab) => tab.id === id);
      const next = items.filter((tab) => tab.id !== id);
      if (activeTabRef.current === id) {
        const neighborIndex = Math.max(0, Math.min(closingIndex, next.length - 1));
        setActiveTab(next[neighborIndex]?.id || "");
      }
      return next;
    });
  }, [beforeCloseTab, tabs, setActiveTab]);

  return {
    tabs,
    setTabs,
    activeTab,
    active,
    setActiveTab,
    restoreActiveTab,
    beginFocusRequest,
    isFocusRequestCurrent,
    finishFocusRequest,
    secretRequest,
    setSecretRequest,
    cancelSecretRequest,
    connectProfile,
    connectWorkspaceProfile,
    connectProfileWithSecrets,
    connectQuick,
    connectLocal,
    reconnectTab,
    reorderTabs,
    submitSecret,
    closeTab,
    isCurrentRuntimeEvent: acceptRuntimeEvent,
    reopenClosedTab,
    closedTabCount,
  };
}
