import { useCallback, useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { types } from "../../wailsjs/go/models";
import { ResizeTerminal, WriteToTerminal, LogCommand } from "../../wailsjs/go/main/App";
import { getTerminalTheme } from "../utils/format";
import { highlight, type HighlightLevel } from "../utils/highlight";

const MAX_BUFFERED_CHUNKS = 500;

export function useTerminal(activeTab: string, settings: types.AppSettings | null, notify: (text: string, tone?: "info" | "error" | "success") => void, sidebarCollapsed: boolean) {
  const terminals = useRef<Record<string, Terminal>>({});
  const fits = useRef<Record<string, FitAddon>>({});
  const searches = useRef<Record<string, SearchAddon>>({});
  const terminalHosts = useRef<Record<string, HTMLDivElement | null>>({});
  const bufferedOutput = useRef<Record<string, string[]>>({});
  const observers = useRef<Record<string, ResizeObserver>>({});
  const timers = useRef<Set<any>>(new Set());
  const cleanupFns = useRef<Record<string, () => void>>({});
  const cmdBuffer = useRef<Record<string, string>>({});
  const lastDimensions = useRef<Record<string, { cols: number; rows: number }>>({});

  const addTimer = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
    return id;
  }, []);

  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const applyHighlight = useCallback((sessionId: string, data: string) => {
    const level: HighlightLevel = (settings?.highlightLevel as HighlightLevel) || "off";
    if (level === "off") return data;
    // Direct highlight without line buffering to ensure zero latency for prompts
    return highlight(data, level);
  }, [settings]);

  useEffect(() => {
    if (!activeTab || !settings) return;
    const host = terminalHosts.current[activeTab];
    if (!host) return;

    const fitAndResize = () => {
      window.requestAnimationFrame(() => {
        try {
          if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
          const fit = fits.current[activeTab];
          const term = terminals.current[activeTab];
          if (!fit || !term) return;

          fit.fit();
          const { cols, rows } = term;
          
          const prev = lastDimensions.current[activeTab];
          if (prev && prev.cols === cols && prev.rows === rows) return;

          const timerKey = `resize-${activeTab}`;
          if (timers.current.has(timerKey)) return;

          // Sync lock immediately to prevent redundant calls
          lastDimensions.current[activeTab] = { cols, rows };
          ResizeTerminal(activeTab, cols, rows).catch(() => {
            // Revert on error to allow retry
            delete lastDimensions.current[activeTab];
          });

          const tid = window.setTimeout(() => {
            timers.current.delete(timerKey);
          }, 300);
          timers.current.add(timerKey);
        } catch {
        }
      });
    };

    if (terminals.current[activeTab]) {
      fitAndResize();
    } else {
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

      host.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        const selection = term.getSelection();
        if (selection) {
          await navigator.clipboard.writeText(selection);
          notifyRef.current("Copied to clipboard", "success");
          term.clearSelection();
        } else {
          try {
            const text = await navigator.clipboard.readText();
            WriteToTerminal(activeTab, text).catch(() => {});
          } catch {}
        }
      });

      term.focus();
      terminals.current[activeTab] = term;
      fits.current[activeTab] = fit;
      searches.current[activeTab] = searchAddon;

      term.onData((data) => {
        WriteToTerminal(activeTab, data).catch((err) => notifyRef.current(String(err), "error"));
        const buf = cmdBuffer.current[activeTab] || "";
        if (data === "\r") {
          if (buf.trim()) {
            LogCommand(activeTab, buf.trim()).catch(() => {});
          }
          cmdBuffer.current[activeTab] = "";
        } else if (data === "\x7f" || data === "\b") {
          cmdBuffer.current[activeTab] = buf.slice(0, -1);
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          cmdBuffer.current[activeTab] = buf + data;
        }
      });

      const buffered = bufferedOutput.current[activeTab] || [];
      buffered.forEach((chunk) => term.write(chunk));
      delete bufferedOutput.current[activeTab];

      fitAndResize();
      addTimer(100, fitAndResize);
    }

    const resize = () => fitAndResize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    observers.current[activeTab] = observer;
    window.addEventListener("resize", resize);

    cleanupFns.current[activeTab] = () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };

  return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      delete observers.current[activeTab];
      delete cleanupFns.current[activeTab];
      delete cmdBuffer.current[activeTab];
    };
  }, [activeTab, settings, addTimer]);

  useEffect(() => {
    if (!settings) return;
    Object.values(terminals.current).forEach((term) => {
      term.options.theme = getTerminalTheme(settings);
      term.options.fontFamily = settings.terminal.fontFamily;
      term.options.fontSize = settings.terminal.fontSize;
      term.options.lineHeight = settings.terminal.lineHeight;
    });
    addTimer(50, () => {
      Object.values(fits.current).forEach((fit) => {
        try { fit.fit(); } catch {}
      });
    });
  }, [settings, addTimer]);

  useEffect(() => {
    addTimer(220, () => {
      Object.values(fits.current).forEach((fit) => {
        try { fit.fit(); } catch {}
      });
    });
  }, [sidebarCollapsed, addTimer]);

  const writeOutput = useCallback((sessionId: string, data: string) => {
    const term = terminals.current[sessionId];
    if (term) {
      term.write(applyHighlight(sessionId, data));
    } else {
      const buffer = bufferedOutput.current[sessionId] || [];
      if (buffer.length < MAX_BUFFERED_CHUNKS) {
        bufferedOutput.current[sessionId] = [...buffer, data];
      }
    }
  }, [applyHighlight]);

  const disposeTerminal = useCallback((id: string) => {
    cleanupFns.current[id]?.();
    delete cleanupFns.current[id];
    terminals.current[id]?.dispose();
    delete terminals.current[id];
    delete fits.current[id];
    delete searches.current[id];
    delete bufferedOutput.current[id];
    delete cmdBuffer.current[id];
    delete lastDimensions.current[id];
  }, []);

  const findNext = useCallback((id: string, query: string) => {
    if (!id || !query) return;
    searches.current[id]?.findNext(query);
  }, []);

  const focusTerminal = useCallback((id: string) => {
    terminals.current[id]?.focus();
  }, []);

  const stable = useMemo(() => ({
    terminalHosts,
    writeOutput,
    disposeTerminal,
    findNext,
    focusTerminal,
  }), [writeOutput, disposeTerminal, findNext, focusTerminal]);

  return stable;
}
