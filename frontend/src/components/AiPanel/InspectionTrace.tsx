import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";

export function InspectionTrace({ run, locale, onEvidence }: { run: InspectionRun; locale: string; onEvidence: (id: string) => void }) {
  const kind = (value: string) => t(locale, ({ query: "inspectionTraceQuery", model: "inspectionTraceModel", tool_blocked: "inspectionTraceBlocked", tool_reused: "inspectionTraceReused" } as const)[value as "query"] || "inspectionTraceValidation");
  const state = (value: string) => t(locale, ({ running: "inspectionPlanRunning", completed: "inspectionStepCompleted", collected: "inspectionCollected", unavailable: "inspectionUnavailable", failed: "inspectionStepFailed", interrupted: "inspectionStepInterrupted", blocked: "inspectionStepBlocked", reused: "inspectionStepReused" } as const)[value as "running"] || "inspectionUnknown");
  if (!run.trace?.length) return null;
  return <details className="inspection-trace">
    <summary>{t(locale, "inspectionTrace")} ({run.trace.length})</summary>
    <ol>{run.trace.map((step) => <li key={step.id}>
      <strong>{kind(step.kind)}</strong> · {step.durationMs} ms · {state(step.state)}
      <p>{step.reason}</p>
      {!!(step.promptTokens || step.completionTokens) && <small>{t(locale, "aiTokenUsage")} · {(step.promptTokens || 0) + (step.completionTokens || 0)}</small>}
      {step.evidenceIds?.map((id) => <button className="btn-secondary" key={id} onClick={() => onEvidence(id)}>[{id}]</button>)}
      {step.error && <p className="ai-inspection-error">{step.error}</p>}
    </li>)}</ol>
  </details>;
}
