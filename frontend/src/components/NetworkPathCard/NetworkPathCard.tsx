import { useEffect, useState } from "react";
import clsx from "clsx";
import { Activity, Globe, Loader2, RefreshCw, Router, Wifi, WifiOff } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { FloatingCard } from "../FloatingCard/FloatingCard";

interface NetworkPathCardProps {
  sessionId: string;
  initialLeft: number;
  initialTop: number;
  locale: string;
  onClose: () => void;
  onTraceRoute: (sessionId: string) => Promise<types.NetworkPath>;
  onPingHost: (sessionId: string, count: number) => Promise<types.NetworkPath>;
}

export function NetworkPathCard({ sessionId, initialLeft, initialTop, locale, onClose, onTraceRoute, onPingHost }: NetworkPathCardProps) {
  const lang = locale || "en";
  const [path, setPath] = useState<types.NetworkPath | null>(null);
  const [loading, setLoading] = useState(false);
  const [tracing, setTracing] = useState(false);

  useEffect(() => {
    const ping = async () => {
      setLoading(true);
      try {
        const result = await onPingHost(sessionId, 4);
        setPath(result);
      } catch { }
      setLoading(false);
    };
    ping();
  }, [sessionId, onPingHost]);

  const handleTrace = async () => {
    setTracing(true);
    try {
      const result = await onTraceRoute(sessionId);
      setPath((prev) => {
        if (!prev) return result;
        const merged = types.NetworkPath.createFrom({ ...prev, hops: result.hops });
        return merged;
      });
    } catch { }
    setTracing(false);
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const result = await onPingHost(sessionId, 4);
      setPath(result);
    } catch { }
    setLoading(false);
  };

  const rttColor = (ms: number) => {
    if (ms <= 0) return "text-muted";
    if (ms < 50) return "text-ok";
    if (ms < 150) return "text-warn";
    return "text-bad";
  };

  const lossColor = (pct: number) => {
    if (pct <= 0) return "text-ok";
    if (pct < 10) return "text-warn";
    return "text-bad";
  };

  return (
    <FloatingCard initialLeft={initialLeft} initialTop={initialTop} width={340} onClose={onClose}>
      <div className="npc-header">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-accent" />
          <span className="text-[12px] font-semibold">{t(lang, "networkPath")}</span>
        </div>
        <button className="npc-icon-btn" onClick={handleRefresh} title={t(lang, "refresh")} disabled={loading}>
          <RefreshCw size={12} className={clsx(loading && "animate-spin")} />
        </button>
      </div>

      {loading && !path && (
        <div className="npc-loading">
          <Loader2 size={16} className="animate-spin text-accent" />
          <span className="text-[10px] text-muted">{t(lang, "loading")}</span>
        </div>
      )}

      {path && (
        <div className="npc-stats">
          <div className="npc-stat">
            <Wifi size={11} />
            <span className="npc-stat-label">{t(lang, "ping")}</span>
            <span className={clsx("npc-stat-value", rttColor(path.pingAvg))}>{path.pingAvg > 0 ? `${path.pingAvg.toFixed(1)}ms` : "-"}</span>
          </div>
          <div className="npc-stat">
            <Activity size={11} />
            <span className="npc-stat-label">{t(lang, "jitter")}</span>
            <span className="npc-stat-value">{path.jitter > 0 ? `${path.jitter.toFixed(1)}ms` : "-"}</span>
          </div>
          <div className="npc-stat">
            <WifiOff size={11} />
            <span className="npc-stat-label">{t(lang, "loss")}</span>
            <span className={clsx("npc-stat-value", lossColor(path.pingLoss))}>{path.pingLoss > 0 ? `${path.pingLoss.toFixed(0)}%` : "0%"}</span>
          </div>
          <div className="npc-stat">
            <Activity size={11} />
            <span className="npc-stat-label">Min/Max</span>
            <span className="npc-stat-value">{path.pingMin > 0 ? `${path.pingMin.toFixed(1)}/${path.pingMax.toFixed(1)}ms` : "-"}</span>
          </div>
        </div>
      )}

      <div className="npc-hops-section">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium text-muted">{t(lang, "routeHops")}</span>
          <button className="npc-trace-btn" onClick={handleTrace} disabled={tracing}>
            {tracing ? <Loader2 size={11} className="animate-spin" /> : <Router size={11} />}
            {tracing ? t(lang, "tracing") : t(lang, "traceRoute")}
          </button>
        </div>

        {path && path.hops && path.hops.length > 0 ? (
          <div className="npc-hops-list">
            {path.hops.map((hop) => (
              <div key={hop.index} className={clsx("npc-hop", hop.timeout && "npc-hop-timeout")}>
                <div className="npc-hop-index">{hop.index}</div>
                <div className="npc-hop-line" />
                <div className="npc-hop-info">
                  <div className="npc-hop-addr">
                    {hop.timeout ? (
                      <span className="text-muted">*</span>
                    ) : (
                      <>
                        <Router size={10} className="text-accent shrink-0" />
                        <span className="truncate">{hop.ip || hop.host}</span>
                      </>
                    )}
                  </div>
                  {!hop.timeout && (
                    <div className="npc-hop-rtt">
                      <span className={rttColor(hop.rtt1)}>{hop.rtt1 > 0 ? `${hop.rtt1.toFixed(1)}` : "*"}</span>
                      <span className="text-muted">/</span>
                      <span className={rttColor(hop.rtt2)}>{hop.rtt2 > 0 ? `${hop.rtt2.toFixed(1)}` : "*"}</span>
                      <span className="text-muted">/</span>
                      <span className={rttColor(hop.rtt3)}>{hop.rtt3 > 0 ? `${hop.rtt3.toFixed(1)}` : "*"}</span>
                      <span className="text-muted text-[9px]">ms</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="npc-no-hops">
            <Router size={20} className="text-muted" />
            <span className="text-[10px] text-muted">{t(lang, "clickTraceRoute")}</span>
          </div>
        )}
      </div>
    </FloatingCard>
  );
}
