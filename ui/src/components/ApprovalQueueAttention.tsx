import type { Approval } from "@paperclipai/shared";
import { approvalQueueNextFollowUp } from "../lib/approval-queue-attention";
import { timeAgo } from "../lib/timeAgo";

/** Diagnostics are advisory. Only the approval's explicit status proves its disposition. */
export function ApprovalQueueAttention({ approval }: { approval: Approval }) {
  const attention = approval.queueAttention;
  if (!attention) return null;
  const revision = approval.status === "revision_requested";
  if (!revision && !attention.staleReasons.length) return null;
  const outcome = attention.revisionOutcome;
  const next = approvalQueueNextFollowUp(attention);
  const blocked = attention.tasks.filter((task) => task.status === "blocked");
  return (
    <div className="basis-full space-y-1 text-xs text-muted-foreground" data-approval-queue-attention>
      {revision && <>
        <p className="font-medium text-foreground">Revision still outstanding; resubmission or disposition required.</p>
        <p>Work outcome: {outcome
          ? `${outcome.outcome === "durable_blocker" ? "blocked" : "unresolved"}${outcome.executionActive ? "; agent execution active" : ""}`
          : "not recorded for this revision"}. Successful execution alone does not complete a revision.</p>
        {outcome?.nextAction && <p>Next action: {outcome.nextAction}</p>}
        <p>
          Revision age: {attention.revisionRequestedAt ? <span title={new Date(attention.revisionRequestedAt).toLocaleString()}>{timeAgo(attention.revisionRequestedAt)}</span> : "decision time not recorded"}
          {" · "}Requester / revision owner: {attention.owner.name ?? (attention.owner.userId ? "requesting board user" : "missing owner")}
          {attention.owner.status ? ` (${attention.owner.status})` : ""}
        </p>
        <p>Blocker: {outcome?.blocker ?? (blocked.length
          ? blocked.map((task) => `${task.identifier ?? "Linked task"}: ${task.blockerAction ?? "blocked; reason not recorded"}`).join("; ")
          : "none recorded on linked tasks")}</p>
        <p className={!next ? "font-medium text-foreground" : undefined}>Next follow-up: {next
          ? <span title={next.toLocaleString()}>{next.toLocaleString()}{next.getTime() <= Date.now() ? " · overdue" : ""}</span>
          : "not scheduled"}</p>
      </>}
      {attention.staleReasons.includes("linked_task_closed") && <p className="font-medium text-foreground">Review needed: linked task completed or cancelled; approval is still open.</p>}
      {attention.staleReasons.includes("explicitly_superseded") && <p className="font-medium text-foreground">Review needed: explicitly superseded by approval {attention.supersededByApprovalId}.</p>}
    </div>
  );
}
