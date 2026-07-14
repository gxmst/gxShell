import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Columns2, Download, Upload, X } from "lucide-react";
import { useTransfers } from "../../hooks/useTransfers";
import { t } from "../../i18n";
import { FloatingCard } from "../FloatingCard/FloatingCard";

export function TransferCenter(props: {
  locale: string;
  sessionId?: string;
  initialLeft?: number;
  initialTop?: number;
  onClose: () => void;
  onOpenExplorer: () => void;
  onUpload: () => void;
}) {
  const lang = props.locale;
  const { transfers, history, activeCount, cancelTransfer, clearHistory } = useTransfers();

  const active = Object.entries(transfers).filter(([, tr]) => !props.sessionId || tr.sessionId === props.sessionId);
  const recent = history.filter((h) => !props.sessionId || h.sessionId === props.sessionId).slice(0, 20);
  const visibleActiveCount = props.sessionId ? active.length : activeCount;

  return (
    <FloatingCard
      center
      initialLeft={props.initialLeft}
      initialTop={props.initialTop}
      width={420}
      onClose={props.onClose}
    >
      <div className="xfer-center">
        <div className="xfer-center-header">
          <div>
            <div className="xfer-center-title">{t(lang, "transferManager")}</div>
            <div className="xfer-center-sub">
              {visibleActiveCount > 0
                ? t(lang, "transferActiveCount", { n: String(visibleActiveCount) })
                : t(lang, "noActiveTransfer")}
            </div>
          </div>
        </div>

        <div className="xfer-center-actions">
          <button className="btn-secondary xfer-action" onClick={props.onUpload}>
            <Upload size={13} /> {t(lang, "upload")}
          </button>
          <button className="btn-secondary xfer-action" onClick={props.onOpenExplorer}>
            <Columns2 size={13} /> {t(lang, "dualPaneTransfer")}
          </button>
        </div>

        <div className="xfer-center-section">
          <div className="xfer-center-section-title">{t(lang, "transferProgress")}</div>
          {active.length === 0 ? (
            <div className="xfer-center-empty">
              <Download size={18} className="opacity-50" />
              <span>{t(lang, "noActiveTransferHint")}</span>
            </div>
          ) : (
            <div className="xfer-center-list">
              {active.map(([key, tr]) => {
                const pct = tr.total > 0 ? Math.round((tr.done / tr.total) * 100) : 0;
                const name = tr.path.split(/[\\/]/).pop() || tr.path;
                const isUp = tr.direction === "upload";
                return (
                  <div key={key} className="xfer-center-item">
                    <div className="xfer-center-item-top">
                      {isUp
                        ? <ArrowUpFromLine size={13} className="text-warn shrink-0" />
                        : <ArrowDownToLine size={13} className="text-accent shrink-0" />}
                      <span className="xfer-center-item-name" title={tr.path}>{name}</span>
                      <span className="xfer-center-item-pct">{pct}%</span>
                      <button className="mini-btn" onClick={() => void cancelTransfer(tr.jobId)} title={t(lang, "cancel")}>
                        <X size={11} />
                      </button>
                    </div>
                    <div className="xfer-center-track">
                      <div
                        className={isUp ? "xfer-center-fill upload" : "xfer-center-fill"}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="xfer-center-section">
          <div className="xfer-center-section-title">
            <span>{t(lang, "transferHistory")}</span>
            {recent.length > 0 && (
              <button className="text-button" onClick={clearHistory}>{t(lang, "clearHistory")}</button>
            )}
          </div>
          {recent.length === 0 ? (
            <div className="xfer-center-empty compact">
              <span>{t(lang, "noTransferHistory")}</span>
            </div>
          ) : (
            <div className="xfer-center-list">
              {recent.map((h) => (
                <div key={h.key} className="xfer-center-history">
                  {h.ok
                    ? <CheckCircle2 size={12} className="text-ok shrink-0" />
                    : <X size={12} className="text-bad shrink-0" />}
                  {h.direction === "upload"
                    ? <ArrowUpFromLine size={12} className="text-muted shrink-0" />
                    : <ArrowDownToLine size={12} className="text-muted shrink-0" />}
                  <span className="xfer-center-item-name" title={h.path}>{h.name}</span>
                  <span className={h.ok ? "text-ok text-[10px]" : "text-bad text-[10px]"} title={h.error}>
                    {h.ok ? t(lang, "transferComplete") : h.status === "cancelled" ? t(lang, "transferCancelled") : t(lang, "transferFailed")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </FloatingCard>
  );
}
