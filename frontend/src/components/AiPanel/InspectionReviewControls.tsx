import { useEffect, useState } from "react";
import { ReviewAiInspectionUnknown } from "../../../wailsjs/go/app/App";
import type { InspectionRun, InspectionReview } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";
import { HostDossierEditor } from "./HostDossierEditor";
type Unknown = NonNullable<InspectionRun["document"]>["unknowns"][number];

export function InspectionReviewControls({ run, item, review, locale, onUpdated, onError }: {
  run: InspectionRun; item: Unknown; review?: InspectionReview; locale: string;
  onUpdated: (run: InspectionRun) => void; onError: (message: string) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [outcome, setOutcome] = useState("normal");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [remember, setRemember] = useState(false);
  const reviewOutcome = review?.outcome;
  const reviewNote = review?.note;
  const reviewAt = review?.at;
  useEffect(() => {
    setChecked(!!reviewOutcome && reviewOutcome !== "pending");
    setOutcome(reviewOutcome && reviewOutcome !== "pending" ? reviewOutcome : "normal");
    setNote(reviewNote || "");
  }, [reviewAt, reviewNote, reviewOutcome, item.id]);
  const save = async () => {
    if (!item.id || saving) return;
    setSaving(true);
    try { onUpdated(await ReviewAiInspectionUnknown(run.id, item.id, checked ? outcome : "pending", note)); }
    catch (error) { onError(String(error)); }
    finally { setSaving(false); }
  };
  if (!item.id) return null;
  return <div className="inspection-review-controls">
    <label className="inspection-review-check"><input type="checkbox" checked={checked} disabled={saving} onChange={(e) => setChecked(e.target.checked)} />{t(locale, "inspectionManuallyVerified")}</label>
    <select className="input compact-input" aria-label={t(locale, "inspectionReviewOutcome")} value={outcome} disabled={!checked || saving} onChange={(e) => setOutcome(e.target.value)}>
      <option value="normal">{t(locale, "inspectionReviewNormal")}</option>
      <option value="issue">{t(locale, "inspectionReviewIssue")}</option>
      <option value="not_applicable">{t(locale, "inspectionReviewNotApplicable")}</option>
    </select>
    <input className="input compact-input" aria-label={t(locale, "inspectionReviewNote")} placeholder={t(locale, "inspectionReviewNote")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={saving} />
    <button className="btn-secondary" disabled={saving || (!checked && (!review || review.outcome === "pending"))} onClick={save}>{t(locale, !checked && review && review.outcome !== "pending" ? "inspectionWithdrawReview" : "inspectionSaveReview")}</button>
    {review && <small>{t(locale, review.outcome === "pending" ? "inspectionReviewWithdrawn" : "inspectionReviewedBy")} · {review.reviewer} · {new Date(review.at).toLocaleString(locale)}</small>}
    {review && review.outcome !== "pending" && run.profileId && <button className="btn-secondary" onClick={() => setRemember((value) => !value)}>{t(locale, "inspectionHostRemember")}</button>}
    {remember && review && review.outcome !== "pending" && <HostDossierEditor profileId={run.profileId} locale={locale} onError={onError} sourceRunId={run.id} sourceUnknownId={item.id} suggestedNote={review.note || item.title + " · " + t(locale, review.outcome === "normal" ? "inspectionReviewNormal" : review.outcome === "issue" ? "inspectionReviewIssue" : "inspectionReviewNotApplicable")} />}
  </div>;
}
