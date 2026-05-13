import { useCallback, useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { types } from "../../wailsjs/go/models";
import { ResizeTerminal, WriteToTerminal, LogCommand } from "../../wailsjs/go/main/App";
import { getTerminalTheme } from "../utils/format";
import { highlight, type HighlightLevel } from "../utils/highlight";

const MAX_BUFFERED_CHUNKS = 100;
const RESIZE_SETTLE_MS = 80;

export function useTerminal(activeTab: string, settings: types.AppSettings | null, notify: (text: string, tone?: "info" | "error" | "success") => void, sidebarCollapsed: boolean) {
  const terminals = useRef<Record<string, Terminal>>({});
  const fits = useRef<Record<string, FitAddon>>({});
  const searches = useRef<Record<string, SearchAddon>>({});
  const webgl = useRef<Record<string, WebglAddon>>({});
  const terminalHosts = useRef<Record<string, HTMLDivElement | null>>({});
  const bufferedOutput = useRef<Record<string, string[]>>({});
  const observers = useRef<Record<string, ResizeObserver>>({});
  const timers = useRef<Set<any>>(new Set());
  const cleanupFns = useRef<Record<string, () => void>>({});
  const cmdBuffer = useRef<Record<string, string>>({});
  const lastDimensions = useRef<Record<string, { cols: number; rows: number }>>({});
  const pendingFitFrames = useRef<Record<string, number>>({});
  const pendingResizeTimers = useRef<Record<string, number>>({});
  const pendingOutput = useRef<Record<string, string[]>>({});
  const pendingWriteFrames = useRef<Record<string, number>>({});
  const lastHostSize = useRef<Record<string, string>>({});

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

  const highlightLevelRef = useRef<HighlightLevel>("off");
  highlightLevelRef.current = (settings?.highlightLevel as HighlightLevel) || "off";

  const applyHighlight = useCallback((sessionId: string, data: string) => {
    const level = highlightLevelRef.current;
    if (level === "off") return data;
    return highlight(data, level);
  }, []);

  useEffect(() => {
    if (!activeTab || !settings) return;
    const host = terminalHosts.current[activeTab];
    if (!host) return;

    const fitAndResize = () => {
      if (pendingFitFrames.current[activeTab]) return;
      pendingFitFrames.current[activeTab] = window.requestAnimationFrame(() => {
        delete pendingFitFrames.current[activeTab];
        try {
          if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
          const fit = fits.current[activeTab];
          const term = terminals.current[activeTab];
          if (!fit || !term) return;

          fit.fit();
          const { cols, rows } = term;
          
          const prev = lastDimensions.current[activeTab];
          if (prev && prev.cols === cols && prev.rows === rows) return;

          lastDimensions.current[activeTab] = { cols, rows };
          window.clearTimeout(pendingResizeTimers.current[activeTab]);
          pendingResizeTimers.current[activeTab] = window.setTimeout(() => {
            delete pendingResizeTimers.current[activeTab];
            ResizeTerminal(activeTab, cols, rows).catch(() => {
              delete lastDimensions.current[activeTab];
            });
          }, RESIZE_SETTLE_MS);
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
        minimumContrastRatio: 1,
        drawBoldTextInBrightColors: false,
        scrollback: settings.terminal.scrollbackLines || 5000,
        smoothScrollDuration: 0,
        theme: getTerminalTheme(settings)
      });
      const fit = new FitAddon();
      const searchAddon = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(searchAddon);
      term.open(host);

      try {
        const gl = new WebglAddon();
        term.loadAddon(gl);
        webgl.current[activeTab] = gl;
      } catch (err) {
        notifyRef.current("WebGL unavailable, using canvas renderer", "info");
      }

      host.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        const selection = term.getSelection();
        if (selection) {
          try {
            await navigator.clipboard.writeText(selection);
            notifyRef.current("Copied to clipboard", "success");
          } catch {
            notifyRef.current("Copy failed, use Ctrl+C instead", "error");
          }
          term.clearSelection();
        } else {
          try {
            const text = await navigator.clipboard.readText();
            WriteToTerminal(activeTab, text).catch(() => {});
          } catch {
            notifyRef.current("Paste failed, use Ctrl+V instead", "error");
          }
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

    const resize = () => {
      const h = terminalHosts.current[activeTab];
      if (!h || h.clientWidth <= 0 || h.clientHeight <= 0) return;
      const key = `${h.clientWidth}x${h.clientHeight}`;
      if (lastHostSize.current[activeTab] === key) return;
      lastHostSize.current[activeTab] = key;
      fitAndResize();
    };
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
      const queue = pendingOutput.current[sessionId] || [];
      queue.push(data);
      pendingOutput.current[sessionId] = queue;
      if (pendingWriteFrames.current[sessionId]) return;
      pendingWriteFrames.current[sessionId] = window.requestAnimationFrame(() => {
        delete pendingWriteFrames.current[sessionId];
        const chunks = pendingOutput.current[sessionId];
        delete pendingOutput.current[sessionId];
        if (!chunks?.length) return;
        terminals.current[sessionId]?.write(applyHighlight(sessionId, chunks.join("")));
      });
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
    webgl.current[id]?.dispose();
    terminals.current[id]?.dispose();
    if (pendingFitFrames.current[id]) window.cancelAnimationFrame(pendingFitFrames.current[id]);
    if (pendingWriteFrames.current[id]) window.cancelAnimationFrame(pendingWriteFrames.current[id]);
    window.clearTimeout(pendingResizeTimers.current[id]);
    delete webgl.current[id];
    delete terminals.current[id];
    delete fits.current[id];
    delete searches.current[id];
    delete bufferedOutput.current[id];
    delete pendingOutput.current[id];
    delete pendingFitFrames.current[id];
    delete pendingWriteFrames.current[id];
    delete pendingResizeTimers.current[id];
    delete cmdBuffer.current[id];
    delete lastDimensions.current[id];
    delete lastHostSize.current[id];
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
