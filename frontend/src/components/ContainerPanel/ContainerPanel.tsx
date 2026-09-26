import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Box, Eye, Loader2, Play, RefreshCw, RotateCcw, Square, StopCircle, Trash2 } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListContainers, StreamContainerLogs, StopContainerLogs, RestartContainer, StopContainer, StartContainer, RemoveContainer } from "../../../wailsjs/go/app/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { t, type LangKey } from "../../i18n";
import type { Tab, Toast } from "../../types";
import { isRemoteSession } from "../../utils/sessionIdentity";

const MAX_LOG_CHARS = 512 * 1024;
const LOG_FLUSH_MS = 75;
const ARM_TIMEOUT_MS = 3000;

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
  const [armedRemove, setArmedRemove] = useState("");
  const armedRemoveTimerRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const logBodyRef = useRef<HTMLDivElement>(null);
  const logStreamIdRef = useRef<string | null>(null);
  const pendingLogRef = useRef("");
  const pendingLogTimerRef = useRef<number | null>(null);
  // Follow the tail only while the reader is already at the bottom. Scrolling
  // on every chunk made the pane impossible to read back through.
  const stickToBottomRef = useRef(true);
  // Every call below captures the session it was issued against and drops its
  // result if the panel has moved on. Without that, a reply from host A landed
  // in host B's list — and a `docker rm -f` confirmed on A reported success
  // while B was on screen.
  const activeSessionRef = useRef(props.active?.id || "");
  const refreshSeqRef = useRef(0);
  activeSessionRef.current = props.active?.id || "";

  // A render-time ref cannot see a remount. The sidebar keys this panel by
  // session, so switching hosts unmounts this instance and mounts a new one —
  // and the unmounted copy's `activeSessionRef` stays frozen at the old id,
  // which made every "has the panel moved on?" guard below pass. A late reply
  // then still ran: `viewLogs` opened a `docker logs -f` on the host the user
  // had just left, and nothing was ever going to stop it, because the unmount
  // cleanup had already run before the stream id was assigned.
  //
  // The session half of the check is kept for the same instance — it is what
  // makes the panel correct if it is ever rendered without the key — so the two
  // conditions are asked together, in one place.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const stillOwnsSession = useCallback(
    (sessionID: string) => mountedRef.current && activeSessionRef.current === sessionID,
    [],
  );

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

  // Only a live remote session can be inspected. A local terminal or a Markdown
  // document has a tab id too, and polling one produced a "session not found"
  // toast every interval; a host without docker produced one every interval as
  // well. Both are gone with the session gate and the silent background poll.
  const sessionId = isRemoteSession(props.active) ? props.active.id : "";

  const refresh = useCallback(async (notifyOnError = true) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const list = await ListContainers(sessionID, showAll);
      if (seq !== refreshSeqRef.current || !stillOwnsSession(sessionID)) return;
      setContainers(list || []);
    } catch (err) {
      if (seq !== refreshSeqRef.current || !stillOwnsSession(sessionID)) return;
      if (notifyOnError) props.onNotify(String(err), "error");
      setContainers([]);
    } finally {
      if (seq === refreshSeqRef.current && stillOwnsSession(sessionID)) setLoading(false);
    }
  }, [sessionId, showAll, props.onNotify, stillOwnsSession]);

  useEffect(() => {
    if (!sessionId) {
      setContainers([]);
      return;
    }
    // The first load reports failures; the interval does not, so a panel left
    // open on a host without docker stays quiet.
    void refresh(true);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => { void refresh(false); }, 10000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [sessionId, refresh]);

  const onLogScroll = useCallback(() => {
    const el = logBodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  useEffect(() => {
    const el = logBodyRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
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
    // The per-row spinners and the armed-remove highlight belong to the session
    // that was on screen, not to the one replacing it.
    setActionLoading(null);
    setArmedRemove("");
    if (armedRemoveTimerRef.current !== null) {
      window.clearTimeout(armedRemoveTimerRef.current);
      armedRemoveTimerRef.current = null;
    }
  }, [props.active?.id]);

  const viewLogs = useCallback(async (c: types.ContainerInfo) => {
    const sessionID = props.active?.id;
    if (!sessionID) return;
    const previousStream = logStreamIdRef.current;
    if (previousStream) {
      await StopContainerLogs(previousStream).catch(() => {});
    }
    // The stop above is a round trip, so re-check before opening the stream:
    // otherwise the panel would follow a container on the host it just left.
    if (!stillOwnsSession(sessionID)) return;
    flushPendingLogs();
    const streamID = nextLogStreamId();
    setLogContainer(c);
    logStreamIdRef.current = streamID;
    setLogs("");
    setLogStreaming(true);
    // A freshly opened log starts at its end.
    stickToBottomRef.current = true;
    try {
      await StreamContainerLogs(sessionID, c.id, streamID, 200);
    } catch (err) {
      if (!stillOwnsSession(sessionID)) return;
      if (logStreamIdRef.current === streamID) {
        logStreamIdRef.current = null;
        setLogStreaming(false);
      }
      onNotifyRef.current(String(err), "error");
    }
  }, [props.active?.id, flushPendingLogs, stillOwnsSession]);

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

  // Stopping the stream is not the same as closing the pane: the output stays
  // on screen to be read, copied, or scrolled through. Closing used to be the
  // only way to stop, and it threw the log away.
  const stopStreaming = useCallback(() => {
    const streamID = logStreamIdRef.current;
    if (streamID) {
      StopContainerLogs(streamID).catch(() => {});
    }
    logStreamIdRef.current = null;
    flushPendingLogs();
    setLogStreaming(false);
  }, [flushPendingLogs]);

  useEffect(() => {
    return () => {
      if (logStreamIdRef.current) {
        StopContainerLogs(logStreamIdRef.current).catch(() => {});
      }
      if (pendingLogTimerRef.current !== null) window.clearTimeout(pendingLogTimerRef.current);
      if (armedRemoveTimerRef.current !== null) window.clearTimeout(armedRemoveTimerRef.current);
    };
  }, []);

  // One place for the four mutations: each is issued against the session that
  // was on screen when it was clicked, and neither the toast nor the refreshed
  // list is applied if the panel has moved to another host meanwhile.
  const runContainerAction = useCallback(
    async (c: types.ContainerInfo, verb: LangKey, run: (sessionID: string) => Promise<unknown>) => {
      const sessionID = props.active?.id;
      if (!sessionID) return;
      setActionLoading(c.id);
      try {
        await run(sessionID);
        if (!stillOwnsSession(sessionID)) return;
        props.onNotify(`${c.names?.[0] || c.id}: ${t(lang, verb)}`, "success");
        await refresh();
      } catch (err) {
        if (!stillOwnsSession(sessionID)) return;
        props.onNotify(String(err), "error");
      } finally {
        if (stillOwnsSession(sessionID)) setActionLoading(null);
      }
    },
    [props.active?.id, refresh, props.onNotify, lang, stillOwnsSession],
  );

  const restart = useCallback((c: types.ContainerInfo) => (
    runContainerAction(c, "containerRestarted", (sessionID) => RestartContainer(sessionID, c.id))
  ), [runContainerAction]);

  const stop = useCallback((c: types.ContainerInfo) => (
    runContainerAction(c, "containerStopped", (sessionID) => StopContainer(sessionID, c.id))
  ), [runContainerAction]);

  const start = useCallback((c: types.ContainerInfo) => (
    runContainerAction(c, "containerStarted", (sessionID) => StartContainer(sessionID, c.id))
  ), [runContainerAction]);

  const remove = useCallback((c: types.ContainerInfo) => {
    // `docker rm -f` cannot be undone, and the button sits directly next to
    // "start", so removal takes two clicks within three seconds — the same
    // arming the service panel uses for stop/restart/disable.
    if (armedRemove !== c.id) {
      if (armedRemoveTimerRef.current !== null) window.clearTimeout(armedRemoveTimerRef.current);
      setArmedRemove(c.id);
      armedRemoveTimerRef.current = window.setTimeout(() => {
        armedRemoveTimerRef.current = null;
        setArmedRemove("");
      }, ARM_TIMEOUT_MS);
      return;
    }
    if (armedRemoveTimerRef.current !== null) {
      window.clearTimeout(armedRemoveTimerRef.current);
      armedRemoveTimerRef.current = null;
    }
    setArmedRemove("");
    void runContainerAction(c, "containerRemoved", (sessionID) => RemoveContainer(sessionID, c.id, true));
  }, [armedRemove, runContainerAction]);

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

  if (!sessionId) {
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
          <span><strong>{t(lang, "containers")}</strong><small>{t(lang, "containerCount", { count: String(containers.length) })}</small></span>
        </div>
        <div className="panel-page-actions">
          <label className="panel-page-check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="w-2.5 h-2.5" />
            {t(lang, "showAll")}
          </label>
          <button className="panel-page-action" onClick={() => void refresh()} disabled={loading}><RefreshCw size={11} className={loading ? "animate-spin" : ""} /></button>
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
              {logStreaming && <button className="mini-btn text-red-400" onClick={stopStreaming} title={t(lang, "svcStopFollow")}><StopCircle size={10} /></button>}
              <button className="mini-btn" onClick={closeLogs} title={t(lang, "close")}>✕</button>
            </div>
          </div>
          <div className="container-log-body" ref={logBodyRef} onScroll={onLogScroll}>
            <pre className="container-log-text">{logs}</pre>
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
                  <button className="container-action-btn" onClick={() => void restart(c)} title={t(lang, "restart")} disabled={actionLoading === c.id}>
                    {actionLoading === c.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                  </button>
                  <button className="container-action-btn text-red-400" onClick={() => void stop(c)} title={t(lang, "stop")} disabled={actionLoading === c.id}>
                    <Square size={11} />
                  </button>
                </>
              ) : (
                <>
                  <button className="container-action-btn text-green-400" onClick={() => void start(c)} title={t(lang, "start")} disabled={actionLoading === c.id}>
                    {actionLoading === c.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                  </button>
                  <button
                    className={clsx("container-action-btn", "text-red-400", armedRemove === c.id && "action-armed")}
                    onClick={() => void remove(c)}
                    title={armedRemove === c.id ? t(lang, "confirm") : t(lang, "remove")}
                    disabled={actionLoading === c.id}
                  >
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
