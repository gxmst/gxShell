import { useState } from "react";
import { FeedbackAiInspection } from "../../../wailsjs/go/app/App";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";

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
  </section>;
}
