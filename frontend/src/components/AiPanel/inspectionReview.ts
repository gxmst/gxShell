import type { InspectionRun } from "../../../wailsjs/go/workflow";
export function latestInspectionReviews(run: InspectionRun) {
  return new Map((run.reviews || []).map((r) => [r.unknownId, r]));
}
export function inspectionReviewProgress(run: InspectionRun) {
  const latest = latestInspectionReviews(run);
  const unknowns = run.document?.unknowns || [];
  let confirmed = 0, issue = false, normal = 0, issues = 0, notApplicable = 0;
  for (const u of unknowns) {
    const review = latest.get(u.id || "");
    if (review && review.outcome !== "pending") {
      confirmed++; issue ||= review.outcome === "issue";
      if (review.outcome === "normal") normal++;
      if (review.outcome === "issue") issues++;
      if (review.outcome === "not_applicable") notApplicable++;
    }
  }
  return { confirmed, pending: unknowns.length - confirmed, issue, normal, issues, notApplicable };
}
