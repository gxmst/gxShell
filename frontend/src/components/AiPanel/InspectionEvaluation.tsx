import { useEffect, useRef, useState } from "react";
import { ListAiInspectionEvaluationCases, ListAiInspectionEvaluations, StartAiInspectionEvaluation, CancelAiInspectionEvaluation, DeleteAiInspectionCase } from "../../../wailsjs/go/app/App";
import type { InspectionEvaluationCase, InspectionEvaluationRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";
import { inspectionCheckLabel } from "./inspectionLabels";

// Mirrors the backend limit on cases per evaluation.
const MAX_SELECTED = 8;

export function InspectionEvaluation({ locale, onError }: { locale: string; onError: (message: string) => void }) {
  const [cases, setCases] = useState<InspectionEvaluationCase[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [evaluations, setEvaluations] = useState<InspectionEvaluationRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState("");
  const updateVersion = useRef(0);
  const errorCallback = useRef(onError); errorCallback.current = onError;
  useEffect(() => {
    let disposed = false, refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const version = updateVersion.current;
      try { const values = await ListAiInspectionEvaluations(); if (!disposed && version === updateVersion.current) setEvaluations(values || []); }
      catch (error) { if (!disposed) errorCallback.current(String(error)); } finally { refreshing = false; }
    };
    void (async () => {
      try { const values = await ListAiInspectionEvaluationCases(); if (!disposed) { setCases(values || []); setSelected((values || []).filter((value) => !value.saved).map((value) => value.id)); } }
      catch (error) { if (!disposed) errorCallback.current(String(error)); }
    })();
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [locale]);
  const evaluation = evaluations.find((value) => value.id === selectedId) || evaluations[0];
  const running = evaluations.some((value) => value.state === "running");
  const verdict = (value: string) => t(locale, ({ normal: "inspectionNormal", warning: "inspectionWarning", critical: "inspectionCritical", unknown: "inspectionUnknown" } as const)[value as "normal"] || "inspectionUnknown");
  const start = async () => {
    if (busy || running || !selected.length) return;
    setBusy(true);
    updateVersion.current++;
    try { const value = await StartAiInspectionEvaluation(selected); updateVersion.current++; setEvaluations((previous) => [value, ...previous.filter((e) => e.id !== value.id)]); setSelectedId(value.id); }
    catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (deleting !== id) { setDeleting(id); return; }
    try { await DeleteAiInspectionCase(id); setCases((previous) => previous.filter((value) => value.id !== id)); setSelected((previous) => previous.filter((value) => value !== id)); }
    catch (error) { onError(String(error)); } finally { setDeleting(""); }
  };
  const caseRow = (value: InspectionEvaluationCase) => <label key={value.id} title={value.description}>
    <input type="checkbox" checked={selected.includes(value.id)} disabled={busy || running || (!selected.includes(value.id) && selected.length >= MAX_SELECTED)}
      onChange={(e) => setSelected((previous) => e.target.checked ? [...previous, value.id] : previous.filter((id) => id !== value.id))} />{value.title}
    {value.saved && <><small>{value.target} · {value.description}</small>
      <button className="mini-btn" disabled={busy || running} onClick={(e) => { e.preventDefault(); void remove(value.id); }}>{t(locale, deleting === value.id ? "inspectionCaseDeleteConfirm" : "inspectionCaseDelete")}</button></>}
  </label>;
  const savedCases = cases.filter((value) => value.saved);
  return <section className="inspection-evaluation">
    <p>{t(locale, "inspectionEvaluationNote")}</p>
    <div className="inspection-evaluation-cases">{cases.filter((value) => !value.saved).map(caseRow)}</div>
    <strong>{t(locale, "inspectionCasesSaved")}</strong>
    {savedCases.length ? <>
      <p>{t(locale, "inspectionCasesSavedNote")}</p>
      <div className="inspection-evaluation-cases">{savedCases.map(caseRow)}</div>
    </> : <p className="inspection-report-empty">{t(locale, "inspectionCasesEmpty")}</p>}
    <button className="btn-secondary" onClick={start} disabled={busy || running || !selected.length}>{t(locale, "inspectionEvaluationStart")}</button>
    {evaluation && <>
      <select className="input" aria-label={t(locale, "inspectionEvaluationHistory")} value={evaluation.id} onChange={(e) => setSelectedId(e.target.value)}>
        {evaluations.map((value) => <option key={value.id} value={value.id}>{new Date(value.createdAt).toLocaleString(locale)} · {value.model}</option>)}
      </select>
      <p>{evaluation.provider} · {evaluation.model} · {t(locale, "inspectionEvaluationVersion")} {evaluation.caseVersion} · {evaluation.promptVersion} · {evaluation.results.length}/{evaluation.caseIds.length}</p>
      {evaluation.state === "running" && <button className="btn-secondary" onClick={() => CancelAiInspectionEvaluation(evaluation.id).catch((error) => onError(String(error)))}>{t(locale, "aiStop")}</button>}
      {evaluation.error && <p className="ai-inspection-error">{evaluation.error}</p>}
      {evaluation.results.map((result) => <details key={result.caseId}>
        <summary>{result.title} · {t(locale, result.passed ? "inspectionEvaluationPassed" : "inspectionEvaluationFailed")} · {result.correctChecks}/{result.totalChecks}</summary>
        <p>{t(locale, "inspectionEvaluationCheckScore")} {result.correctChecks}/{result.totalChecks} · {result.durationMs} ms · {t(locale, "aiTokenUsage")} {result.promptTokens + result.completionTokens}</p>
        <div className="inspection-report-table-wrap"><table>
          <thead><tr><th>{t(locale, "inspectionCheckColumn")}</th><th>{t(locale, "inspectionEvaluationExpected")}</th><th>{t(locale, "inspectionEvaluationActual")}</th></tr></thead>
          <tbody>{Object.entries(result.expected).map(([check, expected]) => <tr key={check}><th>{inspectionCheckLabel(locale, check)}</th><td>{verdict(expected)}</td><td>{result.actual[check] ? verdict(result.actual[check]) : "—"}</td></tr>)}</tbody>
        </table></div>
        {result.error && <p className="ai-inspection-error">{result.error}</p>}
        {result.rawReport && <details><summary>{t(locale, "inspectionEvaluationRaw")}</summary><pre>{result.rawReport}</pre></details>}
      </details>)}
    </>}
    <p className="inspection-report-empty">{t(locale, "inspectionEvaluationLimits")}</p>
  </section>;
}
