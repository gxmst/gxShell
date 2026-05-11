import { useState } from "react";
import clsx from "clsx";
import { Activity, ChevronDown, ChevronRight, Download, Gauge, HardDrive, MemoryStick, Upload, Wifi, Zap } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import type { Tab } from "../../types";
import { formatBytes, stateClass } from "../../utils/format";

export function MonitorPanel({ metrics, active, onStart }: { metrics?: types.Metrics; active?: Tab; onStart: () => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!active) return <div className="empty compact">Open a terminal to view live status.</div>;
  return (
    <div className="space-y-2">
      <div className="current-card">
        <Wifi size={15} className={clsx(active.state === "connected" ? "text-ok" : "text-muted")} />
        <span className="min-w-0 flex-1 truncate text-sm">{active.title}</span>
        <span className={clsx("status-dot", stateClass(active.state))} />
      </div>
      {!metrics && <button className="btn-secondary w-full" onClick={onStart}><Activity size={15} /> Start monitor</button>}
      {metrics && (
        <>
          <MetricRow icon={<Gauge size={14} />} label="CPU" value={metrics.cpuPercent} />
          <MetricRow icon={<MemoryStick size={14} />} label="Memory" value={metrics.memoryPercent} detail={`${metrics.memoryUsedMb || 0}/${metrics.memoryTotalMb || 0} MB`} />
          <MetricRow icon={<HardDrive size={14} />} label="Disk" value={metrics.diskPercent} detail={`${metrics.diskUsed || "-"} / ${metrics.diskTotal || "-"}`} />
          <div className="chip-grid compact-chip-grid">
            <MiniMetric icon={<Zap size={13} />} label="Load" value={metrics.loadAverage || "-"} />
            <MiniMetric icon={<Wifi size={13} />} label="Ping" value={`${metrics.latencyMs || 0}ms`} />
            <MiniMetric icon={<Download size={13} />} label="Down" value={formatBytes(metrics.networkRxPerSec)} />
            <MiniMetric icon={<Upload size={13} />} label="Up" value={formatBytes(metrics.networkTxPerSec)} />
          </div>
          <div className="panel dense">
            <button className="process-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Top processes
            </button>
            {expanded && metrics.topProcesses?.slice(0, 5).map((p) => (
              <div key={`${p.pid}-${p.command}`} className="process-row">
                <span className="truncate">{p.command}</span><span>{p.memory.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MetricRow({ icon, label, value, detail }: { icon: JSX.Element; label: string; value: number; detail?: string }) {
  const safe = Math.max(0, Math.min(100, value || 0));
  const tone = safe >= 85 ? "bad" : safe >= 60 ? "warn" : "ok";
  return (
    <div className="metric-row">
      <div className={clsx("metric-icon", `metric-${tone}`)}>{icon}</div>
      <span className="w-14 text-xs">{label}</span>
      <div className="meter flex-1"><div className={clsx("meter-fill", `meter-${tone}`)} style={{ width: `${safe}%` }} /></div>
      <span className="w-16 truncate text-right text-[11px] text-muted">{detail || `${safe.toFixed(0)}%`}</span>
    </div>
  );
}

function MiniMetric({ icon, label, value }: { icon: JSX.Element; label: string; value: string }) {
  return <div className="mini-metric"><div className="flex items-center gap-1 text-[10px] text-muted">{icon}{label}</div><div className="truncate text-[11px]">{value}</div></div>;
}

