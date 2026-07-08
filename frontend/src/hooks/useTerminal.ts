import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { types } from "../../wailsjs/go/models";
import { ResizeTerminal, WriteToTerminal, LogCommand } from "../../wailsjs/go/main/App";
import { getTerminalTheme } from "../utils/format";
import { highlight, type HighlightLevel } from "../utils/highlight";
import { createLinkProvider, type TerminalLinkAppHandlers } from "../utils/terminalLinks";
import type { SplitPane } from "../types";

const MAX_BUFFERED_CHUNKS = 100;
const MAX_COMMAND_BUFFER_CHARS = 8192;
const RESIZE_SETTLE_MS = 80;

export function useTerminal(activeTab: string, activeIsTerminal: boolean, settings: types.AppSettings | null, notify: (text: string, tone?: "info" | "error" | "success") => void, sidebarCollapsed: boolean, splitPane?: SplitPane | null, broadcastRef?: MutableRefObject<{ enabled: boolean; targets: string[] }>, linkHandlersRef?: MutableRefObject<TerminalLinkAppHandlers>) {
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
  const throughputRef = useRef<Record<string, number>>({});
  const refitTimers = useRef<Record<string, number>>({});
  const linkProviders = useRef<Record<string, { dispose: () => void }>>({});
  // searchResultsRef is set by the search UI (via registerSearchResults) so it
  // receives live match counts from SearchAddon's onDidChangeResults for the
  // terminal being searched: (sessionId, resultIndex, resultCount).
  const searchResultsRef = useRef<((id: string, index: number, count: number) => void) | null>(null);

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
  {
    const raw = settings?.highlightLevel;
    highlightLevelRef.current = (raw === "basic" || raw === "full") ? raw : "off";
  }

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const applyHighlight = useCallback((sessionId: string, data: string) => {
    const level = highlightLevelRef.current;
    if (level === "off") return data;
    return highlight(data, level);
  }, []);

  // Reset throughput counters every second; auto-disable highlight under sustained load
  useEffect(() => {
    const id = window.setInterval(() => {
      for (const key of Object.keys(throughputRef.current)) {
        throughputRef.current[key] = 0;
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!activeTab || !activeIsTerminal || !settingsRef.current) return;
    const host = terminalHosts.current[activeTab];
    if (!host) return;

    // Disconnect any observer left by reattachTerminal before setting up our own
    observers.current[activeTab]?.disconnect();
    delete observers.current[activeTab];

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
      const s = settingsRef.current;
      const term = new Terminal({
        allowProposedApi: true,
        convertEol: true,
        cursorBlink: s.terminal.cursorBlink,
        cursorStyle: s.terminal.cursorStyle as any,
        fontFamily: s.terminal.fontFamily || "JetBrains Mono, Cascadia Code, Fira Code, Maple Mono, Consolas, monospace",
        fontSize: s.terminal.fontSize || 13.5,
        fontWeight: 400,
        lineHeight: s.terminal.lineHeight || 1.35,
        minimumContrastRatio: 1,
        drawBoldTextInBrightColors: false,
        scrollback: s.terminal.scrollbackLines || 5000,
        smoothScrollDuration: 0,
        theme: getTerminalTheme(s)
      });
      const fit = new FitAddon();
      const searchAddon = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(searchAddon);
      // Report match count/position to the search bar. Fires after every
      // findNext/findPrevious, so the bar can show "3 / 12" live. resultIndex is
      // -1 when there is no match; the addon uses 0-based indices.
      try {
        searchAddon.onDidChangeResults((res) => {
          if (searchResultsRef.current) {
            searchResultsRef.current(activeTab, res.resultIndex, res.resultCount);
          }
        });
      } catch {}
      term.open(host);

      // Clickable URLs and remote file paths, detected in the xterm display
      // layer so the SSH output stream is never rewritten. The provider reads
      // linkHandlersRef lazily on each click, so it stays valid across renders.
      if (linkHandlersRef?.current) {
        const provider = createLinkProvider(
          term,
          {
            openUrl: (url) => linkHandlersRef.current?.openUrl(url),
            openPath: (path) => linkHandlersRef.current?.openPath(activeTab, path),
          },
          // smartHighlight gates the clickable-link feature; read live so the
          // settings toggle applies without reopening the terminal.
          () => settingsRef.current?.smartHighlight !== false,
        );
        linkProviders.current[activeTab] = term.registerLinkProvider(provider);
      }

      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => {
          // Dispose the WebGL addon; xterm.js automatically falls back
          // to the canvas renderer, avoiding flickering / white screens.
          gl.dispose();
          delete webgl.current[activeTab];
          notifyRef.current("WebGL context lost, using canvas renderer", "info");
        });
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
        // Broadcast (synchronized input): when enabled, mirror the same keystrokes
        // to every other connected SSH terminal. Only the active terminal drives
        // the command buffer / history below.
        const bc = broadcastRef?.current;
        if (bc?.enabled) {
          for (const id of bc.targets) {
            if (id !== activeTab) WriteToTerminal(id, data).catch(() => {});
          }
        }
        const buf = cmdBuffer.current[activeTab] || "";
        if (data === "\r") {
          if (buf.trim()) {
            LogCommand(activeTab, buf.trim()).catch(() => {});
          }
          cmdBuffer.current[activeTab] = "";
        } else if (data === "\x7f" || data === "\b") {
          cmdBuffer.current[activeTab] = buf.slice(0, -1);
        } else if (data.length === 1 && data.charCodeAt(0) >= 32 && buf.length < MAX_COMMAND_BUFFER_CHARS) {
          cmdBuffer.current[activeTab] = buf + data;
        }
      });

      const buffered = bufferedOutput.current[activeTab] || [];
      buffered.forEach((chunk) => term.write(chunk));
      delete bufferedOutput.current[activeTab];

      fitAndResize();
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeIsTerminal]);

  useEffect(() => {
    if (!splitPane) return;
    const ids = [splitPane.left, splitPane.right].filter((id) => id && id !== activeTab && terminals.current[id]);
    if (!ids.length) return;
    const cleanups: (() => void)[] = [];
    ids.forEach((id) => {
      const host = terminalHosts.current[id];
      if (!host) return;
      const fit = fits.current[id];
      const term = terminals.current[id];
      if (!fit || !term) return;
      const resize = () => {
        if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
        const key = `${host.clientWidth}x${host.clientHeight}`;
        if (lastHostSize.current[id] === key) return;
        lastHostSize.current[id] = key;
        try {
          fit.fit();
          const { cols, rows } = term;
          const prev = lastDimensions.current[id];
          if (!prev || prev.cols !== cols || prev.rows !== rows) {
            lastDimensions.current[id] = { cols, rows };
            window.clearTimeout(pendingResizeTimers.current[id]);
            pendingResizeTimers.current[id] = window.setTimeout(() => {
              delete pendingResizeTimers.current[id];
              ResizeTerminal(id, cols, rows).catch(() => { delete lastDimensions.current[id]; });
            }, RESIZE_SETTLE_MS);
          }
        } catch {}
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      cleanups.push(() => observer.disconnect());
      resize();
    });
    return () => cleanups.forEach((fn) => fn());
  }, [splitPane, activeTab]);

  useEffect(() => {
    if (!settings) return;
    Object.values(terminals.current).forEach((term) => {
      term.options.theme = getTerminalTheme(settings);
      term.options.fontFamily = settings.terminal.fontFamily;
      term.options.fontSize = settings.terminal.fontSize;
      term.options.lineHeight = settings.terminal.lineHeight;
    });
  }, [settings]);

  useEffect(() => {
    const ids = Object.keys(terminals.current);
    if (!ids.length) return;
    const timer = window.setTimeout(() => {
      ids.forEach((id) => {
        const fit = fits.current[id];
        const term = terminals.current[id];
        const host = terminalHosts.current[id];
        if (!fit || !term || !host) return;
        if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
        try {
          fit.fit();
          const { cols, rows } = term;
          const prev = lastDimensions.current[id];
          if (!prev || prev.cols !== cols || prev.rows !== rows) {
            lastDimensions.current[id] = { cols, rows };
            ResizeTerminal(id, cols, rows).catch(() => {
              delete lastDimensions.current[id];
            });
          }
        } catch {}
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [sidebarCollapsed]);

  const writeOutput = useCallback((sessionId: string, data: string) => {
    const term = terminals.current[sessionId];
    if (term) {
      // Track bytes/sec per session for adaptive highlight
      throughputRef.current[sessionId] = (throughputRef.current[sessionId] || 0) + data.length;
      const queue = pendingOutput.current[sessionId] || [];
      queue.push(data);
      pendingOutput.current[sessionId] = queue;
      if (pendingWriteFrames.current[sessionId]) return;
      pendingWriteFrames.current[sessionId] = window.requestAnimationFrame(() => {
        delete pendingWriteFrames.current[sessionId];
        const chunks = pendingOutput.current[sessionId];
        delete pendingOutput.current[sessionId];
        if (!chunks?.length) return;
        // Skip highlight under high throughput (>32 KB/s) to keep rendering smooth
        const rate = throughputRef.current[sessionId] || 0;
        const shouldHighlight = rate < 32768;
        const combined = chunks.join("");
        terminals.current[sessionId]?.write(
          shouldHighlight ? applyHighlight(sessionId, combined) : combined
        );
      });
    } else {
      const buffer = bufferedOutput.current[sessionId] || [];
      if (buffer.length < MAX_BUFFERED_CHUNKS) {
        bufferedOutput.current[sessionId] = [...buffer, data];
      }
    }
  }, [applyHighlight]);

  const disposeTerminal = useCallback((id: string) => {
    observers.current[id]?.disconnect();
    delete observers.current[id];
    cleanupFns.current[id]?.();
    delete cleanupFns.current[id];
    linkProviders.current[id]?.dispose();
    delete linkProviders.current[id];
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
    delete pendingResizeTimers.current[id];
    delete refitTimers.current[id];
    delete pendingFitFrames.current[id];
    delete pendingWriteFrames.current[id];
    delete cmdBuffer.current[id];
    delete lastDimensions.current[id];
    delete lastHostSize.current[id];
    delete terminalHosts.current[id];
    delete throughputRef.current[id];
  }, []);

  const findNext = useCallback((id: string, query: string) => {
    if (!id || !query) return;
    searches.current[id]?.findNext(query);
  }, []);

  const findPrev = useCallback((id: string, query: string) => {
    if (!id || !query) return;
    searches.current[id]?.findPrevious(query);
  }, []);

  const refitTerminal = useCallback((id: string, _depth = 0) => {
    const fit = fits.current[id];
    const term = terminals.current[id];
    const host = terminalHosts.current[id];
    if (!fit || !term || !host) return;
    if (host.clientWidth <= 0 || host.clientHeight <= 0) {
      if (_depth < 5) {
        setTimeout(() => refitTerminal(id, _depth + 1), 80);
      }
      return;
    }
    window.clearTimeout(refitTimers.current[id]);
    refitTimers.current[id] = window.setTimeout(() => {
      delete refitTimers.current[id];
      try {
        fit.fit();
        const { cols, rows } = term;
        const prev = lastDimensions.current[id];
        if (!prev || prev.cols !== cols || prev.rows !== rows) {
          lastDimensions.current[id] = { cols, rows };
          ResizeTerminal(id, cols, rows).catch(() => {
            delete lastDimensions.current[id];
          });
        }
      } catch {}
    }, 80);
  }, []);

  const reattachTerminal = useCallback((id: string, newHost: HTMLDivElement) => {
    const term = terminals.current[id];
    if (!term || !term.element) return;

    // Move the terminal's root element (.xterm) to the new host
    // without disposing WebGL. xterm.js WebGL renderer handles
    // canvas resize automatically when the container changes.
    if (term.element.parentElement !== newHost) {
      newHost.appendChild(term.element);
    }
    terminalHosts.current[id] = newHost;

    // Setup ResizeObserver for the new host
    if (observers.current[id]) {
      observers.current[id].disconnect();
    }
    const resize = () => {
      if (!newHost || newHost.clientWidth <= 0 || newHost.clientHeight <= 0) return;
      refitTerminal(id);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(newHost);
    observers.current[id] = observer;

    const oldCleanup = cleanupFns.current[id];
    cleanupFns.current[id] = () => {
      oldCleanup?.();
      observer.disconnect();
      delete observers.current[id];
    };

    // Delayed refit: wait for the container to get real dimensions after React layout.
    requestAnimationFrame(() => {
      setTimeout(() => refitTerminal(id), 80);
    });
  }, [refitTerminal]);

  const focusTerminal = useCallback((id: string) => {
    terminals.current[id]?.focus();
  }, []);

  useEffect(() => {
    return () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current.clear();
    };
  }, []);

  const getTerminalLines = useCallback((id: string, lineCount: number): string => {
    const term = terminals.current[id];
    if (!term) return "";
    try {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      const totalLines = buffer.length;
      const start = Math.max(0, totalLines - lineCount * 3);
      for (let i = start; i < totalLines; i++) {
        const line = buffer.getLine(i);
        if (line) {
          const text = line.translateToString(true);
          if (text.trim()) lines.push(text);
        }
      }
      return lines.slice(-lineCount).join("\n");
    } catch {
      return "";
    }
  }, []);

  const stable = useMemo(() => ({
    terminalHosts,
    writeOutput,
    disposeTerminal,
    findNext,
    findPrev,
    focusTerminal,
    refitTerminal,
    reattachTerminal,
    getTerminalLines,
  }), [writeOutput, disposeTerminal, findNext, findPrev, focusTerminal, refitTerminal, reattachTerminal, getTerminalLines]);

  return stable;
}
