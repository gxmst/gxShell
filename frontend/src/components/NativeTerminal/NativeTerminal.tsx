import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftToLine, Search } from "lucide-react";
import { DockTerminalWindow } from "../../../wailsjs/go/app/App";
import { useTerminal, type TerminalPasteRequest, type TerminalSnapshot, type AppContextMenu } from "../../hooks/useTerminal";
import { TerminalSearchModal } from "../modals/SearchModals";
import { PasteConfirmDialog } from "../modals/PasteConfirmDialog";
import { normalizeAppTheme } from "../../utils/format";
import { t } from "../../i18n";
import { terminalChannel, type TerminalMessage, type ViewInfo } from "./channel";
import "./native-terminal.css";

export function NativeTerminal({ id }: { id: string }) {
  const [info, setInfo] = useState<ViewInfo | null>(null);
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [paste, setPaste] = useState<TerminalPasteRequest | null>(null);
  const [menu, setMenu] = useState<AppContextMenu | null>(null);
  const [notice, setNotice] = useState("");
  const channel = useRef<BroadcastChannel | null>(null);
  const queue = useRef<string[]>([]);
  const hydrated = useRef(false);
  const grid = useCallback((cols: number, rows: number) => channel.current?.postMessage({kind: "grid", cols, rows}), []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{index: number; count: number}>();
  const terminal = useTerminal(id, true, info?.settings ?? null, setNotice, {
    setContextMenu: setMenu, onPasteRequest: setPaste, onGridChange: grid,
    onSearchResults: (_, index, count) => setMatches({ index, count }),
  });
  const { terminalHosts, restoreScreen, writeOutput, disposeTerminal } = terminal;
  const hostElement = useRef<HTMLDivElement | null>(null);
  const register = useCallback((element: HTMLDivElement | null) => {
    hostElement.current = element;
    terminalHosts.current[id] = element;
  }, [terminalHosts, id]);
  const lang = info?.settings.language || "en";
  useEffect(() => {
    terminalHosts.current[id] = hostElement.current;
    const port = terminalChannel(id);
    channel.current = port;
    const client = crypto.randomUUID();
    const ready = () => port.postMessage({ kind: "ready", client });
    const timer = window.setInterval(ready, 500);
    port.onmessage = ({data}: MessageEvent<TerminalMessage>) => {
      if (data.kind === "screen") {
        clearInterval(timer); hydrated.current = false; queue.current = [];
        setInfo(data.info); setSnapshot(data.snapshot);
      } else if (data.kind === "output") {
        if (hydrated.current) writeOutput(id, data.data);
        else queue.current.push(data.data);
      } else if (data.kind === "info") setInfo(old => old ? data.info : old);
    };
    ready();
    return () => { clearInterval(timer); channel.current = null; port.close(); disposeTerminal(id); };
  }, [id, terminalHosts, writeOutput, disposeTerminal]);
  useEffect(() => {
    if (!snapshot) return;
    let live = true;
    restoreScreen(id, snapshot, () => {
      if (!live) return;
      hydrated.current = true;
      for (const chunk of queue.current) writeOutput(id, chunk);
      queue.current = [];
    });
    return () => { live = false; };
  }, [id, snapshot, restoreScreen, writeOutput]);
  return <div className="app-shell native-terminal" data-theme={normalizeAppTheme(info?.settings.themeName)} onClick={() => setMenu(null)}
    onKeyDownCapture={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !paste) {
        event.preventDefault(); event.stopPropagation(); setSearchOpen(true);
      }
    }}>
    <header><span>{info?.title}</span>
      <button className="mini-btn" aria-label={t(lang,"search")} onClick={() => setSearchOpen(true)}><Search size={15}/></button>
      <button className="mini-btn" onClick={() => void DockTerminalWindow().catch(error => setNotice(String(error)))}><ArrowLeftToLine size={15}/>{t(lang,"dockTerminal")}</button></header>
    <div className="native-terminal-host terminal-host" ref={register}/>
    {notice && <button className="native-terminal-notice" onClick={() => setNotice("")}>{notice}</button>}
    {menu && <div className="tab-context-menu" role="menu" style={{left: menu.x, top: menu.y}}>
      {menu.items.map(item => <button key={item.label} onClick={item.action}>{item.label}</button>)}
    </div>}
    {searchOpen && <TerminalSearchModal query={query} locale={lang}
      onQuery={value => { setQuery(value); if (value) terminal.findNext(id, value); else setMatches(undefined); }}
      onNext={() => terminal.findNext(id, query)} onPrev={() => terminal.findPrev(id, query)}
      onClose={() => { setSearchOpen(false); terminal.focusTerminal(id); }}
      matchIndex={matches?.index} matchCount={matches?.count}/>}
    {paste && <PasteConfirmDialog request={paste} language={lang} onCancel={() => setPaste(null)} onConfirm={() => {paste.commit(); setPaste(null);}}/>}
  </div>;
}
