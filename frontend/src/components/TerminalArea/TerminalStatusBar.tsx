import { memo, useEffect, useState } from "react";
import { Radio } from "lucide-react";
import type { Tab } from "../../types";
import type { types } from "../../../wailsjs/go/models";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { GetLatestMetrics } from "../../../wailsjs/go/app/App";

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
  language: string;
}) {
  const zh = props.language === "zh-CN";
  const [latency, setLatency] = useState<number | null>(null);
  const [dims, setDims] = useState<Dims | null>(null);

  // Latency arrives on the shared monitor tick, keyed by session id (= tab id).
  // Seed once from the cached metrics on mount so the bar isn't blank until the
  // next tick (noticeable when the monitor interval is long); a stale tabId
  // guard drops the async result if we switched tabs before it resolved.
  useEffect(() => {
    setLatency(null);
    let stale = false;
    GetLatestMetrics(props.tabId)
      .then((m) => { if (!stale && m && m.sessionId === props.tabId) setLatency(m.online ? m.latencyMs : null); })
      .catch(() => {});
    const off = EventsOn("monitor:update", (data: types.Metrics) => {
      if (data.sessionId === props.tabId) setLatency(data.online ? data.latencyMs : null);
    });
    return () => { stale = true; off(); };
  }, [props.tabId]);

  // cols/rows live in a ref inside useTerminal; poll on a low-frequency tick
  // since dimensions only change on window resize or split drag.
  useEffect(() => {
    const read = () => {
      const d = props.getDimensions?.(props.tabId);
      if (d && d.cols > 0) setDims((prev) => (prev && prev.cols === d.cols && prev.rows === d.rows ? prev : d));
      else setDims((prev) => (prev === null ? prev : null));
    };
    read();
    const id = window.setInterval(read, 1500);
    return () => window.clearInterval(id);
  }, [props.tabId, props.getDimensions]);

  const state = props.tab.state;
  const local = !!props.tab.local;
  const stateLabel =
    state === "connected" ? (local ? (zh ? "就绪" : "Ready") : (zh ? "已连接" : "Connected"))
    : state === "connecting" ? (zh ? "连接中" : "Connecting")
    : state === "error" ? (zh ? "错误" : "Error")
    : (zh ? "已断开" : "Disconnected");

  const target = local
    ? (props.profile?.name || (zh ? "本地终端" : "Local"))
    : props.profile
      ? `${props.profile.username}@${props.profile.host}${props.profile.port && props.profile.port !== 22 ? `:${props.profile.port}` : ""}`
      : props.tab.title;

  const latencyTone = latency == null ? "" : latency < 80 ? "ok" : latency < 200 ? "warn" : "bad";

  return (
    <div className="terminal-statusbar" data-state={state}>
      <span className="tsb-seg tsb-state">
        <span className="tsb-dot" />
        {stateLabel}
      </span>
      <span className="tsb-sep" />
      <span className="tsb-seg tsb-target" title={target}>{target}</span>

      {!local && state === "connected" && latency != null && (
        <>
          <span className="tsb-sep" />
          <span className={`tsb-seg tsb-latency tsb-${latencyTone}`}>
            <span className="tsb-latency-dot" />
            {latency} ms
          </span>
        </>
      )}

      <span className="tsb-spacer" />

      {props.broadcastInput && (props.broadcastCount || 0) > 1 && (
        <span className="tsb-seg tsb-broadcast" title={zh ? "输入广播已开启" : "Input broadcast on"}>
          <Radio size={11} />
          {props.broadcastCount}
        </span>
      )}
      {dims && (
        <span className="tsb-seg tsb-dims">{dims.cols}×{dims.rows}</span>
      )}
      <span className="tsb-sep" />
      <span className="tsb-seg tsb-enc">UTF-8</span>
      <span className="tsb-sep" />
      <span className="tsb-seg tsb-sessions" title={zh ? "活动会话数" : "Active sessions"}>
        {props.sessionCount} {zh ? "会话" : props.sessionCount === 1 ? "session" : "sessions"}
      </span>
    </div>
  );
});
