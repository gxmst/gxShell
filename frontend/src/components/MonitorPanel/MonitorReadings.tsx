import { Activity, Gauge } from "lucide-react";
import type { types } from "../../../wailsjs/go/models";
import { probeLatency } from "../../utils/format";
import { t } from "../../i18n";

type ReadingProps = { metrics?: types.Metrics; lang: string };

export function LoadAverages({ metrics, lang, onClick }: ReadingProps & { onClick?: () => void }) {
  const values = metrics?.loadAverage?.trim().split(/\s+/) ?? [];
  const cpus = metrics?.cpuCount ?? 0;
  const content = <>
    <span className="monitor-reading-title"><Gauge size={12} />{t(lang, "averageLoad")}
      {cpus > 0 && <small>{t(lang, "logicalCpus", { count: String(cpus) })}</small>}
    </span>
    <span className="load-windows">{[1, 5, 15].map((minutes, index) => {
      const value = values[index] ? Number(values[index]) : NaN;
      const pressure = cpus > 0 ? value / cpus : NaN;
      return <span key={minutes}><small>{t(lang, "loadMinutes", { n: String(minutes) })}</small>
        <strong className={pressure >= 1 ? "text-warn" : ""}>{Number.isFinite(value) ? value.toFixed(2) : "—"}</strong>
      </span>;
    })}</span>
  </>;
  return onClick
    ? <button type="button" className="monitor-reading" title={t(lang, "averageLoadHint")} onClick={onClick}>{content}</button>
    : <div className="monitor-reading" title={t(lang, "averageLoadHint")}>{content}</div>;
}

export function ConnectionQuality({ metrics, lang }: ReadingProps) {
  const samples = metrics?.probeHistory ?? [];
  const last = samples.at(-1);
  const attempts = samples.filter(s => s.state !== "unavailable");
  const misses = attempts.filter(s => s.state === "lost").length;
  const loss = attempts.length ? (100 * misses / attempts.length).toFixed(1) + "%" : "—";
  const latency = last?.state === "reply" ? probeLatency(last.rttMs) : last ? t(lang, last.state === "lost" ? "probeNoReply" : "probeUnavailable") : "—";
  const hint = t(lang, last?.method === "ssh" ? "sshProbeHint" : "icmpProbeHint");
  return <div className="monitor-reading" title={hint}>
    <span className="monitor-reading-title"><Activity size={12} />{t(lang, "connectionQuality")}
      {last && <small>{last.method.toUpperCase()}</small>}
    </span>
    <div className="probe-values">
      <span>{t(lang, "latency")} <strong>{latency}</strong></span>
      <span>{t(lang, last?.method === "ssh" ? "probeFailureRate" : "packetLossRate")} <strong className={misses ? "text-warn" : ""}>{loss}</strong></span>
    </div>
    <div className="probe-strip" role="img" aria-label={t(lang, "probeHistory", { total: String(attempts.length), lost: String(misses) })}>
      {Array.from({ length: 20 }, (_, i) => {
        const sample = samples[i - (20 - samples.length)];
        const value = sample?.state === "reply" ? probeLatency(sample.rttMs) : t(lang, sample?.state === "lost" ? "probeNoReply" : "probeUnavailable");
        const hint = sample ? new Date(sample.at).toLocaleTimeString() + " · " + value : undefined;
        return <i key={i} className={sample?.state} title={hint} />;
      })}
    </div>
  </div>;
}
