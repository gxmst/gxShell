import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Eye, Loader2, Play, RefreshCw, RotateCcw, Square, StopCircle, Trash2 } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListContainers, StreamContainerLogs, StopContainerLogs, RestartContainer, StopContainer, StartContainer, RemoveContainer } from "../../../wailsjs/go/app/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { t } from "../../i18n";
import type { Tab, Toast } from "../../types";

const MAX_LOG_CHARS = 512 * 1024;
const LOG_FLUSH_MS = 75;

// Payload of the Go-side "docker:log" event (a map[string]string). The backend
// may batch several log lines into one event, so `data` can contain embedded
// newlines (and a "[line truncated]" marker for oversized lines); it is
// appended verbatim into the <pre> log view, which renders newlines as-is.
interface DockerLogEvent {
  streamID?: string;
  sessionID?: string;
  containerID?: string;
  data?: string;
  /** "true" when the stream has ended. */
  done?: string;
}

function nextLogStreamId() {
  return `docker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function appendBoundedLog(previous: string, chunk: string) {
  const combined = previous + chunk;
  if (combined.length <= MAX_LOG_CHARS) return combined;
  return `[gxShell: older Docker log output was truncated]\n${combined.slice(combined.length - MAX_LOG_CHARS)}`;
}

export function ContainerPanel(props: { active?: Tab; locale: string; onNotify: (text: string, tone?: Toast["tone"]) => void }) {
  const lang = props.locale;
  const [containers, setContainers] = useState<types.ContainerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [logContainer, setLogContainer] = useState<types.ContainerInfo | null>(null);
  const [logs, setLogs] = useState("");
  const [logStreaming, setLogStreaming] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const logEndRef = useRef<HTMLDivElement>(null);
  const logStreamIdRef = useRef<string | null>(null);
  const pendingLogRef = useRef("");
  const pendingLogTimerRef = useRef<number | null>(null);

  const flushPendingLogs = useCallback(() => {
    if (pendingLogTimerRef.current !== null) {
      window.clearTimeout(pendingLogTimerRef.current);
      pendingLogTimerRef.current = null;
    }
    const chunk = pendingLogRef.current;
    pendingLogRef.current = "";
    if (chunk) setLogs((previous) => appendBoundedLog(previous, chunk));
  }, []);

  const queueLogChunk = useCallback((chunk: string) => {
    pendingLogRef.current += chunk;
    if (pendingLogRef.current.length >= 32 * 1024) {
      flushPendingLogs();
      return;
    }
    if (pendingLogTimerRef.current === null) {
      pendingLogTimerRef.current = window.setTimeout(flushPendingLogs, LOG_FLUSH_MS);
    }
  }, [flushPendingLogs]);

  const refresh = useCallback(async () => {
    if (!props.active?.id) return;
    setLoading(true);
    try {
      const list = await ListContainers(props.active.id, showAll);
      setContainers(list || []);
    } catch (err) {
      props.onNotify(String(err), "error");
      setContainers([]);
    } finally {
      setLoading(false);
    }
  }, [props.active?.id, showAll, props.onNotify]);

  useEffect(() => {
    refresh();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(refresh, 10000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refresh]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const onNotifyRef = useRef(props.onNotify);
  onNotifyRef.current = props.onNotify;

  useEffect(() => {
    const off = EventsOn("docker:log", (data: DockerLogEvent) => {
      if (!data?.streamID || data.streamID !== logStreamIdRef.current) return;
      if (data.done === "true") {
        flushPendingLogs();
        logStreamIdRef.current = null;
        setLogStreaming(false);
        return;
      }
      if (data.data) {
        queueLogChunk(data.data);
      }
    });
    return () => off();
  }, [flushPendingLogs, queueLogChunk]);

  useEffect(() => {
    const streamID = logStreamIdRef.current;
    if (streamID) StopContainerLogs(streamID).catch(() => {});
    logStreamIdRef.current = null;
    pendingLogRef.current = "";
    if (pendingLogTimerRef.current !== null) {
      window.clearTimeout(pendingLogTimerRef.current);
      pendingLogTimerRef.current = null;
    }
    setLogContainer(null);
    setLogs("");
    setLogStreaming(false);
  }, [props.active?.id]);

  const viewLogs = useCallback(async (c: types.ContainerInfo) => {
    if (!props.active?.id) return;
    const previousStream = logStreamIdRef.current;
    if (previousStream) {
      await StopContainerLogs(previousStream).catch(() => {});
    }
    flushPendingLogs();
    const streamID = nextLogStreamId();
    setLogContainer(c);
    logStreamIdRef.current = streamID;
    setLogs("");
    setLogStreaming(true);
    try {
      await StreamContainerLogs(props.active.id, c.id, streamID, 200);
    } catch (err) {
      if (logStreamIdRef.current === streamID) {
        logStreamIdRef.current = null;
        setLogStreaming(false);
      }
      onNotifyRef.current(String(err), "error");
    }
  }, [props.active?.id, flushPendingLogs]);

  const closeLogs = useCallback(() => {
    const streamID = logStreamIdRef.current;
    if (streamID) {
      StopContainerLogs(streamID).catch(() => {});
    }
    flushPendingLogs();
    setLogContainer(null);
    logStreamIdRef.current = null;
    setLogs("");
    setLogStreaming(false);
  }, [flushPendingLogs]);

  useEffect(() => {
    return () => {
      if (logStreamIdRef.current) {
        StopContainerLogs(logStreamIdRef.current).catch(() => {});
      }
      if (pendingLogTimerRef.current !== null) window.clearTimeout(pendingLogTimerRef.current);
    };
  }, []);

  const restart = useCallback(async (c: types.ContainerInfo) => {
    if (!props.active?.id) return;
    setActionLoading(c.id);
    try {
      await RestartContainer(props.active.id, c.id);
      props.onNotify(`${c.names?.[0] || c.id}: restarted`, "success");
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setActionLoading(null);
    }
  }, [props.active?.id, refresh, props.onNotify]);

  const stop = useCallback(async (c: types.ContainerInfo) => {
    if (!props.active?.id) return;
    setActionLoading(c.id);
    try {
      await StopContainer(props.active.id, c.id);
      props.onNotify(`${c.names?.[0] || c.id}: stopped`, "success");
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setActionLoading(null);
    }
  }, [props.active?.id, refresh, props.onNotify]);

  const start = useCallback(async (c: types.ContainerInfo) => {
    if (!props.active?.id) return;
    setActionLoading(c.id);
    try {
      await StartContainer(props.active.id, c.id);
      props.onNotify(`${c.names?.[0] || c.id}: started`, "success");
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setActionLoading(null);
    }
  }, [props.active?.id, refresh, props.onNotify]);

  const remove = useCallback(async (c: types.ContainerInfo) => {
    if (!props.active?.id) return;
    setActionLoading(c.id);
    try {
      await RemoveContainer(props.active.id, c.id, true);
      props.onNotify(`${c.names?.[0] || c.id}: removed`, "success");
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setActionLoading(null);
    }
  }, [props.active?.id, refresh, props.onNotify]);

  const stateColor = (state: string) => {
    switch (state) {
      case "running": return "text-green-400";
      case "paused": return "text-yellow-400";
      case "exited":
      case "dead": return "text-red-400";
      default: return "text-muted";
    }
  };

  const stateDot = (state: string) => {
    switch (state) {
      case "running": return "bg-green-400";
      case "paused": return "bg-yellow-400";
      case "exited":
      case "dead": return "bg-red-400";
      default: return "bg-gray-500";
    }
  };

  if (!props.active?.id) {
    return (
      <div className="container-panel panel-page">
        <div className="container-empty">
          <Box size={28} className="text-muted mb-2" />
          <div className="text-[11px] text-muted">{t(lang, "noActiveSession")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-panel panel-page">
      <div className="container-header panel-page-header">
        <div className="panel-page-heading">
          <span className="panel-page-icon"><Box size={14} /></span>
          <span><strong>{t(lang, "containers")}</strong><small>{lang === "zh-CN" ? `${containers.length} 个容器` : `${containers.length} containers`}</small></span>
        </div>
        <div className="panel-page-actions">
          <label className="panel-page-check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="w-2.5 h-2.5" />
            {t(lang, "showAll")}
          </label>
          <button className="panel-page-action" onClick={refresh} disabled={loading}><RefreshCw size={11} className={loading ? "animate-spin" : ""} /></button>
        </div>
      </div>

      {logContainer && (
        <div className="container-log-panel">
          <div className="container-log-header">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold text-accent truncate">{logContainer.names?.[0] || logContainer.id}</span>
              {logStreaming && <span className="container-log-live">LIVE</span>}
            </div>
            <div className="flex items-center gap-1">
              {logStreaming && <button className="mini-btn text-red-400" onClick={closeLogs} title="Stop streaming"><StopCircle size={10} /></button>}
              <button className="mini-btn" onClick={closeLogs}>✕</button>
            </div>
          </div>
          <div className="container-log-body">
            <pre className="container-log-text">{logs}<div ref={logEndRef} /></pre>
          </div>
        </div>
      )}

      <div className="container-list panel-list">
        {containers.length === 0 && !loading && (
          <div className="container-empty">
            <Box size={20} className="text-muted mb-1" />
            <div className="text-[10px] text-muted">{t(lang, "noContainers")}</div>
          </div>
        )}
        {containers.map((c) => (
          <div key={c.id} className="container-item">
            <div className="container-item-main">
              <div className={`container-state-dot ${stateDot(c.state)}`} />
              <div className="container-item-info">
                <div className="container-name">{c.names?.[0] || c.id}</div>
                <div className="container-meta">
                  <span className={stateColor(c.state)}>{c.state}</span>
                  <span className="text-muted">·</span>
                  <span>{c.status}</span>
                </div>
                <div className="container-meta text-muted">
                  <span>{c.image}</span>
                  {c.ports && <><span>·</span><span>{c.ports}</span></>}
                </div>
              </div>
            </div>
            <div className="container-actions">
              <button className="container-action-btn" onClick={() => viewLogs(c)} title={t(lang, "viewLogs")}><Eye size={11} /></button>
              {c.state === "running" ? (
                <>
                  <button className="container-action-btn" onClick={() => restart(c)} title={t(lang, "restart")} disabled={actionLoading === c.id}>
                    {actionLoading === c.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                  </button>
                  <button className="container-action-btn text-red-400" onClick={() => stop(c)} title={t(lang, "stop")} disabled={actionLoading === c.id}>
                    <Square size={11} />
                  </button>
                </>
              ) : (
                <>
                  <button className="container-action-btn text-green-400" onClick={() => start(c)} title={t(lang, "start")} disabled={actionLoading === c.id}>
                    {actionLoading === c.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                  </button>
                  <button className="container-action-btn text-red-400" onClick={() => remove(c)} title={t(lang, "remove")} disabled={actionLoading === c.id}>
                    <Trash2 size={11} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
