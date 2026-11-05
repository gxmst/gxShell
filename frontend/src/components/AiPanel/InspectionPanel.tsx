import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Play, RefreshCw, Square, X } from "lucide-react";
import { StartAiInspection, StartAiServiceDiagnosis, StartAiDiskDiagnosis, GetAiInspection, ExportAiInspection, ListAiInspections, CancelAiInspection } from "../../../wailsjs/go/app/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import type { Tab, Toast } from "../../types";
import { isRemoteSession } from "../../utils/sessionIdentity";
import { writeClipboardText } from "../../utils/clipboard";
import { t } from "../../i18n";
import { InspectionReport, InspectionEvidence } from "./InspectionReport";
import { inspectionCheckLabel } from "./inspectionLabels";
import { ModalShell } from "../modals/ModalShell";
import { HostDossierEditor } from "./HostDossierEditor";
import { InspectionEvaluation } from "./InspectionEvaluation";

const terminalStates = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
const checkLabels = {
  system: "inspectionSystem", load: "inspectionLoad", disk: "inspectionDisk",
  memory: "inspectionMemory", services: "inspectionServices", ports: "inspectionPorts", containers: "inspectionContainers",
} as const;
const stateLabels = {
  queued: "inspectionQueued", collecting: "inspectionCollecting", analyzing: "inspectionAnalyzing",
  querying: "inspectionQuerying", completed: "inspectionCompleted", cancelled: "inspectionCancelled",
  interrupted: "inspectionInterrupted", partial: "inspectionPartial", failed: "inspectionPartial",
} as const;

export function InspectionPanel({ locale, tabs, activeTabId, onNotify }: {
  locale: string; tabs: Tab[]; activeTabId: string;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
}) {
  const [runs, setRuns] = useState<InspectionRun[]>([]);
  const [selectedRun, setSelectedRun] = useState("");
  const [targetId, setTargetId] = useState(activeTabId);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [workflow, setWorkflow] = useState("host_inspection");
  const [service, setService] = useState("");
  const [port, setPort] = useState("");
  const [dossierOpen, setDossierOpen] = useState(false);
  const notify = useRef(onNotify);
  notify.current = onNotify;
  const targets = tabs.filter(isRemoteSession);
  const selectedTarget = targets.find((tab) => tab.id === targetId);
  // Reports and history follow the selected server; a quick-connect tab has no
  // profile, so it matches by session instead.
  const forTarget = (item: InspectionRun) => !!selectedTarget && (selectedTarget.profileId ? item.profileId === selectedTarget.profileId : item.sessionId === selectedTarget.id);
  const targetRuns = selectedTarget ? runs.filter(forTarget) : runs;
  const run = targetRuns.find((item) => item.id === selectedRun) || targetRuns[0];
  const running = !!run && !terminalStates.has(run.state);
  const busyTarget = targetRuns.some((item) => !terminalStates.has(item.state));
  const validDiagnosis = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(service.trim()) && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const stateLabel = (state: string) => t(locale, stateLabels[state as keyof typeof stateLabels] || "inspectionPartial");
  const checkLabel = (check: string) => inspectionCheckLabel(locale, check);
  const checks = run?.workflow === "service_diagnosis" ? ["system", "services", "ports", "service", "connectivity"] : run?.workflow === "disk_diagnosis" ? ["system", "disk", "inodes", "disk_usage", "journal", "container_storage"] : Object.keys(checkLabels);
  const applyRun = (update: InspectionRun) => setRuns((previous) => {
    const existing = previous.find((r) => r.id === update.id);
    if ((existing?.revision || 0) > (update.revision || 0)) return previous;
    return [update, ...previous.filter((r) => r.id !== update.id)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 30);
  });
  const selectRun = async (id: string) => {
    try { const selected = await GetAiInspection(id); applyRun(selected); setSelectedRun(id); }
    catch (error) { onNotify(String(error), "error"); }
  };
  useEffect(() => { setReportOpen(false); }, [run?.id]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === targetId && isRemoteSession(tab))) {
      setTargetId(tabs.find(isRemoteSession)?.id || "");
    }
  }, [tabs, targetId]);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let eventVersion = 0;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const version = eventVersion;
      try {
        const history = await ListAiInspections();
        if (!disposed && version === eventVersion) setRuns((previous) => [...(history || []).map((item) => {
          const newer = previous.find((r) => r.id === item.id);
          return (newer?.revision || 0) > (item.revision || 0) ? newer! : item;
        }), ...previous.filter((item) => !history?.some((r) => r.id === item.id))].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 30));
      } catch (error) {
        if (!disposed) notify.current(String(error), "error");
      } finally { refreshing = false; }
    };
    const off = EventsOn("ai:inspection", (update: InspectionRun) => {
      if (disposed) return;
      eventVersion++;
      setRuns((previous) => (previous.find((r) => r.id === update.id)?.revision || 0) > (update.revision || 0) ? previous : [update, ...previous.filter((item) => item.id !== update.id)]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 30));
    });
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { disposed = true; off(); window.clearInterval(timer); };
  }, []);

  const start = async () => {
    if (!selectedTarget || starting) return;
    setStarting(true);
    try {
      const created = workflow === "service_diagnosis"
        ? await StartAiServiceDiagnosis(selectedTarget.id, service.trim(), Number(port))
        : workflow === "disk_diagnosis" ? await StartAiDiskDiagnosis(selectedTarget.id) : await StartAiInspection(selectedTarget.id);
      setRuns((previous) => previous.some((item) => item.id === created.id) ? previous : [created, ...previous]);
      setSelectedRun(created.id);
    } catch (error) { onNotify(String(error), "error"); }
    finally { setStarting(false); }
  };
  const exportReport = async () => {
    if (!run || exporting) return;
    setExporting(true);
    try {
      const path = await ExportAiInspection(run.id);
      if (path) onNotify(t(locale, "inspectionExported"), "success");
    } catch (error) { onNotify(String(error), "error"); }
    finally { setExporting(false); }
  };
  const reportActions = () => <div className="inspection-report-actions">
    <button className="btn-secondary" onClick={exportReport} disabled={exporting || running || !run?.report}><Download size={13} />{t(locale, "inspectionExportMd")}</button>
    <button className="btn-secondary" onClick={() => writeClipboardText(run?.report || "").then(() => onNotify(t(locale, "copiedToClipboard"), "success")).catch(() => onNotify(t(locale, "copyFailed"), "error"))} disabled={!run?.report}><Copy size={13} />{t(locale, "inspectionCopyReport")}</button>
  </div>;
  const cancel = async () => {
    if (!run || cancelling) return;
    setCancelling(true);
    try { await CancelAiInspection(run.id); }
    catch (error) { onNotify(String(error), "error"); }
    finally { setCancelling(false); }
  };

  const collectionStatus = () => (
<div className="ai-inspection-checks">
        {checks.map((check) => {
          const evidence = run?.evidence.find((item) => item.query.check === check);
          const active = running && (run?.step === check || run?.step.startsWith(check + ":"));
          return <div key={check} className="ai-inspection-check">
            {evidence?.status === "collected" ? <Check size={12} /> : active ? <RefreshCw size={12} className="animate-spin" /> : <span>·</span>}
            <span>{checkLabel(check)}</span>
            <small>{evidence ? evidence.status === "collected" ? t(locale, "inspectionCollected") : t(locale, "inspectionUnavailable") : active ? t(locale, "inspectionCollecting") : t(locale, "inspectionNotChecked")}</small>
          </div>;
        })}
      </div>
  );

  return <div className="ai-inspection-panel">
    <div className="ai-inspection-intro">
      <strong>{t(locale, "inspectionTitle")}</strong>
      <p>{t(locale, "inspectionDescription")}</p>
      <select className="input compact-input" aria-label={t(locale, "inspectionWorkflow")} value={workflow} onChange={(event) => setWorkflow(event.target.value)} disabled={starting}>
        <option value="host_inspection">{t(locale, "inspectionHostWorkflow")}</option>
        <option value="service_diagnosis">{t(locale, "inspectionServiceWorkflow")}</option>
        <option value="disk_diagnosis">{t(locale, "inspectionDiskWorkflow")}</option>
      </select>
      {workflow === "service_diagnosis" && <div className="inspection-diagnosis-fields">
        <label>{t(locale, "inspectionDiagnosisService")}<input className="input compact-input" value={service} placeholder="nginx.service" onChange={(event) => setService(event.target.value)} disabled={starting} maxLength={128} /></label>
        <label>{t(locale, "inspectionDiagnosisPort")}<input className="input compact-input" value={port} placeholder="443" inputMode="numeric" onChange={(event) => setPort(event.target.value)} disabled={starting} maxLength={5} /></label>
        <small>{t(locale, "inspectionDiagnosisScope")}</small>
      </div>}
      <div className="ai-inspection-controls">
        <select className="input compact-input" aria-label={t(locale, "inspectionTarget")} value={selectedTarget?.id || ""} onChange={(event) => setTargetId(event.target.value)} disabled={starting}>
          {!selectedTarget && <option value="">{t(locale, "aiNoConnectedTarget")}</option>}
          {targets.map((tab) => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
        </select>
        <button className="ai-tool-approve-btn" onClick={start} disabled={!selectedTarget || starting || busyTarget || (workflow === "service_diagnosis" && !validDiagnosis)}>
          <Play size={11} /> {starting ? t(locale, "inspectionStarting") : t(locale, "inspectionStart")}
        </button>
      </div>
      {selectedTarget?.profileId && <details className="inspection-host-background" onToggle={(e) => setDossierOpen(e.currentTarget.open)}><summary>{t(locale, "inspectionHostDossier")} · {selectedTarget.title}</summary>
        {dossierOpen && <HostDossierEditor profileId={selectedTarget.profileId} locale={locale} onError={(message) => onNotify(message, "error")} />}
      </details>}
      <InspectionEvaluation locale={locale} onError={(message) => onNotify(message, "error")} />
    </div>
    {targetRuns.length > 0 && <select className="input compact-input" aria-label={t(locale, "inspectionHistory")} value={run?.id || ""} onChange={(event) => setSelectedRun(event.target.value)}>
      {targetRuns.map((item) => <option key={item.id} value={item.id}>{item.target} · {new Date(item.createdAt).toLocaleString(locale)} · {stateLabel(item.state)}</option>)}
    </select>}
    {!run ? <div className="ai-inspection-empty">{t(locale, "inspectionEmpty")}</div> : <>
      <div className="ai-inspection-status" role="status">
        <span><strong>{run.target}</strong> · {stateLabel(run.state)}</span>
        {running ? <button className="mini-btn" onClick={cancel} disabled={cancelling} title={t(locale, "aiStop")}><Square size={12} /></button> :
          <button className="mini-btn" title={t(locale, "copyContent")} onClick={() => writeClipboardText(run.report).then(() => onNotify(t(locale, "copiedToClipboard"), "success")).catch(() => onNotify(t(locale, "copyFailed"), "error"))}><Copy size={12} /></button>}
      </div>
      <div className="ai-inspection-meta">{run.model} · {t(locale, "inspectionRounds")}: {run.rounds}/3 · {t(locale, "aiTokenUsage")}: {run.promptTokens + run.completionTokens}</div>
      {run.report && <><InspectionReport run={run} locale={locale} compact onOpen={() => setReportOpen(true)} />{reportActions()}</>}
      {running && run.stepReason && <div className="inspection-progress-reason"><RefreshCw size={12} className="animate-spin" /><span>{run.stepReason}</span></div>}
      {running ? collectionStatus() : <details className="inspection-collection-details"><summary>{t(locale, "inspectionCollectionStatus")}</summary>{collectionStatus()}</details>}
      {run.error && <div className="ai-inspection-error">{run.error}</div>}
      <InspectionEvidence run={run} locale={locale} scope={"side-" + run.id} />
      {reportOpen && <ModalShell ariaLabel={t(locale, "inspectionViewReport")} className="inspection-report-modal" onClose={() => setReportOpen(false)}>
        <div className="inspection-report-toolbar"><strong>{t(locale, "inspectionReport")}</strong><button className="mini-btn" aria-label={t(locale, "close")} onClick={() => setReportOpen(false)}><X size={16} /></button></div>
        <div className="inspection-report-scroll"><InspectionReport run={run} locale={locale} history={runs} onUpdated={applyRun} onError={(message) => onNotify(message, "error")} onSelectRun={(id) => void selectRun(id)} onFollowupCreated={(created) => { applyRun(created); setSelectedRun(created.id); }} /></div>
        {reportActions()}
      </ModalShell>}
    </>}
  </div>;
}
