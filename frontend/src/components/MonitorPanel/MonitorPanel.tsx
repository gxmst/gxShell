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
    <div className="space-y-1">
      <div className="current-card">
        <Wifi size={13} className={clsx(active.state === "connected" ? "text-ok" : "text-muted")} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{active.title}</span>
        <span className={clsx("status-dot", stateClass(active.state))} />
      </div>
      {!metrics && <button className="btn-secondary w-full text-[11px]" onClick={onStart}><Activity size={13} /> Start monitor</button>}
      {metrics && (
        <>
          <MetricRow icon={<Gauge size={12} />} label="CPU" value={metrics.cpuPercent} />
          <MetricRow icon={<MemoryStick size={12} />} label="Mem" value={metrics.memoryPercent} detail={`${metrics.memoryUsedMb || 0}/${metrics.memoryTotalMb || 0} MB`} />
          <MetricRow icon={<HardDrive size={12} />} label="Disk" value={metrics.diskPercent} detail={`${metrics.diskUsed || "-"} / ${metrics.diskTotal || "-"}`} />
          <div className="chip-grid compact-chip-grid">
            <MiniMetric icon={<Zap size={11} />} label="Load" value={metrics.loadAverage || "-"} />
            <MiniMetric icon={<Wifi size={11} />} label="Ping" value={`${metrics.latencyMs || 0}ms`} />
            <MiniMetric icon={<Download size={11} />} label="Down" value={formatBytes(metrics.networkRxPerSec)} />
            <MiniMetric icon={<Upload size={11} />} label="Up" value={formatBytes(metrics.networkTxPerSec)} />
          </div>
          <div className="pt-1 border-t border-border/50">
            <button className="process-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Top processes
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
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="font-medium">{label}</span>
          <span className="truncate text-muted text-[10px]">{detail || `${safe.toFixed(0)}%`}</span>
        </div>
        <div className="meter w-full"><div className={clsx("meter-fill", `meter-${tone}`)} style={{ width: `${safe}%` }} /></div>
      </div>
    </div>
  );
}

function MiniMetric({ icon, label, value }: { icon: JSX.Element; label: string; value: string }) {
  return <div className="mini-metric"><div className="flex items-center gap-1 text-[9px] text-muted">{icon}{label}</div><div className="truncate text-[10px]">{value}</div></div>;
}
