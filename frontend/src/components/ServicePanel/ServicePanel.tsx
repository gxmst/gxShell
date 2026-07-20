import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Cog,
  Eye,
  Loader2,
  Play,
  Power,
  PowerOff,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
} from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import {
  ListServices,
  ServiceAction,
  ServiceLogs,
  StopServiceLogs,
  StreamServiceLogs,
} from "../../../wailsjs/go/main/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { t, type LangKey } from "../../i18n";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import type { Tab, Toast } from "../../types";

const MAX_LOG_CHARS = 512 * 1024;
const LOG_FLUSH_MS = 75;
const ARM_TIMEOUT_MS = 3000;

// Payload of the Go-side "service:log" event (a map[string]string). Identical
// semantics to "docker:log": the backend may batch several journal lines into
// one event, so `data` can contain embedded newlines; it is appended verbatim.
interface ServiceLogEvent {
  streamID?: string;
  sessionID?: string;
  unit?: string;
  data?: string;
  /** "true" when the stream has ended. */
  done?: string;
}

type ServiceFilter = "all" | "running" | "failed";
type ServiceActionName = "start" | "stop" | "restart" | "enable" | "disable";

function nextLogStreamId() {
  return `svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function appendBoundedLog(previous: string, chunk: string) {
  const combined = previous + chunk;
  if (combined.length <= MAX_LOG_CHARS) return combined;
  return `[gxShell: older service log output was truncated]\n${combined.slice(combined.length - MAX_LOG_CHARS)}`;
}

// Units the backend refuses to stop/disable without force because losing them
// can cut the SSH session (sshd itself or the network stack under it).
function isCriticalUnit(name: string) {
  const base = name.replace(/\.service$/, "");
  if (base.toLowerCase().startsWith("ssh")) return true;
  return (
    base === "systemd-networkd" ||
    base === "NetworkManager" ||
    base === "networking"
  );
}

const ACTION_LABEL: Record<ServiceActionName, LangKey> = {
  start: "start",
  stop: "stop",
  restart: "restart",
  enable: "enable",
  disable: "disable",
};

export function ServicePanel(props: {
  active?: Tab;
  locale: string;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
}) {
  const lang = props.locale;
  const [services, setServices] = useState<types.ServiceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ServiceFilter>("all");
  const [query, setQuery] = useState("");
  const [logUnit, setLogUnit] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [following, setFollowing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [forceReq, setForceReq] = useState<{
    unit: string;
    action: ServiceActionName;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const armedTimerRef = useRef<number | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logStreamIdRef = useRef<string | null>(null);
  const pendingLogRef = useRef("");
  const pendingLogTimerRef = useRef<number | null>(null);
  const activeSessionRef = useRef(props.active?.id || "");
  const refreshSeqRef = useRef(0);
  const logRequestSeqRef = useRef(0);
  activeSessionRef.current = props.active?.id || "";

  const onNotifyRef = useRef(props.onNotify);
  onNotifyRef.current = props.onNotify;

  const flushPendingLogs = useCallback(() => {
    if (pendingLogTimerRef.current !== null) {
      window.clearTimeout(pendingLogTimerRef.current);
      pendingLogTimerRef.current = null;
    }
    const chunk = pendingLogRef.current;
    pendingLogRef.current = "";
    if (chunk) setLogs((previous) => appendBoundedLog(previous, chunk));
  }, []);

  const queueLogChunk = useCallback(
    (chunk: string) => {
      pendingLogRef.current += chunk;
      if (pendingLogRef.current.length >= 32 * 1024) {
        flushPendingLogs();
        return;
      }
      if (pendingLogTimerRef.current === null) {
        pendingLogTimerRef.current = window.setTimeout(
          flushPendingLogs,
          LOG_FLUSH_MS,
        );
      }
    },
    [flushPendingLogs],
  );

  const refresh = useCallback(async () => {
    const sessionID = props.active?.id;
    if (!sessionID) return;
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const list = await ListServices(sessionID);
      if (
        seq !== refreshSeqRef.current ||
        activeSessionRef.current !== sessionID
      )
        return;
      setServices(list || []);
      setListError(null);
    } catch (err) {
      if (
        seq !== refreshSeqRef.current ||
        activeSessionRef.current !== sessionID
      )
        return;
      const msg = String(err);
      setServices([]);
      if (/systemd/i.test(msg)) {
        setListError(msg);
      } else {
        setListError(null);
        props.onNotify(msg, "error");
      }
    } finally {
      if (
        seq === refreshSeqRef.current &&
        activeSessionRef.current === sessionID
      )
        setLoading(false);
    }
  }, [props.active?.id, props.onNotify]);

  useEffect(() => {
    logRequestSeqRef.current++;
    refresh();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(refresh, 15000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  useEffect(() => {
    const off = EventsOn("service:log", (data: ServiceLogEvent) => {
      if (!data?.streamID || data.streamID !== logStreamIdRef.current) return;
      if (data.done === "true") {
        flushPendingLogs();
        logStreamIdRef.current = null;
        setFollowing(false);
        return;
      }
      if (data.data) {
        queueLogChunk(data.data);
      }
    });
    return () => off();
  }, [flushPendingLogs, queueLogChunk]);

  // Session change: drop the stream and every per-session bit of state.
  useEffect(() => {
    const streamID = logStreamIdRef.current;
    if (streamID) StopServiceLogs(streamID).catch(() => {});
    logStreamIdRef.current = null;
    pendingLogRef.current = "";
    if (pendingLogTimerRef.current !== null) {
      window.clearTimeout(pendingLogTimerRef.current);
      pendingLogTimerRef.current = null;
    }
    setLogUnit(null);
    setLogs("");
    setFollowing(false);
    setArmed(null);
    setForceReq(null);
    setListError(null);
  }, [props.active?.id]);

  useEffect(() => {
    return () => {
      if (logStreamIdRef.current) {
        StopServiceLogs(logStreamIdRef.current).catch(() => {});
      }
      if (pendingLogTimerRef.current !== null)
        window.clearTimeout(pendingLogTimerRef.current);
      if (armedTimerRef.current !== null)
        window.clearTimeout(armedTimerRef.current);
    };
  }, []);

  const stopFollow = useCallback(() => {
    const streamID = logStreamIdRef.current;
    if (streamID) StopServiceLogs(streamID).catch(() => {});
    logStreamIdRef.current = null;
    flushPendingLogs();
    setFollowing(false);
  }, [flushPendingLogs]);

  const closeLogs = useCallback(() => {
    stopFollow();
    setLogUnit(null);
    setLogs("");
  }, [stopFollow]);

  const openLogs = useCallback(
    async (unit: string) => {
      const sessionID = props.active?.id;
      if (!sessionID) return;
      if (logUnit === unit) {
        closeLogs();
        return;
      }
      stopFollow();
      const seq = ++logRequestSeqRef.current;
      setLogUnit(unit);
      setLogs("");
      try {
        const text = await ServiceLogs(sessionID, unit, 200);
        if (
          seq !== logRequestSeqRef.current ||
          activeSessionRef.current !== sessionID
        )
          return;
        setLogs(text || "");
      } catch (err) {
        if (
          seq !== logRequestSeqRef.current ||
          activeSessionRef.current !== sessionID
        )
          return;
        onNotifyRef.current(String(err), "error");
      }
    },
    [props.active?.id, logUnit, stopFollow, closeLogs],
  );

  const startFollow = useCallback(
    async (unit: string) => {
      const sessionID = props.active?.id;
      if (!sessionID) return;
      stopFollow();
      // Restart from a fresh 200-line tail so the pane never shows duplicated
      // lines between the static tail and the live stream.
      const streamID = nextLogStreamId();
      const seq = ++logRequestSeqRef.current;
      logStreamIdRef.current = streamID;
      setLogs("");
      setFollowing(true);
      try {
        await StreamServiceLogs(sessionID, unit, streamID, 200);
        if (
          seq !== logRequestSeqRef.current ||
          activeSessionRef.current !== sessionID
        ) {
          StopServiceLogs(streamID).catch(() => {});
          return;
        }
      } catch (err) {
        if (
          seq === logRequestSeqRef.current &&
          activeSessionRef.current === sessionID &&
          logStreamIdRef.current === streamID
        ) {
          logStreamIdRef.current = null;
          setFollowing(false);
          onNotifyRef.current(String(err), "error");
        }
      }
    },
    [props.active?.id, stopFollow],
  );

  const clearArm = useCallback(() => {
    if (armedTimerRef.current !== null) {
      window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = null;
    }
    setArmed(null);
  }, []);

  const arm = useCallback((key: string) => {
    if (armedTimerRef.current !== null)
      window.clearTimeout(armedTimerRef.current);
    setArmed(key);
    armedTimerRef.current = window.setTimeout(() => {
      armedTimerRef.current = null;
      setArmed(null);
    }, ARM_TIMEOUT_MS);
  }, []);

  const doAction = useCallback(
    async (unit: string, action: ServiceActionName, force: boolean) => {
      if (!props.active?.id) return;
      setActionLoading(unit);
      try {
        await ServiceAction(props.active.id, unit, action, force);
        onNotifyRef.current(
          t(lang, "svcActionOk", {
            name: unit,
            action: t(lang, ACTION_LABEL[action]),
          }),
          "success",
        );
        await refresh();
      } catch (err) {
        const msg = String(err);
        // The backend refuses stop/disable on SSH/network-critical units unless
        // force=true; surface the lockout warning and let the user retry forced.
        if (
          !force &&
          action !== "start" &&
          (isCriticalUnit(unit) || /force/i.test(msg))
        ) {
          setForceReq({ unit, action });
        } else {
          onNotifyRef.current(msg, "error");
        }
      } finally {
        setActionLoading(null);
      }
    },
    [props.active?.id, refresh, lang],
  );

  // stop / restart / disable are two-step: first click arms the button
  // (warning color + confirm hint), second click within 3s executes.
  const requestAction = useCallback(
    (unit: string, action: ServiceActionName) => {
      const destructive =
        action === "stop" || action === "restart" || action === "disable";
      const key = `${unit}:${action}`;
      if (destructive && armed !== key) {
        arm(key);
        return;
      }
      clearArm();
      doAction(unit, action, false);
    },
    [armed, arm, clearArm, doAction],
  );

  const failedCount = useMemo(
    () => services.filter((s) => s.activeState === "failed").length,
    [services],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services.filter((s) => {
      if (filter === "running" && s.activeState !== "active") return false;
      if (filter === "failed" && s.activeState !== "failed") return false;
      if (
        q &&
        !s.name.toLowerCase().includes(q) &&
        !(s.description || "").toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [services, filter, query]);

  const stateDot = (state: string) => {
    switch (state) {
      case "active":
        return "bg-ok";
      case "failed":
        return "bg-bad";
      case "activating":
      case "deactivating":
        return "bg-warn";
      default:
        return "bg-muted";
    }
  };

  const stateColor = (state: string) => {
    switch (state) {
      case "active":
        return "text-ok";
      case "failed":
        return "text-bad";
      case "activating":
      case "deactivating":
        return "text-warn";
      default:
        return "text-muted";
    }
  };

  const actionButton = (
    svc: types.ServiceInfo,
    action: ServiceActionName,
    icon: JSX.Element,
    extraClass?: string,
  ) => {
    const key = `${svc.name}:${action}`;
    const isArmed = armed === key;
    const busy = actionLoading === svc.name;
    return (
      <button
        className={clsx(
          "container-action-btn",
          extraClass,
          isArmed && "action-armed",
        )}
        onClick={() => requestAction(svc.name, action)}
        title={isArmed ? t(lang, "confirm") : t(lang, ACTION_LABEL[action])}
        disabled={busy}
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin" />
        ) : isArmed ? (
          <AlertTriangle size={11} />
        ) : (
          icon
        )}
      </button>
    );
  };

  if (!props.active?.id) {
    return (
      <div className="service-panel panel-page">
        <div className="container-empty">
          <Cog size={28} className="text-muted mb-2" />
          <div className="text-[11px] text-muted">
            {t(lang, "noActiveSession")}
          </div>
        </div>
      </div>
    );
  }

  const isActiveState = (s: types.ServiceInfo) =>
    s.activeState === "active" || s.activeState === "activating";

  return (
    <div className="service-panel panel-page">
      <div className="service-header panel-page-header">
        <div className="panel-page-heading">
          <span className="panel-page-icon">
            <Cog size={14} />
          </span>
          <span>
            <strong>{t(lang, "services")}</strong>
            <small>{t(lang, "svcCount", { n: String(services.length) })}</small>
          </span>
        </div>
        <div className="panel-page-actions">
          <button
            className="panel-page-action"
            onClick={refresh}
            disabled={loading}
            title={t(lang, "refresh")}
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="service-toolbar">
        <div className="svc-search">
          <Search size={11} />
          <input
            className="svc-search-input"
            value={query}
            placeholder={t(lang, "svcSearch")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="svc-chip-row">
          <button
            className={clsx("svc-chip", filter === "all" && "svc-chip-active")}
            onClick={() => setFilter("all")}
          >
            {t(lang, "all")}
          </button>
          <button
            className={clsx(
              "svc-chip",
              filter === "running" && "svc-chip-active",
            )}
            onClick={() => setFilter("running")}
          >
            {t(lang, "svcRunning")}
          </button>
          <button
            className={clsx(
              "svc-chip",
              filter === "failed" && "svc-chip-active",
            )}
            onClick={() => setFilter("failed")}
          >
            {t(lang, "svcFailed")}
            {failedCount > 0 && (
              <span className="svc-chip-badge">{failedCount}</span>
            )}
          </button>
        </div>
      </div>

      {logUnit && (
        <div className="container-log-panel">
          <div className="container-log-header">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold text-accent truncate">
                {logUnit}
              </span>
              {following && <span className="container-log-live">LIVE</span>}
            </div>
            <div className="flex items-center gap-1">
              <button
                className={clsx("mini-btn", following && "text-ok")}
                onClick={() =>
                  following ? stopFollow() : startFollow(logUnit)
                }
                title={t(lang, following ? "svcStopFollow" : "svcFollow")}
              >
                <Radio size={10} />
              </button>
              <button
                className="mini-btn"
                onClick={closeLogs}
                title={t(lang, "close")}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="container-log-body">
            <pre className="container-log-text">
              {logs}
              <div ref={logEndRef} />
            </pre>
          </div>
        </div>
      )}

      <div className="service-list panel-list">
        {filtered.length === 0 && !loading && (
          <div className="container-empty">
            <Cog size={20} className="text-muted mb-1" />
            <div className="text-[10px] text-muted">
              {listError ? t(lang, "svcNoSystemd") : t(lang, "noServices")}
            </div>
          </div>
        )}
        {filtered.map((s) => (
          <div key={s.name} className="container-item svc-item">
            <div className="container-item-main">
              <div
                className={`container-state-dot ${stateDot(s.activeState)}`}
              />
              <div className="container-item-info">
                <div className="container-name svc-name-row">
                  <span title={s.name}>{s.name}</span>
                  {s.enabled && (
                    <span
                      className={clsx(
                        "svc-tag",
                        s.enabled === "enabled" && "svc-tag-enabled",
                        s.enabled === "masked" && "svc-tag-masked",
                      )}
                    >
                      {s.enabled}
                    </span>
                  )}
                </div>
                <div className="container-meta">
                  <span className={stateColor(s.activeState)}>
                    {s.activeState}
                  </span>
                  <span className="text-muted">·</span>
                  <span>{s.subState}</span>
                </div>
                {s.description && (
                  <div className="container-meta text-muted">
                    <span title={s.description}>{s.description}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="container-actions">
              <button
                className={clsx(
                  "container-action-btn",
                  logUnit === s.name && "text-accent",
                )}
                onClick={() => openLogs(s.name)}
                title={t(lang, "viewLogs")}
              >
                <Eye size={11} />
              </button>
              {isActiveState(s) ? (
                <>
                  {actionButton(s, "restart", <RotateCcw size={11} />)}
                  {actionButton(s, "stop", <Square size={11} />, "text-bad")}
                </>
              ) : (
                actionButton(s, "start", <Play size={11} />, "text-ok")
              )}
              {s.enabled === "enabled" &&
                actionButton(s, "disable", <PowerOff size={11} />, "text-warn")}
              {s.enabled === "disabled" &&
                actionButton(s, "enable", <Power size={11} />, "text-ok")}
            </div>
          </div>
        ))}
      </div>

      {forceReq && (
        <ConfirmDialog
          locale={lang}
          title={t(lang, "svcCriticalTitle")}
          body={t(lang, "svcCriticalBody", {
            name: forceReq.unit,
            action: t(lang, ACTION_LABEL[forceReq.action]),
          })}
          confirmText={t(lang, "svcForceConfirm")}
          onConfirm={() => {
            const req = forceReq;
            setForceReq(null);
            doAction(req.unit, req.action, true);
          }}
          onClose={() => setForceReq(null)}
        />
      )}
    </div>
  );
}
