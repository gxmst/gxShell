import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { CliApprovalEvent } from "../../types";
import { t } from "../../i18n";
import { splitRiskText } from "./riskText";

function ApprovalCard({ approval, locale }: { approval: CliApprovalEvent; locale: string }) {
  const command = approval.command || "";
  const parts = splitRiskText(command, approval.spans || []);
  return (
    <article className={`cli-approval-card cli-approval-${(approval.riskTier || "T2").toLowerCase()}`}>
      <header className="cli-approval-header">
        <span className="cli-approval-icon"><ShieldAlert size={15} /></span>
        <span className="cli-approval-heading">
          <strong>{approval.alias || t(locale, "remoteServer")}</strong>
          <small>{t(locale, "nativeApprovalPending")}</small>
        </span>
        <span className="cli-approval-tier">{approval.riskTier} · {approval.riskLabel}</span>
      </header>
      <pre className="cli-risk-command" aria-label={t(locale, "commandRiskAnalysis")}>
        {parts.map((part, index) => part.className
          ? <mark key={`${index}-${part.text}`} className={part.className} title={part.note}>{part.text}</mark>
          : <span key={`${index}-${part.text}`}>{part.text}</span>)}
      </pre>
      {!!approval.riskLines?.length && (
        <div className="cli-risk-lines">
          <strong className="cli-risk-lines-title">{t(locale, "whatThisDoes")}</strong>
          {approval.riskLines.slice(0, 4).map((line) => (
            <div key={line}><AlertTriangle size={11} /><span>{line}</span></div>
          ))}
        </div>
      )}
    </article>
  );
}

export function CliApprovalQueue({ approvals, locale }: { approvals: CliApprovalEvent[]; locale: string }) {
  if (!approvals.length) return null;
  return (
    <aside className="cli-approval-queue" aria-live="assertive">
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} locale={locale} />)}
    </aside>
  );
}
