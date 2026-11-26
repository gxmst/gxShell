import { useEffect, useMemo, useRef } from "react";
import { OpenTerminalWindow, CloseTerminalWindow } from "../../../wailsjs/go/app/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import type { types } from "../../../wailsjs/go/models";
import type { useTerminal } from "../../hooks/useTerminal";
import type { Tab } from "../../types";
import { terminalChannel, type TerminalMessage } from "./channel";

export function NativeTerminalHost({ tab, settings, override, terminal, onDock, notify }: {
  tab: Tab; settings: types.AppSettings; override?: types.TerminalSettings;
  terminal: ReturnType<typeof useTerminal>; onDock: (id: string) => void;
  notify: (text: string, tone: "error") => void;
}) {
  const info = useMemo(() => ({
    title: tab.title,
    state: tab.state,
    settings: {
      terminal: override ?? settings.terminal,
      themeName: settings.themeName,
      language: settings.language,
      highlightLevel: settings.highlightLevel,
      highlightRules: settings.highlightRules,
      smartHighlight: settings.smartHighlight,
    },
  }), [tab.title, tab.state, settings, override]);
  const latest = useRef({ info, terminal, onDock, notify });
  latest.current = { info, terminal, onDock, notify };
  const channelRef = useRef<BroadcastChannel | null>(null);
  const id = tab.id;
  useEffect(() => {
    const channel = terminalChannel(id);
    channelRef.current = channel;
    let stopMirror: (() => void) | null = null;
    let client = "";
    let disposed = false;
    let opened = false;
    let nativeClosed = false;
    const post = (message: TerminalMessage) => { if (!disposed) channel.postMessage(message); };
    const fail = (error: unknown) => {
      if (disposed) return;
      latest.current.notify(String(error), "error");
      latest.current.onDock(id);
    };
    const off = EventsOn("terminal:window-closed", (closed: string) => {
      if (closed === id) { nativeClosed = true; latest.current.onDock(id); }
    });
    // Schedule creation so a StrictMode probe can dispose without opening a window.
    const opening = window.setTimeout(() => {
      OpenTerminalWindow(id, latest.current.info.title).then(() => {
        opened = true;
        if (disposed && !nativeClosed) void CloseTerminalWindow(id).catch(() => {});
      }).catch(fail);
    }, 0);
    const timeout = window.setTimeout(() => fail(new Error(latest.current.info.settings.language === "zh-CN"
      ? "独立窗口未能加载，终端已放回工作台" : "Terminal window did not load. Returning to the workbench.")), 20000);
    channel.onmessage = ({ data }: MessageEvent<TerminalMessage>) => {
      if (data.kind === "ready") {
        if (stopMirror && client === data.client) return;
        client = data.client;
        stopMirror?.();
        stopMirror = latest.current.terminal.mirrorTerminal(id, snapshot => {
          window.clearTimeout(timeout);
          post({ kind: "screen", snapshot, info: latest.current.info });
        }, chunk => post({ kind: "output", data: chunk }));
      } else if (data.kind === "grid" && Number.isInteger(data.cols) && Number.isInteger(data.rows) && data.cols > 0 && data.rows > 0) {
        latest.current.terminal.resizeMirror(id, data.cols, data.rows);
      }
    };
    return () => {
      disposed = true;
      window.clearTimeout(opening); window.clearTimeout(timeout);
      off(); stopMirror?.(); channel.close(); channelRef.current = null;
      if (opened && !nativeClosed) void CloseTerminalWindow(id).catch(() => {});
    };
  }, [id]);
  useEffect(() => { channelRef.current?.postMessage({ kind: "info", info }); }, [info]);
  return null;
}
