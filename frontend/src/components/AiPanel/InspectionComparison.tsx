import { useState } from "react";
import { CompareAiInspections } from "../../../wailsjs/go/app/App";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";
import { inspectionCheckLabel } from "./inspectionLabels";

export function InspectionComparison({ run, history, locale, onUpdated, onError }: {
  run: InspectionRun; history: InspectionRun[]; locale: string; onUpdated: (run: InspectionRun) => void; onError: (message: string) => void;
}) {
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const candidates = history.filter((r) => r.id !== run.id && r.workflow === run.workflow && r.service === run.service && r.port === run.port &&
    (run.profileId ? r.profileId === run.profileId : r.sessionId === run.sessionId) && Date.parse(r.createdAt) < Date.parse(run.createdAt) &&
    ["completed", "partial", "cancelled", "failed", "interrupted"].includes(r.state));
  const selected = candidates.find((r) => r.id === baseline)?.id || candidates[0]?.id || "";
  const compare = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try { onUpdated(await CompareAiInspections(run.id, selected)); } catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  const metric = (name: string) => {
    if (name === "memory_used") return t(locale, "inspectionMemoryUsed");
    if (name === "memory_available") return t(locale, "inspectionMemoryAvailable");
    if (name === "services") return t(locale, "inspectionFailedUnits");
    if (name === "service_state") return inspectionCheckLabel(locale, "service");
    return inspectionCheckLabel(locale, name);
  };
  return <section className="inspection-comparison">
    <h3>{t(locale, "inspectionComparisonTitle")}</h3>
    {candidates.length ? <div className="inspection-comparison-controls">
      <select className="input compact-input" aria-label={t(locale, "inspectionBaseline")} value={selected} onChange={(e) => setBaseline(e.target.value)} disabled={busy}>
        {candidates.map((r) => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString(locale)} · {r.target}</option>)}
      </select>
      <button className="btn-secondary" onClick={compare} disabled={busy}>{t(locale, "inspectionCompare")}</button>
    </div> : <p className="inspection-report-empty">{t(locale, "inspectionNoBaseline")}</p>}
    {run.comparison && <>
      <p className="inspection-report-empty">{t(locale, "inspectionBaseline")} · {new Date(run.comparison.baselineAt).toLocaleString(locale)}</p>
      <div className="inspection-report-table-wrap"><table>
        <thead><tr><th>{t(locale, "inspectionCheckColumn")}</th><th>{t(locale, "inspectionBefore")}</th><th>{t(locale, "inspectionCurrent")}</th><th>{t(locale, "inspectionChange")}</th></tr></thead>
        <tbody>{run.comparison.changes.map((c, i) => <tr key={i}><th>{metric(c.metric)} {c.subject}</th><td>{c.before}</td><td>{c.after}</td>
          <td>{c.state === "unknown" ? t(locale, "inspectionIncompleteComparison") : c.state === "unchanged" ? t(locale, "inspectionUnchanged") : c.delta || t(locale, "inspectionChanged")}</td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
