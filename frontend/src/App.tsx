import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { types } from "../wailsjs/go/models";
import { CreateCommand, DeleteCommand, ListCommands, OpenDataDir, SelectPrivateKey, SendCommandToTerminal, StartMonitor, UpdateCommand } from "../wailsjs/go/main/App";
import { emptyProfile } from "./constants";
import type { Drawer } from "./types";
import { normalizeAppTheme } from "./utils/format";
import { useToasts } from "./hooks/useToasts";
import { useProfiles } from "./hooks/useProfiles";
import { useMonitor } from "./hooks/useMonitor";
import { useTerminal } from "./hooks/useTerminal";
import { useSessions } from "./hooks/useSessions";
import { useSftp } from "./hooks/useSftp";
import { useHotkeys } from "./hooks/useHotkeys";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TerminalArea } from "./components/TerminalArea/TerminalArea";
import { ProfileModal } from "./components/modals/ProfileModal";
import { CommandModal } from "./components/modals/CommandModal";
import { SecretModal } from "./components/modals/SecretModal";
import { GlobalSearchModal, TerminalSearchModal } from "./components/modals/SearchModals";
import { ProgressBar } from "./components/ProgressBar/ProgressBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastStack } from "./components/ToastStack";
import { EventsOn } from "../wailsjs/runtime/runtime";

function App() {
  const { toasts, notify } = useToasts();
  const profileState = useProfiles(notify);
  const { metrics } = useMonitor();
  const [drawer, setDrawer] = useState<Drawer>("monitor");
  const [profileModal, setProfileModal] = useState<types.Profile | null>(null);
  const [commandModal, setCommandModal] = useState<types.CommandTemplate | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearch, setTerminalSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{x:number, y:number, items:{label:string, action:()=>void, danger?:boolean}[]} | null>(null);

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

  const activeMetrics = sessions.active ? metrics[sessions.active.id] : undefined;
  const sftp = useSftp(sessions.active, drawer, notify);

  const activeTerminal = useTerminal(sessions.activeTab, profileState.settings, notify, sidebarCollapsed);      
  const { writeOutput, disposeTerminal, findNext, focusTerminal } = activeTerminal;
  terminalBridge.current.disposeTerminal = disposeTerminal;

  useEffect(() => {
    const offData = EventsOn("terminal:data", (payload: { sessionId: string; data: string }) => {
      writeOutput(payload.sessionId, payload.data);
    });
    return () => offData();
  }, [writeOutput]);

  useHotkeys({
    activeTab: sessions.activeTab,
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

  return (
    <ErrorBoundary>
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
          onNewProfile={() => setProfileModal(emptyProfile())}
          onEditProfile={(profile) => setProfileModal(new types.Profile(profile))}
          onConnectProfile={sessions.connectProfile}
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
          onEditCommand={(cmd) => setCommandModal(cmd)}
          onDeleteCommand={async (id) => { await DeleteCommand(id); profileState.setCommands(await ListCommands()); }}
          onNewCommand={() => setCommandModal(new types.CommandTemplate({ id: "", name: "", command: "", category: "Custom", description: "", tags: [] }))}
          onSaveSettings={async (next) => { await profileState.saveSettings(next); notify("Settings saved", "success"); }}
          onOpenData={OpenDataDir}
        />
        <TerminalArea
          tabs={sessions.tabs}
          activeTab={sessions.activeTab}
          profiles={profileState.profiles}
          terminalHosts={activeTerminal.terminalHosts}
          onActive={sessions.setActiveTab}
          onClose={sessions.closeTab}
          onReconnect={sessions.reconnectTab}
          onNewConnection={() => setProfileModal(emptyProfile())}
          onCommandPalette={() => { setGlobalQuery(""); setGlobalSearchOpen(true); }}
          language={profileState.settings?.language || "en"}
        />
      </main>

      {globalSearchOpen && <GlobalSearchModal query={globalQuery} onQuery={setGlobalQuery} results={globalResults} onClose={() => setGlobalSearchOpen(false)} />}
      {terminalSearchOpen && <TerminalSearchModal query={terminalSearch} onQuery={setTerminalSearch} onNext={() => activeTerminal.findNext(sessions.activeTab, terminalSearch)} onClose={() => setTerminalSearchOpen(false)} />}
      {profileModal && <ProfileModal profile={profileModal} onClose={() => setProfileModal(null)} onSave={saveProfile} onPickKey={SelectPrivateKey} onDelete={async (id) => { await profileState.deleteProfile(id); setProfileModal(null); }} onDuplicate={async (id) => { await profileState.duplicateProfile(id); notify("Profile copied. Saved credentials are not copied.", "info"); }} />}
      {commandModal && <CommandModal command={commandModal} onClose={() => setCommandModal(null)} onSave={saveCommand} />}
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
    </ErrorBoundary>
  );
}

export default App;
