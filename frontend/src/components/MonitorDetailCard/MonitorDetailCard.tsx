import clsx from "clsx";
import type { ReactNode } from "react";
import { Cpu, Gauge, HardDrive, Network, TerminalSquare } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { formatBytes } from "../../utils/format";
import { useSessionMetrics } from "../../hooks/useSessionMetrics";
import { t } from "../../i18n";
import { FloatingCard } from "../FloatingCard/FloatingCard";

export type MonitorDetailKind = "cpu" | "disk" | "network";

interface MonitorDetailCardProps {
  kind: MonitorDetailKind;
  sessionId?: string;
  initialLeft: number;
  initialTop: number;
  locale: string;
  onClose: () => void;
}

const COMMANDS: Record<MonitorDetailKind, string[]> = {
  cpu: [
    "cat /proc/stat",
    "cat /proc/loadavg",
    "ps aux --sort=-%cpu | head -n 6",
  ],
  disk: [
    "df -hP /",
    "lsblk -f",
    "du -xhd1 / 2>/dev/null | sort -h",
  ],
  network: [
    "ip route get 1.1.1.1",
    "cat /proc/net/dev",
    "ping -c 4 <host>",
  ],
};

export function MonitorDetailCard({ kind, sessionId, initialLeft, initialTop, locale, onClose }: MonitorDetailCardProps) {
  // Own monitor:update subscription; ticks re-render only this floating card.
  const metrics = useSessionMetrics(sessionId);
  const lang = locale || "en";
  const title = kind === "cpu" ? t(lang, "cpuDetail") : kind === "disk" ? t(lang, "diskDetail") : t(lang, "networkDetail");
  const icon = kind === "cpu" ? <Cpu size={14} /> : kind === "disk" ? <HardDrive size={14} /> : <Network size={14} />;

  return (
    <FloatingCard initialLeft={initialLeft} initialTop={initialTop} width={340} onClose={onClose}>
      <div className="detail-card-header">
        <span className="detail-card-icon text-accent">{icon}</span>
        <span className="text-[12px] font-semibold">{title}</span>
      </div>

      {kind === "cpu" && <CpuDetail metrics={metrics} lang={lang} />}
      {kind === "disk" && <DiskDetail metrics={metrics} lang={lang} />}
      {kind === "network" && <NetworkDetail metrics={metrics} lang={lang} />}

      <CommandSection commands={COMMANDS[kind]} lang={lang} />
    </FloatingCard>
  );
}

function CpuDetail({ metrics, lang }: { metrics?: types.Metrics; lang: string }) {
  const cpuPct = metrics?.cpuPercent || 0;
  const load = metrics?.loadAverage || "-";
  const procs = [...(metrics?.topProcesses || [])].sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, 8);
  return (
    <>
      <DetailStatGrid>
        <DetailStat label={t(lang, "cpuUsage")} value={`${cpuPct.toFixed(0)}%`} tone={tone(cpuPct)} />
        <DetailStat label={t(lang, "load")} value={load} />
        <DetailStat label={t(lang, "latency")} value={`${metrics?.latencyMs || 0}ms`} />
      </DetailStatGrid>
      <div className="detail-section">
        <div className="detail-section-title">
          <Gauge size={11} />
          <span>{t(lang, "topCpuProcesses")}</span>
        </div>
        <ProcessList rows={procs} metric="cpu" />
      </div>
    </>
  );
}

function DiskDetail({ metrics, lang }: { metrics?: types.Metrics; lang: string }) {
  const diskPct = metrics?.diskPercent || 0;
  return (
    <>
      <DetailStatGrid>
        <DetailStat label={t(lang, "diskUsage")} value={`${diskPct.toFixed(0)}%`} tone={tone(diskPct)} />
        <DetailStat label={t(lang, "used")} value={metrics?.diskUsed || "-"} />
        <DetailStat label={t(lang, "total")} value={metrics?.diskTotal || "-"} />
      </DetailStatGrid>
      <div className="detail-section">
        <div className="detail-meter">
          <div className={clsx("meter-fill", `meter-${tone(diskPct)}`)} style={{ width: `${Math.min(100, diskPct)}%` }} />
        </div>
        <div className="detail-hint">{t(lang, "rootDiskHint")}</div>
      </div>
    </>
  );
}

function NetworkDetail({ metrics, lang }: { metrics?: types.Metrics; lang: string }) {
  const latency = metrics?.latencyMs || 0;
  return (
    <DetailStatGrid>
      <DetailStat label={t(lang, "ping")} value={`${latency}ms`} tone={latency >= 300 ? "bad" : latency >= 100 ? "warn" : "ok"} />
      <DetailStat label={t(lang, "down")} value={formatBytes(metrics?.networkRxPerSec || 0)} />
      <DetailStat label={t(lang, "up")} value={formatBytes(metrics?.networkTxPerSec || 0)} />
    </DetailStatGrid>
  );
}

function DetailStatGrid({ children }: { children: ReactNode }) {
  return <div className="detail-stat-grid">{children}</div>;
}

function DetailStat({ label, value, tone: itemTone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="detail-stat">
      <span className="detail-stat-label">{label}</span>
      <span className={clsx("detail-stat-value", itemTone && `text-${itemTone}`)}>{value}</span>
    </div>
  );
}

function ProcessList({ rows, metric }: { rows: types.ProcessInfo[]; metric: "cpu" | "memory" }) {
  if (!rows.length) return <div className="detail-empty">-</div>;
  return (
    <div className="detail-process-list">
      {rows.map((p, i) => {
        const value = metric === "cpu" ? p.cpu : p.memory;
        return (
          <div key={`${p.pid}-${i}`} className="detail-process-row">
            <span className="detail-process-pid">{p.pid}</span>
            <span className="detail-process-name truncate">{p.command}</span>
            <span className={clsx("detail-process-value", value >= 20 ? "text-bad" : value >= 10 ? "text-warn" : "text-ok")}>{value.toFixed(1)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function CommandSection({ commands, lang }: { commands: string[]; lang: string }) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">
        <TerminalSquare size={11} />
        <span>{t(lang, "linuxCommands")}</span>
      </div>
      <div className="detail-command-list">
        {commands.map((cmd) => <code key={cmd}>{cmd}</code>)}
      </div>
    </div>
  );
}

function tone(pct: number): "ok" | "warn" | "bad" {
  if (pct >= 85) return "bad";
  if (pct >= 60) return "warn";
  return "ok";
}
