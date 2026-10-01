export type AnnotationAvailability = "available" | "unavailable";
export type LogAvailability = "absent" | "present" | "unavailable";

export interface JobObservation {
  repository: string;
  workflowName: string;
  runId: number;
  attempt: number;
  jobId: number;
  pullRequestNumbers: number[];
  conclusion: string | null;
  startedAt: string;
  completedAt: string;
  runnerName: string | null;
  stepCount: number;
  logAvailability: LogAvailability;
  annotationAvailability: AnnotationAvailability;
  annotationMessages: string[];
}

export type BillingReason = "payments_failed" | "spending_limit" | "structural_fallback";
export type DetectionConfidence = "confirmed" | "suspected";

export interface Detection {
  observation: JobObservation;
  confidence: DetectionConfidence;
  reason: BillingReason;
}

export interface IncidentState {
  schemaVersion: 2;
  windowStartedAt: string | null;
  incidentIssueId: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  clearWindows: number;
  recoveryExecutionSeen: boolean;
  affectedWorkflows: string[];
  affectedRepositories: string[];
  runAttempts: string[];
  pullRequestNumbers: number[];
  confidences: DetectionConfidence[];
  reasons: BillingReason[];
}

export const EMPTY_STATE: IncidentState = {
  schemaVersion: 2,
  windowStartedAt: null,
  incidentIssueId: null,
  firstSeenAt: null,
  lastSeenAt: null,
  clearWindows: 0,
  recoveryExecutionSeen: false,
  affectedWorkflows: [],
  affectedRepositories: [],
  runAttempts: [],
  pullRequestNumbers: [],
  confidences: [],
  reasons: [],
};
