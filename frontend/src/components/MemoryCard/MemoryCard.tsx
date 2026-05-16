import clsx from "clsx";
import { MemoryStick, ArrowDownUp, Cpu } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { FloatingCard } from "../FloatingCard/FloatingCard";

interface MemoryCardProps {
  metrics?: types.Metrics;
  initialLeft: number;
  initialTop: number;
  locale: string;
  onClose: () => void;
}

export function MemoryCard({ metrics, initialLeft, initialTop, locale, onClose }: MemoryCardProps) {
  const lang = locale || "en";

  const memPct = metrics?.memoryPercent || 0;
  const memUsed = metrics?.memoryUsedMb || 0;
  const memTotal = metrics?.memoryTotalMb || 0;
  const swapUsed = metrics?.swapUsedMb || 0;
  const swapTotal = metrics?.swapTotalMb || 0;
  const swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;
  const hasSwap = swapTotal > 0;

  const tone = (pct: number) => pct >= 85 ? "bad" : pct >= 60 ? "warn" : "ok";

  return (
    <FloatingCard initialLeft={initialLeft} initialTop={initialTop} width={320} onClose={onClose}>
      <div className="memcard-header">
        <MemoryStick size={14} className="text-accent" />
        <span className="text-[12px] font-semibold">{t(lang, "memoryDetail")}</span>
      </div>

      <div className="memcard-section">
        <div className="memcard-section-title">
          <MemoryStick size={11} />
          <span>RAM</span>
          <span className="memcard-pct">{memPct.toFixed(0)}%</span>
        </div>
        <div className="meter w-full"><div className={clsx("meter-fill", `meter-${tone(memPct)}`)} style={{ width: `${Math.min(100, memPct)}%` }} /></div>
        <div className="memcard-detail">{memUsed} MB / {memTotal} MB</div>
      </div>

      {hasSwap ? (
        <div className="memcard-section">
          <div className="memcard-section-title">
            <ArrowDownUp size={11} />
            <span>Swap</span>
            <span className="memcard-pct">{swapPct.toFixed(0)}%</span>
          </div>
          <div className="meter w-full"><div className={clsx("meter-fill", `meter-${tone(swapPct)}`)} style={{ width: `${Math.min(100, swapPct)}%` }} /></div>
          <div className="memcard-detail">{swapUsed} MB / {swapTotal} MB</div>
        </div>
      ) : (
        <div className="memcard-section">
          <div className="memcard-section-title">
            <ArrowDownUp size={11} />
            <span>Swap</span>
          </div>
          <div className="memcard-detail">N/A</div>
        </div>
      )}

      {metrics?.topProcesses && metrics.topProcesses.length > 0 && (
        <div className="memcard-section">
          <div className="memcard-section-title">
            <Cpu size={11} />
            <span>{t(lang, "topMemProcesses")}</span>
          </div>
          <div className="memcard-proc-list">
            {metrics.topProcesses.slice(0, 8).map((p, i) => (
              <div key={`${p.pid}-${i}`} className="memcard-proc-row">
                <span className="memcard-proc-pid">{p.pid}</span>
                <span className="memcard-proc-name truncate">{p.command}</span>
                <span className={clsx("memcard-proc-mem", p.memory >= 10 ? "text-bad" : p.memory >= 5 ? "text-warn" : "text-ok")}>{p.memory.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </FloatingCard>
  );
}
