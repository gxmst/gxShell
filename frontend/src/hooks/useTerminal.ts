import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { types } from "../../wailsjs/go/models";
import { ResizeTerminal, WriteToTerminal } from "../../wailsjs/go/main/App";
import { getTerminalTheme } from "../utils/format";

export function useTerminal(activeTab: string, settings: types.AppSettings | null, notify: (text: string, tone?: "info" | "error" | "success") => void, sidebarCollapsed: boolean) {
  const terminals = useRef<Record<string, Terminal>>({});
  const fits = useRef<Record<string, FitAddon>>({});
  const searches = useRef<Record<string, SearchAddon>>({});
  const terminalHosts = useRef<Record<string, HTMLDivElement | null>>({});
  const bufferedOutput = useRef<Record<string, string[]>>({});

  useEffect(() => {
    if (!activeTab || !settings) return;
    const host = terminalHosts.current[activeTab];
    if (!host || terminals.current[activeTab]) {
      fits.current[activeTab]?.fit();
      return;
    }
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: settings.terminal.cursorBlink,
      cursorStyle: settings.terminal.cursorStyle as any,
      fontFamily: settings.terminal.fontFamily || "JetBrains Mono, Cascadia Code, Fira Code, Maple Mono, Consolas, monospace",
      fontSize: settings.terminal.fontSize || 13.5,
      fontWeight: 400,
      lineHeight: settings.terminal.lineHeight || 1.35,
      scrollback: settings.terminal.scrollbackLines || 5000,
      theme: getTerminalTheme(settings)
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.open(host);

    const fitAndResize = () => {
      window.requestAnimationFrame(() => {
        try {
          if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
          fit.fit();
          ResizeTerminal(activeTab, term.cols, term.rows).catch(() => undefined);
        } catch {
          // WebView can briefly report zero geometry during startup.
        }
      });
    };

    fitAndResize();
    window.setTimeout(fitAndResize, 80);
    window.setTimeout(fitAndResize, 260);
    term.focus();
    terminals.current[activeTab] = term;
    fits.current[activeTab] = fit;
    searches.current[activeTab] = searchAddon;
    term.onData((data) => WriteToTerminal(activeTab, data).catch((err) => notify(String(err), "error")));
    const buffered = bufferedOutput.current[activeTab] || [];
    buffered.forEach((chunk) => term.write(chunk));
    delete bufferedOutput.current[activeTab];

    const resize = () => fitAndResize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [activeTab, settings, notify]);

  useEffect(() => {
    if (!settings) return;
    Object.values(terminals.current).forEach((term) => {
      term.options.theme = getTerminalTheme(settings);
      term.options.fontFamily = settings.terminal.fontFamily;
      term.options.fontSize = settings.terminal.fontSize;
      term.options.lineHeight = settings.terminal.lineHeight;
    });
    Object.values(fits.current).forEach((fit) => fit.fit());
  }, [settings]);

  useEffect(() => {
    window.setTimeout(() => {
      Object.values(fits.current).forEach((fit) => {
        try {
          fit.fit();
        } catch {
          // Ignore transient zero-size layout during sidebar animation.
        }
      });
    }, 220);
  }, [sidebarCollapsed]);

  const writeOutput = (sessionId: string, data: string) => {
    const term = terminals.current[sessionId];
    if (term) term.write(data);
    else bufferedOutput.current[sessionId] = [...(bufferedOutput.current[sessionId] || []), data];
  };

  const disposeTerminal = (id: string) => {
    terminals.current[id]?.dispose();
    delete terminals.current[id];
    delete fits.current[id];
    delete searches.current[id];
  };

  const findNext = (id: string, query: string) => {
    if (!id || !query) return;
    searches.current[id]?.findNext(query);
  };

  return { terminalHosts, writeOutput, disposeTerminal, findNext };
}

