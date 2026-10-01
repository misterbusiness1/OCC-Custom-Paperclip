import type { BillingReason, Detection, JobObservation } from "./types.js";

const MAX_REFUSAL_ELAPSED_MS = 30_000;
const FALLBACK_CORRELATION_MS = 15 * 60_000;

export function elapsedMs(job: JobObservation): number {
  return Date.parse(job.completedAt) - Date.parse(job.startedAt);
}

export function hasStructuralRefusalSignature(job: JobObservation): boolean {
  const duration = elapsedMs(job);
  return job.conclusion === "failure"
    && Number.isFinite(duration)
    && duration >= 0
    && duration <= MAX_REFUSAL_ELAPSED_MS
    && job.stepCount === 0
    && !job.runnerName?.trim()
    && job.logAvailability === "absent";
}

export function billingReason(messages: string[]): BillingReason | null {
  const text = messages.join(" ").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ");
  const notStarted = /\b(job|workflow)\b.{0,80}\b(not|could not|wasn t|didn t)\b.{0,40}\b(start|started|run)\b/.test(text)
    || /\bnot started\b/.test(text);
  if (!notStarted) return null;
  if (/\b(payment|payments)\b.{0,40}\b(fail|failed|declin|past due)\b/.test(text)) return "payments_failed";
  if (/\b(spend|spending)\b.{0,20}\b(limit|cap)\b/.test(text)) return "spending_limit";
  return null;
}

export function detectBillingRefusals(observations: JobObservation[]): Detection[] {
  const confirmed: Detection[] = [];
  const fallbackCandidates: JobObservation[] = [];

  for (const observation of observations) {
    if (!hasStructuralRefusalSignature(observation)) continue;
    if (observation.annotationAvailability === "available") {
      const reason = billingReason(observation.annotationMessages);
      if (reason) confirmed.push({ observation, confidence: "confirmed", reason });
    } else {
      fallbackCandidates.push(observation);
    }
  }

  const suspected = fallbackCandidates.filter((candidate) => {
    const candidateTime = Date.parse(candidate.completedAt);
    const repositories = new Set(
      fallbackCandidates
        .filter((other) => Math.abs(Date.parse(other.completedAt) - candidateTime) <= FALLBACK_CORRELATION_MS)
        .map((other) => other.repository),
    );
    return repositories.size >= 2;
  }).map<Detection>((observation) => ({
    observation,
    confidence: "suspected",
    reason: "structural_fallback",
  }));

  return [...confirmed, ...suspected];
}

export function isRecoveryExecution(job: JobObservation, affectedWorkflows: Set<string>): boolean {
  return affectedWorkflows.has(`${job.repository}:${job.workflowName}`)
    && job.stepCount > 0
    && Boolean(job.runnerName?.trim());
}
