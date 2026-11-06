import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Play, Square, X } from "lucide-react";
import { StartAiInspectionBatch, ListAiInspectionBatches, CancelAiInspectionBatch, CancelAiInspection, GetAiInspection, ExportAiInspection, ExportAiInspectionBatch } from "../../../wailsjs/go/app/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import type { InspectionBatch, InspectionRun } from "../../../wailsjs/go/workflow";
import type { Tab, Toast } from "../../types";
import { isRemoteSession } from "../../utils/sessionIdentity";
import { t } from "../../i18n";
import { ModalShell } from "../modals/ModalShell";
import { InspectionReport } from "./InspectionReport";
import { inspectionReviewProgress } from "./inspectionReview";

const terminal = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
const states = { queued: "inspectionQueued", collecting: "inspectionCollecting", analyzing: "inspectionAnalyzing", querying: "inspectionQuerying", completed: "inspectionCompleted", cancelled: "inspectionCancelled", interrupted: "inspectionInterrupted", failed: "inspectionPartial", partial: "inspectionPartial" } as const;

function priority(run: InspectionRun) {
  const review = inspectionReviewProgress(run);
  if (!terminal.has(run.state)) return 0;
  if (run.state !== "completed") return 1;
  if (run.document?.checks.some((c) => c.status === "critical")) return 2;
  if (review.issue || run.document?.verdict === "attention") return 3;
  if (review.pending || (run.document?.verdict === "unknown" && !review.confirmed)) return 4;
  return 5;
}

export function InspectionBatchPanel({ locale, tabs, history, onUpdated, onNotify, onNavigate }: {
  locale: string; tabs: Tab[]; history: InspectionRun[];
  onUpdated: (run: InspectionRun) => void;
  onNavigate?: (run: InspectionRun) => void;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [concurrency, setConcurrency] = useState(2);
  const [batches, setBatches] = useState<InspectionBatch[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [reportId, setReportId] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState("");
  const [exporting, setExporting] = useState(false);
  const latest = useRef(new Map<string, InspectionRun>());
  const callbacks = useRef({ onNotify, onUpdated }); callbacks.current = { onNotify, onUpdated };
  const targets = tabs.filter(isRemoteSession).filter((tab, index, all) => !all.slice(0, index).some((earlier) => tab.profileId ? earlier.profileId === tab.profileId : earlier.id === tab.id));
  const selectedTargets = targets.filter((tab) => selected.includes(tab.id));
  const batch = batches.find((value) => value.id === selectedId) || batches[0];
  const running = batches.some((value) => value.state === "running");
  const report = batch?.runs.find((run) => run.id === reportId);
  const normalize = useCallback((value: InspectionBatch): InspectionBatch => {
    const runs = value.runs.map((run) => {
      const update = latest.current.get(run.id);
      const newest = update && (update.revision || 0) > (run.revision || 0) ? update : run;
      latest.current.set(run.id, newest);
      return newest;
    });
    const completed = runs.filter((run) => run.state === "completed").length;
    return { ...value, runs, completed, unfinished: runs.length - completed,
      state: runs.some((run) => !terminal.has(run.state)) ? "running" : completed === runs.length ? "completed" : "partial",
      promptTokens: runs.reduce((sum, run) => sum + run.promptTokens, 0), completionTokens: runs.reduce((sum, run) => sum + run.completionTokens, 0) };
  }, []);
  const applyRun = useCallback((run: InspectionRun) => {
    const old = latest.current.get(run.id);
    if ((old?.revision || 0) > (run.revision || 0)) return;
    latest.current.set(run.id, run);
    setBatches((values) => values.map(normalize));
    callbacks.current.onUpdated(run);
  }, [normalize]);
  useEffect(() => { setReportId(""); }, [batch?.id]);
  useEffect(() => {
    let disposed = false, refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const values = await ListAiInspectionBatches();
        if (!disposed) setBatches((previous) => {
          const merged = [...(values || []), ...previous.filter((old) => !values?.some((value) => value.id === old.id))];
          return merged.map(normalize).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 10);
        });
      } catch (error) { if (!disposed) callbacks.current.onNotify(String(error), "error"); }
      finally { refreshing = false; }
    };
    const off = EventsOn("ai:inspection", (run: InspectionRun) => {
      if (disposed || !run.batchId) return;
      applyRun(run);
    });
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { disposed = true; off(); window.clearInterval(timer); };
  }, [applyRun, normalize]);
  const start = async () => {
    if (busy || selectedTargets.length < 2 || running) return;
    setBusy(true);
    try {
      const value = await StartAiInspectionBatch(selectedTargets.map((tab) => tab.id), concurrency);
      setBatches((values) => [normalize(value), ...values.filter((old) => old.id !== value.id)]);
      setSelectedId(value.id);
    } catch (error) { onNotify(String(error), "error"); }
    finally { setBusy(false); }
  };
  const stop = async (id: string, wholeBatch: boolean) => {
    setStopping(id);
    try { if (wholeBatch) await CancelAiInspectionBatch(id); else await CancelAiInspection(id); }
    catch (error) { onNotify(String(error), "error"); }
    finally { setStopping(""); }
  };
  const open = async (id: string) => {
    try { applyRun(await GetAiInspection(id)); setReportId(id); }
    catch (error) { onNotify(String(error), "error"); }
  };
  const exportMD = async (id: string, wholeBatch: boolean) => {
    setExporting(true);
    try { const path = wholeBatch ? await ExportAiInspectionBatch(id) : await ExportAiInspection(id); if (path) onNotify(t(locale, "inspectionExported"), "success"); }
    catch (error) { onNotify(String(error), "error"); }
    finally { setExporting(false); }
  };
  const stateLabel = (state: string) => t(locale, states[state as keyof typeof states] || "inspectionPartial");
  return <div className="ai-inspection-panel">
    <p className="inspection-batch-description">{t(locale, "inspectionBatchDescription")}</p>
    <fieldset className="inspection-batch-targets" disabled={busy}>
      <legend>{t(locale, "inspectionBatchSelect")}</legend>
      {targets.map((tab) => {
        const occupied = history.some((run) => !terminal.has(run.state) && (tab.profileId ? run.profileId === tab.profileId : run.sessionId === tab.id));
        return <label key={tab.id}><input type="checkbox" checked={selectedTargets.some((value) => value.id === tab.id)} disabled={occupied || (!selected.includes(tab.id) && selectedTargets.length >= 12)}
          onChange={(event) => setSelected((values) => event.target.checked ? [...values.filter((id) => targets.some((target) => target.id === id)), tab.id] : values.filter((id) => id !== tab.id))} />{tab.title}{occupied && <small>{t(locale, "inspectionCollecting")}</small>}</label>;
      })}
      {!targets.length && <p>{t(locale, "aiNoConnectedTarget")}</p>}
    </fieldset>
    <div className="ai-inspection-controls">
      <label>{t(locale, "inspectionBatchConcurrency")} <select className="input compact-input" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} disabled={busy}>
        {[1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <button className="ai-tool-approve-btn" onClick={start} disabled={busy || running || selectedTargets.length < 2 || selectedTargets.some((tab) => history.some((run) => !terminal.has(run.state) && (tab.profileId ? run.profileId === tab.profileId : run.sessionId === tab.id)))}><Play size={12} />{t(locale, busy ? "inspectionStarting" : "inspectionBatchStart")}</button>
    </div>
    {batch ? <>
      <select className="input compact-input" aria-label={t(locale, "inspectionBatchHistory")} value={batch.id} onChange={(event) => setSelectedId(event.target.value)}>
        {batches.map((value) => <option key={value.id} value={value.id}>{new Date(value.createdAt).toLocaleString(locale)} · {value.runs.length} · {value.id.slice(0, 8)}</option>)}
      </select>
      <div className="ai-inspection-status" role="status"><strong>{t(locale, "inspectionBatchProgress")} {batch.completed}/{batch.runs.length}</strong>
        {batch.state === "running" && <button className="btn-secondary" disabled={!!stopping} onClick={() => void stop(batch.id, true)}><Square size={12} />{t(locale, "inspectionBatchStop")}</button>}
      </div>
      <div className="ai-inspection-meta">{batch.runs[0]?.model} · {t(locale, "aiTokenUsage")}: {batch.promptTokens + batch.completionTokens} · {t(locale, "inspectionBatchConcurrency")}: {batch.concurrency}</div>
      <div className="inspection-batch-results">{[...batch.runs].sort((a, b) => priority(a) - priority(b)).map((run) => {
        const review = inspectionReviewProgress(run);
        return <article key={run.id} className="inspection-batch-result" data-priority={priority(run)}>
          <div className="ai-inspection-status"><strong>{run.target}</strong><span>{stateLabel(run.state)}</span></div>
          {!terminal.has(run.state) ? <p>{run.stepReason || stateLabel(run.state)}</p> : <p>{run.document?.summary || run.error || t(locale, "inspectionBatchFailed")}</p>}
          {terminal.has(run.state) && run.error && run.document?.summary && <p className="ai-inspection-error">{run.error}</p>}
          <div className="ai-inspection-meta">{run.id.slice(0, 8)} · {t(locale, "aiTokenUsage")}: {run.promptTokens + run.completionTokens}
            {review.pending > 0 && <> · {t(locale, "inspectionBatchPending")}: {review.pending}</>}
            {(review.issue || run.document?.verdict === "attention") && <> · {t(locale, "inspectionBatchAttention")}</>}
          </div>
          {!terminal.has(run.state) ? <button className="btn-secondary" disabled={!!stopping} onClick={() => void stop(run.id, false)}><Square size={12} />{t(locale, "inspectionBatchStopHost")}</button> :
            <button className="btn-secondary" onClick={() => void open(run.id)}>{t(locale, "inspectionViewReport")}</button>}
        </article>;
      })}</div>
      <button className="btn-secondary" disabled={exporting || batch.state === "running"} onClick={() => void exportMD(batch.id, true)}><Download size={13} />{t(locale, "inspectionBatchExport")}</button>
    </> : <p className="ai-inspection-empty">{t(locale, "inspectionBatchEmpty")}</p>}
    {report && <ModalShell ariaLabel={t(locale, "inspectionViewReport")} className="inspection-report-modal" onClose={() => setReportId("")}>
      <div className="inspection-report-toolbar"><strong>{report.target} · {t(locale, "inspectionReport")}</strong><button className="mini-btn" aria-label={t(locale, "close")} onClick={() => setReportId("")}><X size={16} /></button></div>
      <div className="inspection-report-scroll"><InspectionReport run={report} locale={locale} history={history} onUpdated={applyRun} onError={(message) => onNotify(message, "error")}
        onFollowupCreated={onNavigate ? (run) => { callbacks.current.onUpdated(run); onNavigate(run); } : undefined}
        onSelectRun={onNavigate ? (id) => { void GetAiInspection(id).then(onNavigate).catch((error) => onNotify(String(error), "error")); } : undefined} /></div>
      <div className="inspection-report-actions"><button className="btn-secondary" disabled={exporting || !report.report} onClick={() => void exportMD(report.id, false)}><Download size={13} />{t(locale, "inspectionExportMd")}</button></div>
    </ModalShell>}
  </div>;
}
