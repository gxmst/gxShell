export interface InspectionEvidence {
  id: string;
  query: { check: string; service?: string; view?: string; port?: number; scope?: string };
  status: "collected" | "unavailable";
  output: string;
  error?: string;
  exitCode: number;
  remoteState: string;
  truncated: boolean;
  reason?: string;
  collectedAt?: string;
  sourceRunId?: string;
  sourceEvidenceId?: string;
}
export interface ReportCheck {
  check: string; status: "normal" | "warning" | "critical" | "unknown";
  reading: string; evidenceIds: string[];
  observed?: string;
}
export interface ReportFinding {
  severity: "warning" | "critical"; title: string; detail: string; impact: string;
  recommendation: string; evidenceIds: string[];
}
export interface ReportDocument {
  version: number; verdict: "normal" | "attention" | "unknown"; summary: string;
  checks: ReportCheck[]; findings: ReportFinding[];
  unknowns: { id?: string; title: string; detail: string; evidenceIds: string[] }[];
  analysis?: { assessment: string; insights: { title: string; opinion: string; confidence: "supported" | "hypothesis" | "uncertain"; evidenceIds: string[]; nextCheck: string }[]; nextSteps: string[]; caveats: string };
}
export interface InspectionReview { unknownId: string; outcome: "normal" | "issue" | "not_applicable" | "pending"; note: string; reviewer: string; at: string; }
export interface InspectionComparison { baselineId: string; baselineAt: string; comparedAt: string; changes: { metric: string; subject: string; before: string; after: string; delta: string; state: string }[]; }
export interface InspectionActionPlan { id: string; kind: string; title: string; command: string; impact: string; status: string; output?: string; error?: string; exitCode: number; remoteState?: string; verificationId?: string; verificationError?: string; createdAt: string; startedAt: string; finishedAt: string; }
export interface InspectionRun {
  id: string;
  workflow: string;
  sessionId: string;
  profileId: string;
  target: string;
  state: string;
  step: string;
  createdAt: string;
  finishedAt: string;
  evidence: InspectionEvidence[];
  report: string;
  error?: string;
  rounds: number;
  promptTokens: number;
  completionTokens: number;
  provider: string;
  model: string;
  language: string;
  document?: ReportDocument;
  stepReason?: string;
  service?: string;
  port?: number;
  reviews?: InspectionReview[];
  revision?: number;
  comparison?: InspectionComparison;
  plans?: InspectionActionPlan[];
  parentId?: string;
  question?: string;
  focusEvidenceId?: string;
  dossier?: HostDossier;
  trace?: InspectionTrace[];
  feedback?: InspectionFeedback[];
  reportSchemaVersion?: number;
  unverifiedAnswer?: string;
}

export interface DossierInput { revision: number; purpose: string; environment: string; services: string[]; ports: number[]; containerRuntime: string; notes: string; sourceRunId?: string; sourceUnknownId?: string; }
export interface DossierRevision extends DossierInput { updatedAt: string; reviewer: string; deleted?: boolean; }
export interface HostDossier extends DossierRevision { profileId: string; history?: DossierRevision[]; }
export interface InspectionTrace { id: string; kind: string; reason: string; state: string; query?: InspectionEvidence["query"]; evidenceIds?: string[]; startedAt: string; finishedAt: string; durationMs: number; promptTokens?: number; completionTokens?: number; error?: string; output?: string; }
export interface InspectionFeedback { outcome: "correct" | "false_alarm" | "missed_issue"; note: string; reviewer: string; at: string; }
export interface InspectionEvaluationCase { id: string; title: string; description: string; saved?: boolean; target?: string; createdAt?: string; }
export interface InspectionSavedCase { id: string; title: string; sourceRunId: string; target: string; workflow: string; service?: string; port?: number; evidence: InspectionEvidence[]; expected: Record<string, string>; feedback: InspectionFeedback; reviewer: string; createdAt: string; }
export interface InspectionEvaluationResult { caseId: string; title: string; passed: boolean; schemaValid: boolean; correctChecks: number; totalChecks: number; analysisPresent: boolean; expected: Record<string, string>; actual: Record<string, string>; error?: string; durationMs: number; promptTokens: number; completionTokens: number; rawReport?: string; }
export interface InspectionModelStats { provider: string; model: string; runs: number; stopped: number; clean: number; corrected: number; failed: number; noReport: number; falseAlarms: number; missedIssues: number; avgTokens: number; avgDurationMs: number; }
export interface InspectionEvaluationRun { id: string; provider: string; model: string; language: string; state: string; caseVersion: number; promptVersion?: string; caseIds: string[]; createdAt: string; finishedAt: string; results: InspectionEvaluationResult[]; error?: string; }
