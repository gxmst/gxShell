import { useState } from "react";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";
import { MarkdownContent } from "./AiMarkdown";
import { InspectionReviewControls } from "./InspectionReviewControls";
import { InspectionComparison } from "./InspectionComparison";
import { InspectionPlanControls } from "./InspectionPlanControls";
import { inspectionReviewProgress, latestInspectionReviews } from "./inspectionReview";
import { inspectionCheckLabel } from "./inspectionLabels";
import { InspectionFollowup } from "./InspectionFollowup";
import { InspectionFeedback } from "./InspectionFeedback";
import { InspectionTrace } from "./InspectionTrace";
const statuses = {
  normal: "inspectionNormal", warning: "inspectionWarning", critical: "inspectionCritical",
  unknown: "inspectionUnknown", attention: "inspectionAttention",
  reviewed: "inspectionReviewComplete",
} as const;
const statusLabel = (locale: string, status: string) => t(locale, statuses[status as keyof typeof statuses] || "inspectionUnknown");

export function InspectionEvidence({ run, locale, scope }: { run: InspectionRun; locale: string; scope: string }) {
  return run.evidence.length > 0 && <details className="ai-inspection-evidence" id={scope + "-evidence"}>
    <summary>{t(locale, "inspectionEvidence")} ({run.evidence.length})</summary>
    {run.evidence.map((item) => <details key={item.id} id={scope + "-" + item.id}>
      <summary>[{item.id}] {inspectionCheckLabel(locale, item.query.check)} {item.query.service}
        {item.query.scope}
        {item.query.view && " · " + t(locale, item.query.view === "logs" ? "inspectionLogs" : "inspectionServiceStatus")}
        {item.query.port && " · TCP " + item.query.port} · {t(locale, item.status === "collected" ? "inspectionCollected" : "inspectionUnavailable")}</summary>
      {item.reason && <p>{item.reason}</p>}
      {item.error && <p>{item.error}</p>}
      {item.collectedAt && <small>{t(locale, item.sourceRunId ? "inspectionHistoricalEvidence" : "inspectionFreshEvidence")} · {new Date(item.collectedAt).toLocaleString(locale)} {item.sourceRunId && "· " + item.sourceRunId.slice(0, 8) + "/" + (item.sourceEvidenceId || item.id)}</small>}
      <pre>{item.output || t(locale, "inspectionUnavailable")}</pre>
      {item.truncated && <small>{t(locale, "inspectionTruncated")}</small>}
    </details>)}
  </details>;
}

function revealInspectionEvidence(scope: string, id: string) {
  const list = document.getElementById(scope + "-evidence");
  const evidence = document.getElementById(scope + "-" + id);
  if (list instanceof HTMLDetailsElement) list.open = true;
  if (evidence instanceof HTMLDetailsElement) {
    evidence.open = true;
    evidence.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }
}

function EvidenceRefs({ ids, onSelect }: { ids: string[]; onSelect: (id: string) => void }) {
  return <span className="inspection-report-refs">{ids.map((id) =>
    <button key={id} type="button" onClick={() => onSelect(id)}>[{id}]</button>)}</span>;
}

export function InspectionReport({ run, locale, compact = false, onOpen, history = [], onUpdated, onError = () => undefined, onSelectRun, onFollowupCreated }: {
  run: InspectionRun; locale: string; compact?: boolean; onOpen?: () => void;
  history?: InspectionRun[]; onUpdated?: (run: InspectionRun) => void; onError?: (message: string) => void; onSelectRun?: (id: string) => void;
  onFollowupCreated?: (run: InspectionRun) => void;
}) {
  const doc = run.document;
  const title = t(locale, run.workflow === "service_diagnosis" ? "inspectionDiagnosisReport" : run.workflow === "disk_diagnosis" ? "inspectionDiskReport" : "inspectionReportTitle");
  const reviewProgress = inspectionReviewProgress(run);
  const latestReviews = latestInspectionReviews(run);
  const manualComplete = reviewProgress.confirmed > 0 && reviewProgress.pending === 0;
  const verdict = reviewProgress.issue ? "attention" : manualComplete && doc?.verdict === "unknown" ? "reviewed" : doc?.verdict || "unknown";
  const displayedStatus = (check: NonNullable<InspectionRun["document"]>["checks"][number]) => {
    if (check.status !== "unknown") return check.status;
    const related = doc?.unknowns.filter((u) => u.evidenceIds.some((id) => check.evidenceIds.includes(id))) || [];
    const outcomes = related.map((u) => latestReviews.get(u.id || "")?.outcome);
    if (outcomes.includes("issue")) return "attention";
    return related.length > 0 && outcomes.every((o) => o && o !== "pending") ? "reviewed" : "unknown";
  };
  const scope = (compact ? "compact-" : "report-") + run.id;
  const onEvidence = (id: string) => revealInspectionEvidence(scope, id);
  // One follow-up box; "Ask about this" on an insight pre-fills it.
  const [followupSeed, setFollowupSeed] = useState({ key: 0, question: "", focus: "" });
  const askAbout = (insight: NonNullable<NonNullable<InspectionRun["document"]>["analysis"]>["insights"][number]) => {
    setFollowupSeed((previous) => ({ key: previous.key + 1, focus: insight.evidenceIds[0] || "",
      question: t(locale, "inspectionFollowupQuestionCheck", { point: insight.title + "。" + insight.nextCheck }) }));
    requestAnimationFrame(() => document.getElementById(scope + "-followup")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }));
  };
  if (!doc) return <div className="ai-inspection-report"><MarkdownContent content={run.report} /></div>;
  const duration = run.finishedAt && Date.parse(run.finishedAt) >= Date.parse(run.createdAt)
    ? Math.round((Date.parse(run.finishedAt) - Date.parse(run.createdAt)) / 1000) + "s" : "—";
  return <article className={"inspection-report-sheet" + (compact ? " inspection-report-compact" : "")}>
    <header className="inspection-report-heading">
      <span>gxShell · {t(locale, "inspectionReport")}</span>
      <h2>{title}</h2>
      <strong>{run.target}</strong>
    </header>
    <dl className="inspection-report-metadata">
      <div><dt>{t(locale, "inspectionReportId")}</dt><dd title={run.id}>{run.id.slice(0, 8).toUpperCase()}</dd></div>
      <div><dt>{t(locale, "inspectionReportTime")}</dt><dd>{new Date(run.createdAt).toLocaleString(locale)}</dd></div>
      {!compact && <div><dt>{t(locale, "inspectionDuration")}</dt><dd>{duration}</dd></div>}
      {run.service && <div><dt>{t(locale, "inspectionDiagnosisService")}</dt><dd>{run.service} · TCP {run.port}</dd></div>}
    </dl>
    <section className="inspection-report-summary">
      <span className={"inspection-report-badge inspection-report-" + verdict}>{statusLabel(locale, verdict)}</span>
      {reviewProgress.confirmed > 0 && <small className="inspection-ai-verdict">{manualComplete && verdict !== "reviewed" && <>{t(locale, "inspectionReviewComplete")} · </>}{t(locale, "inspectionOriginalAiVerdict")} · {statusLabel(locale, doc.verdict)}</small>}
      {manualComplete ? <><p>{t(locale, "inspectionReviewSummary", { normal: String(reviewProgress.normal), issues: String(reviewProgress.issues), notApplicable: String(reviewProgress.notApplicable) })}</p><small>{t(locale, "inspectionOriginalAiSummary")} · {doc.summary}</small></> : <p>{doc.summary}</p>}
      <div className="inspection-report-counts">
        <span>{t(locale, "inspectionNormal")} <b>{doc.checks.filter((c) => c.status === "normal").length}</b></span>
        <span>{t(locale, "inspectionAttention")} <b>{doc.checks.filter((c) => ["warning", "critical", "attention"].includes(displayedStatus(c))).length}</b></span>
        <span>{t(locale, "inspectionUnknown")} <b>{reviewProgress.pending}</b></span>
        {reviewProgress.confirmed > 0 && <span>{t(locale, "inspectionManuallyVerified")} <b>{reviewProgress.confirmed}</b></span>}
      </div>
    </section>
    {compact ? <>
      {doc.analysis && <p className="inspection-report-preview"><strong>{t(locale, "inspectionAiAssessment")}</strong><br />{doc.analysis.assessment}</p>}
      {doc.findings.slice(0, 2).map((f, i) => <p key={i} className="inspection-report-preview"><strong>{f.title}</strong><br />{f.detail}</p>)}
      <button className="btn-secondary inspection-report-open" onClick={onOpen}>{t(locale, "inspectionViewReport")}</button>
    </> : <>
      {run.parentId && <p>{t(locale, "inspectionFollowupOriginal")} · <button className="btn-secondary" onClick={() => onSelectRun?.(run.parentId!)}>{run.parentId.slice(0, 8)}</button><br />{run.question}</p>}
      <section className="inspection-ai-analysis">
        <h3>{t(locale, "inspectionAiAssessment")}</h3>
        {!doc.analysis ? <p className="inspection-report-empty">{t(locale, "inspectionAiMissing")}</p> : <>
          <p className="inspection-ai-assessment">{doc.analysis.assessment}</p>
          {doc.analysis.insights.map((insight, index) => <div className="inspection-ai-insight" key={index}>
            <h4>{insight.title} · <small>{t(locale, insight.confidence === "supported" ? "inspectionAiSupported" : insight.confidence === "hypothesis" ? "inspectionAiHypothesis" : "inspectionAiUncertain")}</small></h4>
            <p>{insight.opinion} <EvidenceRefs ids={insight.evidenceIds} onSelect={onEvidence} /></p>
            <p>{insight.nextCheck}</p>
            {onFollowupCreated && <button type="button" className="btn-secondary" onClick={() => askAbout(insight)}>{t(locale, "inspectionFollowupAskThis")}</button>}
          </div>)}
          <h4>{t(locale, "inspectionAiNextChecks")}</h4><ol>{doc.analysis.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          {doc.analysis.caveats && <p className="inspection-report-empty">{t(locale, "inspectionAiCaveats")} · {doc.analysis.caveats}</p>}
        </>}
      </section>
      <section>
        <h3>{t(locale, "inspectionOverview")}</h3>
        <div className="inspection-report-table-wrap"><table>
          <thead><tr><th>{t(locale, "inspectionCheckColumn")}</th><th>{t(locale, "inspectionResultColumn")}</th><th>{t(locale, "inspectionReadingColumn")}</th><th>{t(locale, "inspectionEvidenceColumn")}</th></tr></thead>
          <tbody>{doc.checks.map((c) => <tr key={c.check}>
            <th>{inspectionCheckLabel(locale, c.check)}</th>
            <td><span className={"inspection-report-badge inspection-report-" + displayedStatus(c)}>{statusLabel(locale, displayedStatus(c))}</span></td>
            <td>{c.observed && <strong className="inspection-report-measurement">{c.observed}</strong>}{c.reading}</td><td><EvidenceRefs ids={c.evidenceIds} onSelect={onEvidence} /></td>
          </tr>)}</tbody>
        </table></div>
      </section>
      <section>
        <h3>{t(locale, "inspectionFindings")}</h3>
        {doc.findings.length === 0 && <p className="inspection-report-empty">{t(locale, "inspectionNoFindings")}</p>}
        {doc.findings.map((f, i) => <div key={i} className="inspection-report-finding">
          <h4><span className={"inspection-report-badge inspection-report-" + f.severity}>{statusLabel(locale, f.severity)}</span> {f.title}</h4>
          <p>{f.detail} <EvidenceRefs ids={f.evidenceIds} onSelect={onEvidence} /></p>
          {f.impact && <p><strong>{t(locale, "inspectionImpact")}：</strong>{f.impact}</p>}
          <p><strong>{t(locale, "inspectionRecommendation")}：</strong>{f.recommendation}</p>
        </div>)}
      </section>
      <section>
        <h3>{t(locale, manualComplete ? "inspectionReviewItems" : "inspectionUncertainties")}</h3>
        {doc.unknowns.length === 0 && <p className="inspection-report-empty">{t(locale, "inspectionNoUncertainties")}</p>}
        {doc.unknowns.map((u, i) => <div key={i} className="inspection-report-uncertainty">
          <h4>{u.title}</h4><p>{u.detail} <EvidenceRefs ids={u.evidenceIds} onSelect={onEvidence} /></p>
          {/* Review controls are folded per item; a saved review keeps them open. */}
          {onUpdated && <details className="inspection-review-toggle" open={!!latestReviews.get(u.id || "") && latestReviews.get(u.id || "")?.outcome !== "pending"}>
            <summary>{t(locale, "inspectionManuallyVerified")}</summary>
            <InspectionReviewControls run={run} item={u} review={latestReviews.get(u.id || "")} locale={locale} onUpdated={onUpdated} onError={onError} />
          </details>}
        </div>)}
      </section>
      {onUpdated && <InspectionPlanControls run={run} locale={locale} onUpdated={onUpdated} onError={onError} onSelectRun={onSelectRun} />}
      {onFollowupCreated && <section id={scope + "-followup"}><h3>{t(locale, "inspectionFollowup")}</h3>
        <InspectionFollowup key={followupSeed.key} run={run} locale={locale} onCreated={onFollowupCreated} onError={onError} question={followupSeed.question} focus={followupSeed.focus} />
      </section>}
      {run.error && <p className="ai-inspection-error">{run.error}</p>}
      <InspectionEvidence run={run} locale={locale} scope={scope} />
      {/* Secondary material: kept, but out of the main reading path. */}
      <details className="inspection-report-more">
        <summary>{t(locale, "inspectionReportMore")}</summary>
        {run.dossier && <section className="inspection-host-snapshot"><h3>{t(locale, "inspectionHostSnapshot")} · v{run.dossier.revision}</h3>
          <p>{run.dossier.purpose} · {run.dossier.environment}</p><p>{run.dossier.notes}</p>
          <p>{t(locale, "inspectionHostServices")} · {run.dossier.services?.join(", ") || "—"}<br />{t(locale, "inspectionHostPorts")} · {run.dossier.ports?.join(", ") || "—"}</p>
          <p>{t(locale, "inspectionHostContainers")} · {run.dossier.containerRuntime === "docker" ? "Docker" : run.dossier.containerRuntime === "podman" ? "Podman" : t(locale, run.dossier.containerRuntime === "none" ? "inspectionHostNone" : run.dossier.containerRuntime === "other" ? "inspectionHostOther" : "inspectionHostUnknown")}</p>
        </section>}
        {onUpdated && <InspectionComparison run={run} history={history} locale={locale} onUpdated={onUpdated} onError={onError} />}
        {onUpdated && <InspectionFeedback run={run} locale={locale} onUpdated={onUpdated} onError={onError} />}
        <InspectionTrace run={run} locale={locale} onEvidence={onEvidence} />
        {(run.reviews?.length || 0) > 0 && <details className="inspection-review-audit"><summary>{t(locale, "inspectionReviewHistory")} ({run.reviews?.length})</summary>
          {run.reviews?.map((r, i) => <p key={i}>{new Date(r.at).toLocaleString(locale)} · {r.reviewer} · {t(locale, ({ normal: "inspectionReviewNormal", issue: "inspectionReviewIssue", not_applicable: "inspectionReviewNotApplicable", pending: "inspectionReviewWithdrawn" } as const)[r.outcome])} {r.note}</p>)}
        </details>}
      </details>
      <footer className="inspection-report-note">{t(locale, run.plans?.length ? "inspectionReportActionNote" : run.parentId ? "inspectionFollowupReportNote" : "inspectionReportNote")}</footer>
    </>}
  </article>;
}
