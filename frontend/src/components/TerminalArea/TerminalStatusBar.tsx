import { memo, useEffect, useState } from "react";
import { Folder, Radio } from "lucide-react";
import type { Tab } from "../../types";
import type { types } from "../../../wailsjs/go/models";
import { useSessionMetrics } from "../../hooks/useSessionMetrics";
import { probeLatency } from "../../utils/format";
import { t } from "../../i18n";

type Dims = { cols: number; rows: number };

// A slim status strip pinned to the bottom of the terminal pane, mirroring
// iTerm2 / Windows Terminal. It is a standalone memo component that subscribes
// to monitor:update itself, so the per-second latency tick re-renders only this
// bar and never punches through the memoized TerminalArea subtree above it.
export const TerminalStatusBar = memo(function TerminalStatusBar(props: {
  tabId: string;
  tab: Tab;
  profile?: types.Profile;
  broadcastInput?: boolean;
  broadcastCount?: number;
  sessionCount: number;
  getDimensions?: (id: string) => Dims | null | undefined;
  getCurrentDirectory?: (id: string) => { path: string; host?: string } | null | undefined;
  onOpenCurrentDirectory?: (id: string, path: string) => void;
  language: string;
}) {
  const { language: propLanguage, tabId: propTabId, getDimensions: propGetDimensions, getCurrentDirectory: propGetCurrentDirectory, tab: propTab, profile: propProfile, onOpenCurrentDirectory: propOnOpenCurrentDirectory, broadcastInput: propBroadcastInput, broadcastCount: propBroadcastCount, sessionCount: propSessionCount } = props;
  const lang = propLanguage;
  const probe = useSessionMetrics(propTab.local ? undefined : propTabId)?.probeHistory?.at(-1);
  const [dims, setDims] = useState<Dims | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState("");

  // cols/rows live in a ref inside useTerminal; poll on a low-frequency tick
  // since dimensions only change on window resize or split drag.
  useEffect(() => {
    const read = () => {
      const d = propGetDimensions?.(propTabId);
      if (d && d.cols > 0) setDims((prev) => (prev && prev.cols === d.cols && prev.rows === d.rows ? prev : d));
      else setDims((prev) => (prev === null ? prev : null));
      const path = propGetCurrentDirectory?.(propTabId)?.path || "";
      setCurrentDirectory((prev) => prev === path ? prev : path);
    };
    read();
    const id = window.setInterval(read, 1500);
    return () => window.clearInterval(id);
  }, [propTabId, propGetCurrentDirectory, propGetDimensions]);

  const state = propTab.state;
  const local = !!propTab.local;
  const stateLabel =
    state === "connected" ? (local ? t(lang, "terminalStateReady") : t(lang, "serverStatusConnected"))
    : state === "connecting" ? t(lang, "terminalStateConnecting")
    : state === "reconnecting" ? t(lang, "terminalStateReconnecting")
    : state === "restoring" ? t(lang, "terminalStateRestoring")
    : state === "error" ? t(lang, "terminalStateError")
    : t(lang, "terminalStateDisconnected");

  const target = local
    ? (propProfile?.name || t(lang, "terminalLocal"))
    : propProfile
      ? `${propProfile.username}@${propProfile.host}${propProfile.port && propProfile.port !== 22 ? `:${propProfile.port}` : ""}`
      : propTab.title;


  return (
    <div className="terminal-statusbar" data-state={state}>
      <span className="tsb-seg tsb-state">
        <span className="tsb-dot" />
        {stateLabel}
      </span>
      <span className="tsb-sep" />
      <span className="tsb-seg tsb-target" title={target}>{target}</span>

      {currentDirectory && (
        <>
          <span className="tsb-sep" />
          <button
            type="button"
            className="tsb-seg tsb-cwd"
            title={currentDirectory}
            disabled={local || !propOnOpenCurrentDirectory}
            onClick={() => propOnOpenCurrentDirectory?.(propTabId, currentDirectory)}
          >
            <Folder size={11} />
            <span>{currentDirectory}</span>
          </button>
        </>
      )}

      {!local && state === "connected" && probe?.state === "reply" && (
        <>
          <span className="tsb-sep" />
          <span className="tsb-seg tsb-latency" title={probe.method.toUpperCase()}>
            {t(lang, "latency")} {probeLatency(probe.rttMs)}
          </span>
        </>
      )}

      <span className="tsb-spacer" />

      {propBroadcastInput && (propBroadcastCount || 0) > 1 && (
        <span className="tsb-seg tsb-broadcast" title={t(lang, "terminalInputBroadcastOn")}>
          <Radio size={11} />
          {propBroadcastCount}
        </span>
      )}
      {dims && (
        <span className="tsb-seg tsb-dims">{dims.cols}×{dims.rows}</span>
      )}
      <span className="tsb-sep" />
      <span className="tsb-seg tsb-enc">UTF-8</span>
      <span className="tsb-sep" />
      <span className="tsb-seg tsb-sessions" title={t(lang, "activeSessions")}>
        {t(lang, propSessionCount === 1 ? "sessionCountOne" : "sessionCountMany", { count: String(propSessionCount) })}
      </span>
    </div>
  );
});
