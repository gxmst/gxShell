import { Download, Upload, X } from "lucide-react";
import { useTransfers } from "../../hooks/useTransfers";

export function ProgressBar() {
  const { transfers, removeTransfer } = useTransfers();

  const items = Object.entries(transfers);
  if (!items.length) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[9998] flex flex-col gap-px pointer-events-none">
      {items.map(([key, t]) => {
        const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
        const name = t.path.split(/[\\/]/).pop() || t.path;
        const isUpload = t.direction === "upload";
        return (
          <div key={key} className="pointer-events-auto mx-auto flex h-9 w-full max-w-[560px] items-center gap-2.5 rounded-t-lg border border-b-0 border-border/60 px-3 text-[11px]" style={{ background: "color-mix(in srgb, var(--panel-raised) 88%, var(--bg))" }}>
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {isUpload ? <Upload size={12} className="text-warn shrink-0" /> : <Download size={12} className="text-accent shrink-0" />}
              <span className="truncate text-muted">{name}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full transition-all duration-200" style={{ width: `${pct}%`, background: isUpload ? "var(--warn)" : "var(--accent)" }} />
              </div>
              <span className="text-muted w-8 text-right tabular-nums">{pct}%</span>
              <button className="flex items-center justify-center w-4 h-4 rounded hover:bg-white/10" onClick={() => removeTransfer(key)}><X size={10} /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
