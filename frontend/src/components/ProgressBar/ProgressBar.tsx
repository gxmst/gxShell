import { Download, RotateCcw, Upload, X } from "lucide-react";
import { useTransfers } from "../../hooks/useTransfers";

/** Compact bottom chips for in-flight SFTP jobs. Full history lives in Transfer manager. */
export function ProgressBar() {
  const { transfers, cancelTransfer } = useTransfers();

  const items = Object.entries(transfers);
  if (!items.length) return null;

  return (
    <div className="transfer-progress-stack">
      {items.map(([key, tr]) => {
        const pct = tr.total > 0 ? Math.round((tr.done / tr.total) * 100) : 0;
        const name = tr.path.split(/[\\/]/).pop() || tr.path;
        const isUpload = tr.direction === "upload";
        return (
          <div key={key} className="transfer-progress-chip">
            <div className="transfer-progress-chip-main">
              {isUpload
                ? <Upload size={12} className="text-warn shrink-0" />
                : <Download size={12} className="text-accent shrink-0" />}
              <span className="transfer-progress-chip-name">{name}</span>
            </div>
            <div className="transfer-progress-chip-meta">
              <div className="transfer-progress-chip-track">
                <div
                  className={isUpload ? "transfer-progress-chip-fill upload" : "transfer-progress-chip-fill"}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {/* A resumed transfer starts its bar part-filled; without a marker
                  that reads as a stalled transfer rather than a continued one. */}
              {tr.resumedAt ? <RotateCcw size={9} className="text-ok shrink-0" /> : null}
              <span className="transfer-progress-chip-pct">{pct}%</span>
              <button className="transfer-progress-chip-close" onClick={() => void cancelTransfer(tr.jobId)} title="Cancel">
                <X size={10} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
