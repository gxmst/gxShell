import { useState } from "react";
import { FeedbackAiInspection, SaveAiInspectionCase } from "../../../wailsjs/go/app/App";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";
import { inspectionCheckLabel } from "./inspectionLabels";

const STATES = ["normal", "warning", "critical", "unknown"] as const;
const STATE_LABELS = { normal: "inspectionNormal", warning: "inspectionWarning", critical: "inspectionCritical", unknown: "inspectionUnknown" } as const;

// Freezes a flagged report as an evaluation case. The states start from the
// report; the user changes the ones the model got wrong.
function SaveAsCase({ run, locale, onError }: { run: InspectionRun; locale: string; onError: (message: string) => void }) {
  const latest = run.feedback?.[run.feedback.length - 1];
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [expected, setExpected] = useState<Record<string, string>>({});
  if (!latest || latest.outcome === "correct" || !run.document?.checks.length) return null;
  if (saved) return <p>{t(locale, "inspectionCaseSaved")}</p>;
  if (!open) return <button className="btn-secondary" onClick={() => {
    setTitle(latest.note.slice(0, 60));
    setExpected(Object.fromEntries(run.document!.checks.map((check) => [check.check, check.status])));
    setOpen(true);
  }}>{t(locale, "inspectionCaseAdd")}</button>;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try { await SaveAiInspectionCase(run.id, title, expected); setSaved(true); }
    catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  return <div className="inspection-case-form">
    <p>{t(locale, "inspectionCaseNote")}</p>
    <input className="input" maxLength={120} aria-label={t(locale, "inspectionCaseTitle")} placeholder={t(locale, "inspectionCaseTitle")} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
    {Object.keys(expected).map((check) => <label key={check}>{inspectionCheckLabel(locale, check)}
      <select className="input" aria-label={inspectionCheckLabel(locale, check)} value={expected[check]} disabled={busy} onChange={(e) => setExpected((previous) => ({ ...previous, [check]: e.target.value }))}>
        {STATES.map((state) => <option key={state} value={state}>{t(locale, STATE_LABELS[state])}</option>)}
      </select>
    </label>)}
    <button className="btn-secondary" onClick={save} disabled={busy || !title.trim()}>{t(locale, "inspectionCaseSave")}</button>
  </div>;
}

export function InspectionFeedback({ run, locale, onUpdated, onError }: { run: InspectionRun; locale: string; onUpdated: (run: InspectionRun) => void; onError: (message: string) => void }) {
  const [outcome, setOutcome] = useState("correct");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const label = (value: string) => t(locale, value === "correct" ? "inspectionFeedbackCorrect" : value === "false_alarm" ? "inspectionFeedbackFalseAlarm" : "inspectionFeedbackMissed");
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try { onUpdated(await FeedbackAiInspection(run.id, outcome, note)); setNote(""); }
    catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  return <section className="inspection-feedback">
    <h3>{t(locale, "inspectionFeedback")}</h3>
    <select className="input" aria-label={t(locale, "inspectionFeedback")} value={outcome} onChange={(e) => setOutcome(e.target.value)} disabled={busy}>
      {["correct", "false_alarm", "missed_issue"].map((value) => <option key={value} value={value}>{label(value)}</option>)}
    </select>
    <textarea className="input" rows={2} maxLength={600} aria-label={t(locale, "inspectionFeedbackNote")} placeholder={t(locale, "inspectionFeedbackNote")} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
    <button className="btn-secondary" onClick={save} disabled={busy || (outcome !== "correct" && !note.trim())}>{t(locale, "inspectionFeedbackSave")}</button>
    {run.feedback?.map((feedback, index) => <p key={index}>{label(feedback.outcome)} · {feedback.reviewer} · {new Date(feedback.at).toLocaleString(locale)}<br />{feedback.note}</p>)}
    <SaveAsCase key={run.feedback?.length || 0} run={run} locale={locale} onError={onError} />
  </section>;
}
