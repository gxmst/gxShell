import { useState } from "react";
import clsx from "clsx";
import { Activity, AlertTriangle, ChevronDown, ChevronRight, Download, Gauge, HardDrive, MemoryStick, Upload, Wifi, Zap } from "lucide-react";
import type { Tab } from "../../types";
import { formatBytes, stateClass } from "../../utils/format";
import { useSessionMetrics } from "../../hooks/useSessionMetrics";
import { t } from "../../i18n";

export function MonitorPanel({ active, locale, onStart, onCpuClick, onPingClick, onDiskClick, onMemClick, onNetworkClick }: { active?: Tab; locale?: string; onStart: () => void; onCpuClick?: () => void; onPingClick?: () => void; onDiskClick?: () => void; onMemClick?: () => void; onNetworkClick?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  // Subscribes to monitor:update itself so each collection tick re-renders
  // only this panel, not the whole Sidebar tree it lives in.
  const metrics = useSessionMetrics(active?.id);
  const lang = locale || "en";
  if (!active) return <div className="empty compact">{t(lang, "openTerminal")}</div>;
  return (
    <div className="monitor-panel">
      <div className="current-card">
        <button className="mini-btn" onClick={onPingClick} disabled={!onPingClick} title={t(lang, "networkPath")}><Wifi size={13} className={clsx(active.state === "connected" ? "text-ok" : "text-muted")} /></button>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{active.title}</span>
        <span className={clsx("status-dot", stateClass(active.state))} />
      </div>
      {!metrics && <button className="btn-secondary w-full text-[11px]" onClick={onStart}><Activity size={13} /> {t(lang, "startMonitor")}</button>}
      {metrics && metrics.error && (
        <div className="flex items-start gap-1.5 rounded bg-warn/10 px-2 py-1.5 text-[10px] text-warn">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>{t(lang, "monitorLinuxOnly")}</span>
        </div>
      )}
      {metrics && (
        <>
          <MetricRow icon={<Gauge size={12} />} label={t(lang, "cpu")} value={metrics.cpuPercent} clickable onClick={onCpuClick} />
          <MetricRow icon={<MemoryStick size={12} />} label={t(lang, "mem")} value={metrics.memoryPercent} detail={`${metrics.memoryUsedMb || 0}/${metrics.memoryTotalMb || 0} MB`} clickable onClick={onMemClick} />
          <MetricRow icon={<HardDrive size={12} />} label={t(lang, "disk")} value={metrics.diskPercent} detail={`${metrics.diskUsed || "-"} / ${metrics.diskTotal || "-"}`} clickable onClick={onDiskClick} />
          <div className="chip-grid compact-chip-grid">
            <MiniMetric icon={<Zap size={11} />} label={t(lang, "load")} value={metrics.loadAverage || "-"} tone={loadTone(metrics.loadAverage)} clickable onClick={onCpuClick} />
            <MiniMetric icon={<Activity size={11} />} label={t(lang, "collectionTime")} value={`${metrics.latencyMs || 0}ms`} />
            <MiniMetric icon={<Download size={11} />} label={t(lang, "down")} value={formatBytes(metrics.networkRxPerSec)} tone={speedTone(metrics.networkRxPerSec)} clickable onClick={onNetworkClick} />
            <MiniMetric icon={<Upload size={11} />} label={t(lang, "up")} value={formatBytes(metrics.networkTxPerSec)} tone={speedTone(metrics.networkTxPerSec)} clickable onClick={onNetworkClick} />
          </div>
          <div className="pt-1 border-t border-border/50">
            <button className="process-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t(lang, "topProcesses")}
            </button>
            {expanded && metrics.topProcesses?.slice(0, 5).map((p) => (
              <div key={`${p.pid}-${p.command}`} className="process-row">
                <span className="truncate font-mono">{p.command}</span><span className="font-mono font-semibold">{p.memory.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function loadTone(loadAvg: string): "ok" | "warn" | "bad" | undefined {
  const v = parseFloat(loadAvg);
  if (isNaN(v)) return undefined;
  if (v >= 4) return "bad";
  if (v >= 2) return "warn";
  return "ok";
}

function speedTone(bps: number): "ok" | "warn" | "bad" | undefined {
  if (!bps || bps <= 0) return undefined;
  const kbps = bps / 1024;
  if (kbps >= 1024) return "bad";
  if (kbps >= 256) return "warn";
  return "ok";
}

function MetricRow({ icon, label, value, detail, clickable, onClick }: { icon: JSX.Element; label: string; value: number; detail?: string; clickable?: boolean; onClick?: () => void }) {
  const safe = Math.max(0, Math.min(100, value || 0));
  const tone = safe >= 85 ? "bad" : safe >= 60 ? "warn" : "ok";
  return (
    <div className={clsx("metric-row", clickable && "metric-row-clickable")} onClick={clickable ? onClick : undefined} title={clickable ? `${label}: ${detail || `${safe.toFixed(0)}%`}` : undefined}>
      <div className={clsx("metric-icon", `metric-${tone}`)}>{icon}</div>
      <div className="metric-row-content">
        <div className="flex items-center justify-between text-[10.5px]">
          <span className="font-medium">{label}</span>
          <span className="truncate font-mono text-muted text-[10px] tabular-nums">{detail || `${safe.toFixed(0)}%`}</span>
        </div>
        <div className="meter w-full"><div className={clsx("meter-fill", `meter-${tone}`)} style={{ width: `${safe}%` }} /></div>
      </div>
    </div>
  );
}

function MiniMetric({ icon, label, value, tone, clickable, onClick }: { icon: JSX.Element; label: string; value: string; tone?: "ok" | "warn" | "bad"; clickable?: boolean; onClick?: () => void }) {
  const toneClass = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "";
  return (
    <div className={clsx("mini-metric", clickable && "mini-metric-clickable")} onClick={clickable ? onClick : undefined}>
      {clickable && <div className="mini-metric-hint" />}
      <div className="flex items-center gap-1 text-[9px] text-muted">{icon}{label}</div>
      <div className={clsx("truncate text-[10px]", toneClass)}>{value}</div>
    </div>
  );
}
