import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { Connect, ConnectWithSecrets, Disconnect, Reconnect, ReconnectWithSecrets, StartMonitor, StopMonitor } from "../../wailsjs/go/main/App";
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

  useEffect(() => {
    const offConnected = EventsOn("terminal:connected", (info: types.SessionInfo) => {
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, state: "connected" } : tab));
      notifyRef.current(`${info.name} connected`, "success");
      StartMonitor(info.id).catch(() => undefined);
    });
    const offDisconnected = EventsOn("terminal:disconnected", (info: types.SessionInfo) => {
      setTabs((items) => items.map((tab) => tab.id === info.id ? { ...tab, state: "disconnected" } : tab));
    });
    const offError = EventsOn("terminal:error", (payload: { sessionId: string; error: string }) => {
      setTabs((items) => items.map((tab) => tab.id === payload.sessionId ? { ...tab, state: "error", error: payload.error } : tab));
      notifyRef.current(payload.error, "error");
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

  const reconnectTab = useCallback(async (tab: Tab) => {
    const profile = profilesRef.current.find((item) => item.id === tab.profileId);
    if (profile && needsSecret(profile)) {
      setSecretRequest({ profile, mode: "reconnect", sessionId: tab.id });
      return;
    }
    const info = await Reconnect(tab.id);
    replaceReconnectedTab(tab.id, info);
  }, [replaceReconnectedTab]);

  const submitSecret = useCallback(async (request: SecretRequest, password: string, passphrase: string) => {
    if (request.mode === "connect") {
      await openSession(request.profile, password, passphrase);
      return;
    }
    if (!request.sessionId) return;
    const info = await ReconnectWithSecrets(request.sessionId, password, passphrase);
    replaceReconnectedTab(request.sessionId, info);
  }, [openSession, replaceReconnectedTab]);

  const closeTab = useCallback(async (id: string, skipConfirm = false) => {
    if (!skipConfirm && options.confirmOnDisconnect) {
      const shouldClose = window.confirm("Are you sure you want to disconnect?");
      if (!shouldClose) return;
    }
    await StopMonitor(id).catch(() => undefined);
    await Disconnect(id).catch(() => undefined);
    disposeTerminalRef.current(id);
    setTabs((items) => {
      const next = items.filter((tab) => tab.id !== id);
      if (activeTabRef.current === id) setActiveTab(next[0]?.id || "");
      return next;
    });
  }, [options.confirmOnDisconnect]);

  return {
    tabs,
    activeTab,
    active,
    setActiveTab,
    secretRequest,
    setSecretRequest,
    connectProfile,
    reconnectTab,
    submitSecret,
    closeTab
  };
}
