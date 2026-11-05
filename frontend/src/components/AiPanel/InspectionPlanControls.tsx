import { useState } from "react";
import { PrepareAiInspectionPlan, ExecuteAiInspectionPlan, DismissAiInspectionPlan, CancelAiInspection } from "../../../wailsjs/go/app/App";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";

export function InspectionPlanControls({ run, locale, onUpdated, onError, onSelectRun }: {
  run: InspectionRun; locale: string; onUpdated: (run: InspectionRun) => void; onError: (message: string) => void; onSelectRun?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const plans = run.plans || [];
  const pending = plans.some((p) => p.status === "proposed" || p.status === "running");
  const service = run.evidence.find((e) => e.query.check === "service" && e.query.view === "status");
  const journal = run.evidence.find((e) => e.query.check === "journal");
  const system = [...run.evidence].reverse().find((e) => e.query.check === "system");
  // Mirrors the backend gate: plans never elevate, and both actions need root.
  const root = system?.status === "collected" && system.output.trim().split("\n").pop()?.trim() === "GXSHELL_UID=0";
  const candidate = run.workflow === "service_diagnosis" && service?.status === "collected" && !service.truncated && service.output.includes("LoadState=loaded")
    ? "restart_service" : run.workflow === "disk_diagnosis" && journal?.status === "collected" && !journal.truncated ? "vacuum_journal_7d" : "";
  const available = root ? candidate : "";
  const act = async (action: "prepare" | "execute" | "dismiss", id = "") => {
    if (busy) return;
    setBusy(true);
    try { onUpdated(await (action === "prepare" ? PrepareAiInspectionPlan(run.id, available) : action === "execute" ? ExecuteAiInspectionPlan(run.id, id) : DismissAiInspectionPlan(run.id, id))); }
    catch (error) { onError(String(error)); }
    finally { setBusy(false); }
  };
  const state = (status: string) => t(locale, ({
    proposed: "inspectionPlanProposed", running: "inspectionPlanRunning", completed: "inspectionPlanSucceeded",
    failed: "inspectionPlanFailed", dismissed: "inspectionPlanDismissed",
  } as const)[status as "proposed"] || "inspectionPlanUnknown");
  if (!candidate && plans.length === 0) return null;
  return <section className="inspection-plan-section">
    <h3>{t(locale, "inspectionPlans")}</h3>
    <p className="inspection-report-empty">{t(locale, "inspectionPlanExplanation")}</p>
    {candidate && !root && plans.length === 0 && <p className="inspection-report-empty">{t(locale, "inspectionPlanNeedsRoot")}</p>}
    {available && !pending && <button className="btn-secondary" onClick={() => act("prepare")} disabled={busy}>{t(locale, available === "restart_service" ? "inspectionPrepareRestart" : "inspectionPrepareJournalCleanup")}</button>}
    {plans.map((p) => <div className="inspection-plan-card" key={p.id}>
      <h4>{p.title} · {state(p.status)}</h4><p>{p.impact}</p><pre>{p.command}</pre>
      {p.output && <pre>{p.output}</pre>}{p.error && <p className="ai-inspection-error">{p.error}</p>}
      {p.verificationError && <p className="ai-inspection-error">{p.verificationError}</p>}
      {p.status === "proposed" && <div className="inspection-report-actions">
        <button className="btn-secondary" onClick={() => act("execute", p.id)} disabled={busy}>{t(locale, "inspectionExecutePlan")}</button>
        <button className="btn-secondary" onClick={() => act("dismiss", p.id)} disabled={busy}>{t(locale, "inspectionDismissPlan")}</button>
      </div>}
      {p.status === "running" && <button className="btn-secondary" onClick={() => CancelAiInspection(run.id).catch((error) => onError(String(error)))}>{t(locale, "aiStop")}</button>}
      {p.verificationId && <button className="btn-secondary" onClick={() => onSelectRun?.(p.verificationId!)}>{t(locale, "inspectionViewVerification")}</button>}
    </div>)}
  </section>;
}
