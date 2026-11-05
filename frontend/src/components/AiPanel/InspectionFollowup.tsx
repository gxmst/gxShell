import { useState } from "react";
import { StartAiInspectionFollowup } from "../../../wailsjs/go/app/App";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";
import { inspectionCheckLabel } from "./inspectionLabels";

export function InspectionFollowup({ run, locale, onCreated, onError, question: suggestedQuestion = "", focus: suggestedFocus = "" }: {
  run: InspectionRun; locale: string; onCreated: (run: InspectionRun) => void; onError: (message: string) => void; question?: string; focus?: string;
}) {
  const [question, setQuestion] = useState(suggestedQuestion);
  const [focus, setFocus] = useState(suggestedFocus);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (busy || !question.trim()) return;
    setBusy(true);
    try { onCreated(await StartAiInspectionFollowup(run.id, question.trim(), focus)); }
    catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  return <div className="inspection-followup-form">
    <p className="inspection-report-empty">{t(locale, "inspectionFollowupNote")}</p>
    <label>{t(locale, "inspectionFollowupQuestion")}<textarea className="input" rows={3} maxLength={600} value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy} /></label>
    <label>{t(locale, "inspectionFollowupFocus")}<select className="input" aria-label={t(locale, "inspectionFollowupFocus")} value={focus} onChange={(e) => setFocus(e.target.value)} disabled={busy}>
      <option value="">{t(locale, "inspectionFollowupWhole")}</option>
      {run.evidence.map((e) => <option key={e.id} value={e.id}>[{e.id}] {inspectionCheckLabel(locale, e.query.check)} {e.query.service || e.query.scope}</option>)}
    </select></label>
    <button className="btn-secondary" onClick={start} disabled={busy || !question.trim()}>{t(locale, "inspectionFollowupStart")}</button>
  </div>;
}
