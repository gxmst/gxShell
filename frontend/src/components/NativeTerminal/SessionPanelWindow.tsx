import { lazy, useEffect, useState } from "react";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { GetSettings, ListSessions, OpenPanelDocument, OpenSessionPanel, StartMonitor } from "../../../wailsjs/go/app/App";
import type { types } from "../../../wailsjs/go/models";
import type { Tab } from "../../types";
import { useSftp } from "../../hooks/useSftp";
import { TransfersProvider } from "../../hooks/TransfersProvider";
import type { AppContextMenu } from "../../hooks/useTerminal";
import { normalizeAppTheme } from "../../utils/format";
import "./native-terminal.css";

const MonitorPanel = lazy(() => import("../MonitorPanel/MonitorPanel").then(m => ({ default: m.MonitorPanel })));

const SftpPanel = lazy(() => import("../SftpPanel/SftpPanel").then(m => ({ default: m.SftpPanel })));

const TransferCenter = lazy(() => import("../SftpPanel/TransferCenter").then(m => ({ default: m.TransferCenter })));

export function SessionPanelWindow({ id, kind }: { id: string; kind: "sftp" | "monitor" | "transfers" }) {
  const [settings, setSettings] = useState<types.AppSettings | null>(null);
  const [active, setActive] = useState<Tab>();
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<AppContextMenu | null>(null);
  const files = useSftp(active, kind, setNotice);
  useEffect(() => {
    let live = true, revision = 0;
    const update = (session: types.SessionInfo) => {
      if (!live || session.id !== id) return;
      revision++;
      setActive({ id, type: "ssh", title: session.name, profileId: session.profileId, state: session.state, runtimeId: session.runtimeId });
    };
    const off = ["terminal:connected", "terminal:disconnected", "terminal:connecting"].map(event => EventsOn(event, update));
    const failed = (error: unknown) => { if (live) setNotice(String(error)); };
    void ListSessions().then(list => { if (!revision) list.forEach(update); }).catch(failed);
    void GetSettings().then(value => { if (live) setSettings(value); }).catch(failed);
    return () => { live = false; off.forEach(remove => remove()); };
  }, [id]);
  return <div className="app-shell native-session-panel" data-theme={normalizeAppTheme(settings?.themeName)} onClick={() => setMenu(null)}>
    {kind === "monitor"
      ? <MonitorPanel active={active} locale={settings?.language} onStart={() => void StartMonitor(id).catch(error => setNotice(String(error)))}/>
      : kind === "transfers"
      ? <TransfersProvider><TransferCenter standalone sessionId={id} locale={settings?.language || "en"} onError={setNotice}
          onOpenFiles={() => void OpenSessionPanel("sftp", id, (active?.title || "") + " · SFTP").catch(err => setNotice(String(err)))}/></TransfersProvider>
      : <TransfersProvider><SftpPanel active={active} path={files.remotePath} files={files.remoteFiles} busy={files.sftpBusy} locale={settings?.language} onRefresh={files.refreshSftp} onNotify={setNotice} setCtxMenu={setMenu} onOpenMarkdownFile={(_, path) => void OpenPanelDocument(path).catch(error => setNotice(String(error)))}/></TransfersProvider>}
    {menu && <div className="tab-context-menu" role="menu" style={{left: menu.x, top: menu.y}}>{menu.items.map(item => <button key={item.label} onClick={item.action}>{item.label}</button>)}</div>}
    {notice && <button className="native-terminal-notice" onClick={() => setNotice("")}>{notice}</button>}
  </div>;
}
