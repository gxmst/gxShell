import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { Connect, ConnectWithSecrets, ConnectLocal, Disconnect, Reconnect, ReconnectWithSecrets, StartMonitor, StopMonitor } from "../../wailsjs/go/main/App";
import { types } from "../../wailsjs/go/models";
import type { SecretRequest, Tab } from "../types";
import { needsSecret, tabTitle } from "../utils/format";

type UseSessionsOptions = {
  profiles: types.Profile[];
  notify: (text: string, tone?: "info" | "error" | "success") => void;
  reload: () => Promise<void>;
  disposeTerminal: (id: string) => void;
  confirmOnDisconnect?: boolean;
};

export function useSessions(options: UseSessionsOptions) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState("");
  const [secretRequest, setSecretRequest] = useState<SecretRequest | null>(null);

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

  // Auto-reconnect bookkeeping. Keyed by the tab id that owned the session that
  // dropped. userClosing marks ids the user is intentionally closing so their
  // disconnect does not trigger a reconnect.
  const autoReconnect = useRef<Record<string, { attempts: number; timer: number }>>({});
  const userClosing = useRef<Set<string>>(new Set());
  const scheduleAutoReconnectRef = useRef<(tabId: string) => void>(() => undefined);

  const clearAutoReconnect = useCallback((tabId: string) => {
    const entry = autoReconnect.current[tabId];
    if (entry) {
      window.clearTimeout(entry.timer);
      delete autoReconnect.current[tabId];
    }
  }, []);

  useEffect(() => {
    const offConnected = EventsOn("terminal:connected", (info: types.SessionInfo) => {
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, state: "connected" } : tab));
      notifyRef.current(`${info.name} connected`, "success");
      StartMonitor(info.id).catch(() => undefined);
    });
    const offDisconnected = EventsOn("terminal:disconnected", (info: types.SessionInfo) => {
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, state: "disconnected" } : tab));
      scheduleAutoReconnectRef.current(info.id);
    });
    const offError = EventsOn("terminal:error", (payload: { sessionId: string; error: string }) => {
      setTabs((items) => items.map((tab) => tab.id === payload.sessionId ? { ...tab, state: "error", error: payload.error } : tab));
      notifyRef.current(payload.error, "error");
      scheduleAutoReconnectRef.current(payload.sessionId);
    });
    return () => {
      offConnected(); offDisconnected(); offError();
    };
  }, []);

  const appendSession = useCallback(async (profile: types.Profile, info: types.SessionInfo) => {
    setTabs((items) => [...items, { id: info.id, profileId: info.profileId, title: tabTitle(profile, info.name), state: info.state }]);
    setActiveTab(info.id);
    await reloadRef.current();
  }, []);

  const openSession = useCallback(async (profile: types.Profile, password: string, passphrase: string) => {
    notifyRef.current(`Connecting to ${profile.name || profile.host}...`, "info");
    const info = profile.rememberPassword
      ? await Connect(profile.id, 120, 36)
      : await ConnectWithSecrets(profile.id, password, passphrase, 120, 36);
    await appendSession(profile, info);
  }, [appendSession]);

  const connectProfile = useCallback(async (profile: types.Profile) => {
    if (needsSecret(profile)) {
      setSecretRequest({ profile, mode: "connect" });
      return;
    }
    await openSession(profile, "", "");
  }, [openSession]);

  const replaceReconnectedTab = useCallback((oldID: string, info: types.SessionInfo) => {
    disposeTerminalRef.current(oldID);
    const profile = profilesRef.current.find((item) => item.id === info.profileId);
    setTabs((items) => items.map((tab) => tab.id === oldID ? { ...tab, id: info.id, title: tabTitle(profile, info.name), state: info.state } : tab));
    setActiveTab(info.id);
  }, []);

  const connectLocal = useCallback(async () => {
    notifyRef.current("Opening local terminal...", "info");
    const info = await ConnectLocal(120, 36);
    setTabs((items) => [...items, { id: info.id, profileId: "", title: info.name || "Local Terminal", state: info.state, local: true }]);
    setActiveTab(info.id);
  }, []);

  const reconnectTab = useCallback(async (tab: Tab) => {
    // A manual reconnect supersedes any pending auto-reconnect for this tab.
    clearAutoReconnect(tab.id);
    if (tab.local) {
      await connectLocal();
      return;
    }
    const profile = profilesRef.current.find((item) => item.id === tab.profileId);
    if (profile && needsSecret(profile)) {
      setSecretRequest({ profile, mode: "reconnect", sessionId: tab.id });
      return;
    }
    notifyRef.current(`Reconnecting to ${tab.title}...`, "info");
    const info = await Reconnect(tab.id);
    replaceReconnectedTab(tab.id, info);
  }, [connectLocal, replaceReconnectedTab, clearAutoReconnect]);

  const submitSecret = useCallback(async (request: SecretRequest, password: string, passphrase: string) => {
    if (request.mode === "connect") {
      await openSession(request.profile, password, passphrase);
      return;
    }
    if (!request.sessionId) return;
    const info = await ReconnectWithSecrets(request.sessionId, password, passphrase);
    replaceReconnectedTab(request.sessionId, info);
  }, [openSession, replaceReconnectedTab]);

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
    if (autoReconnect.current[tabId]?.timer) return;
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab || tab.local || tab.type === "markdown") return;
    const profile = profilesRef.current.find((item) => item.id === tab.profileId);
    // Only silently reconnect profiles that can connect without prompting for a
    // secret; anything needing a password is left for the user to reconnect.
    if (!profile || !profile.autoReconnect || needsSecret(profile)) return;

    const prior = autoReconnect.current[tabId]?.attempts ?? 0;
    if (prior >= AUTO_RECONNECT_MAX) {
      clearAutoReconnect(tabId);
      notifyRef.current(`${tab.title}: auto-reconnect gave up after ${AUTO_RECONNECT_MAX} attempts`, "error");
      return;
    }
    const attempt = prior;
    const delay = autoReconnectBackoffMs(attempt);
    setTabs((items) => items.map((item) => item.id === tabId ? { ...item, state: "connecting" } : item));
    notifyRef.current(`${tab.title}: reconnecting (attempt ${attempt + 1}/${AUTO_RECONNECT_MAX})...`, "info");

    const timer = window.setTimeout(async () => {
      // The tab may have been closed while we waited.
      if (!tabsRef.current.some((item) => item.id === tabId)) {
        clearAutoReconnect(tabId);
        return;
      }
      try {
        disposeTerminalRef.current(tabId);
        const info = await Connect(profile.id, 120, 36);
        // Replace the old tab id in place so ordering and active state persist.
        setTabs((items) => items.map((item) => item.id === tabId
          ? { ...item, id: info.id, title: tabTitle(profile, info.name), state: info.state }
          : item));
        setActiveTab((current) => current === tabId ? info.id : current);
        clearAutoReconnect(tabId);
        await reloadRef.current();
      } catch {
        // Record the failed attempt and let the resulting disconnect/error event
        // reschedule with the next backoff step.
        autoReconnect.current[tabId] = { attempts: attempt + 1, timer: 0 };
        scheduleAutoReconnectRef.current(tabId);
      }
    }, delay);

    autoReconnect.current[tabId] = { attempts: attempt + 1, timer };
  }, [clearAutoReconnect]);

  scheduleAutoReconnectRef.current = scheduleAutoReconnect;

  const reorderTabs = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setTabs((items) => {
      const from = items.findIndex((tab) => tab.id === draggedId);
      const to = items.findIndex((tab) => tab.id === targetId);
      if (from < 0 || to < 0 || from === to) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const closeTab = useCallback(async (id: string, skipConfirm = false) => {
    const tab = tabs.find((item) => item.id === id);
    const isMarkdown = tab?.type === "markdown";
    if (!skipConfirm && options.confirmOnDisconnect && !tab?.local && !isMarkdown) {
      const shouldClose = window.confirm("Are you sure you want to disconnect?");
      if (!shouldClose) return;
    }
    // Mark this id as intentionally closing so the resulting
    // terminal:disconnected event does not schedule an auto-reconnect, and
    // cancel any reconnect already pending for it.
    userClosing.current.add(id);
    const pending = autoReconnect.current[id];
    if (pending) {
      window.clearTimeout(pending.timer);
      delete autoReconnect.current[id];
    }
    if (!isMarkdown) {
      await StopMonitor(id).catch(() => undefined);
      await Disconnect(id).catch(() => undefined);
      disposeTerminalRef.current(id);
    }
    setTabs((items) => {
      const next = items.filter((tab) => tab.id !== id);
      if (activeTabRef.current === id) setActiveTab(next[0]?.id || "");
      return next;
    });
  }, [options.confirmOnDisconnect, tabs]);

  return {
    tabs,
    setTabs,
    activeTab,
    active,
    setActiveTab,
    secretRequest,
    setSecretRequest,
    connectProfile,
    connectLocal,
    reconnectTab,
    reorderTabs,
    submitSecret,
    closeTab
  };
}
