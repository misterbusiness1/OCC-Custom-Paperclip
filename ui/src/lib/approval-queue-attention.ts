import type { ApprovalQueueAttention } from "@paperclipai/shared";

/** A recorded follow-up, never an invented deadline or a closed task's old monitor. */
export function approvalQueueNextFollowUp(attention: ApprovalQueueAttention): Date | null {
  const values = [
    attention.revisionOutcome?.nextFollowUpAt,
    ...attention.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled")
      .map((task) => task.nextFollowUpAt),
  ];
  const dates = values.flatMap((value) => value ? [new Date(value)] : [])
    .filter((date) => Number.isFinite(date.getTime()));
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
}
