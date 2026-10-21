import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { logger } from "../../middleware/logger.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, agents, approvals, companies, heartbeatRuns,
  issueApprovals, issueRecoveryActions, issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { decideRevisionRecovery, revisionIdentity, REVISION_ATTEMPT_ACTIVITY, REVISION_OUTCOME_ACTIVITY,
  REVISION_RECOVERY_MAX_ATTEMPTS } from "./revision-outcome.js";

type Wake = (agentId: string, options: {
  source: "automation"; triggerDetail: "system"; reason: string; idempotencyKey: string;
  requestedByActorType: "system"; requestedByActorId: null;
  payload: Record<string, unknown>; contextSnapshot: Record<string, unknown>;
  issueStateGuard: { statuses: string[]; assigneeAgentId: string };
}) => Promise<unknown>;

/** Uses the existing recovery sweep, wake queue, activity ledger and recovery actions. No new scheduler. */
export function revisionReconciliation(db: Db, enqueueWakeup: Wake) {
  let cursor: string | null = null;
  const actions = issueRecoveryActionService(db);
  const tree = issueTreeControlService(db);

  async function reconcile(opts?: { issueCreatedAtGte?: Date | null }) {
    // Settled history must not consume bounded slots forever. A later board revision
    // always re-enters; a resubmitted card gets one final pass after terminal disposition.
    const candidates = await db.select({ id: approvals.id, companyId: approvals.companyId })
      .from(approvals).innerJoin(companies, eq(companies.id, approvals.companyId))
      .where(and(eq(companies.status, "active"), cursor ? gt(approvals.id, cursor) : undefined,
        sql`(${approvals.status} = 'revision_requested' or (
          select (revision_history.details->>'outcome' in ('unresolved', 'durable_blocker')
            or (revision_history.details->>'outcome' = 'resubmitted'
              and ${approvals.status} in ('approved', 'rejected', 'cancelled')))
          from activity_log revision_history where revision_history.company_id = ${approvals.companyId}
            and revision_history.entity_type = 'approval' and revision_history.entity_id = ${approvals.id}::text
            and revision_history.action = ${REVISION_OUTCOME_ACTIVITY}
          order by revision_history.created_at desc, revision_history.id desc limit 1
        ))`)).orderBy(asc(approvals.id)).limit(100);
    cursor = candidates.length === 100 ? candidates[candidates.length - 1]!.id : null;
    const handledIssueIds = new Set<string>();
    for (const candidate of candidates) {
      try {
      // Publish only after this transaction commits, including outcomes with no retry reservation.
      const publications: ActivityPublication[] = [];
      const reservation = await db.transaction(async tx => {
        // Cross-process reservation. Commit before queue admission: a crash consumes one bounded
        // attempt, whose lease expires on the next sweep; admission never holds this row lock.
        const lock = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(
          hashtextextended(${`approval-revision:${candidate.companyId}:${candidate.id}`}, 0)) as locked`);
        if (!lock[0]?.locked) return null;
        const [approval] = await tx.select().from(approvals).where(and(eq(approvals.id, candidate.id),
          eq(approvals.companyId, candidate.companyId))).for("update");
        if (!approval) return null;
        const [company] = await tx.select().from(companies).where(and(eq(companies.id, candidate.companyId),
          eq(companies.status, "active"))).for("share");
        if (!company) return null;
        const history = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, approval.companyId),
          eq(activityLog.entityType, "approval"), eq(activityLog.entityId, approval.id),
          inArray(activityLog.action, [REVISION_OUTCOME_ACTIVITY, REVISION_ATTEMPT_ACTIVITY])))
          .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
        const prior = history.find(row => row.action === REVISION_OUTCOME_ACTIVITY);
        const decidedAt = approval.status === "revision_requested" ? approval.decidedAt :
          typeof prior?.details?.revisionDecidedAt === "string" ? new Date(prior.details.revisionDecidedAt) : null;
        if (!decidedAt || !Number.isFinite(decidedAt.getTime())) return null;
        const revisionKey = revisionIdentity(approval.id, decidedAt);
        const attempts = history.filter(row => row.action === REVISION_ATTEMPT_ACTIVITY && row.details?.revisionKey === revisionKey);
        const linked = await tx.select({ issue: issues }).from(issueApprovals)
          .innerJoin(issues, and(eq(issues.id, issueApprovals.issueId), eq(issues.companyId, approval.companyId)))
          .where(and(eq(issueApprovals.companyId, approval.companyId), eq(issueApprovals.approvalId, approval.id)))
          .orderBy(asc(issues.id));
        const linkedIssues = linked.map(row => row.issue);
        if (opts?.issueCreatedAtGte && !linkedIssues.some(issue => issue.createdAt >= opts.issueCreatedAtGte!)) return null;
        for (const issue of linkedIssues) handledIssueIds.add(issue.id);
        const requester = approval.requestedByAgentId;
        const [agent] = requester ? await tx.select().from(agents).where(and(eq(agents.id, requester),
          eq(agents.companyId, approval.companyId))) : [];
        let blocker: string | null = null;
        let activeExecution = false;
        const issueIds = linkedIssues.map(row => row.id);
        if (issueIds.length) {
          const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, approval.companyId), inArray(issueThreadInteractions.issueId, issueIds),
            eq(issueThreadInteractions.status, "pending"))).limit(1);
          if (interaction) blocker = `interaction:${interaction.id}`;
          const recoveries = await tx.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, approval.companyId), inArray(issueRecoveryActions.sourceIssueId, issueIds),
            inArray(issueRecoveryActions.status, ["active", "escalated"])));
          for (const recovery of recoveries) {
            if (recovery.cause === "approval_revision_unresolved" && recovery.evidence?.approvalId === approval.id &&
              (approval.status !== "revision_requested" || recovery.fingerprint !== revisionKey)) {
              await actions.resolveActiveForIssue({ companyId: approval.companyId, sourceIssueId: recovery.sourceIssueId,
                actionId: recovery.id, status: "resolved", outcome: "restored",
                resolutionNote: "Same-card revision was resubmitted/disposed or a later decision superseded this revision." }, tx);
            } else if (!blocker || (recovery.cause === "approval_revision_unresolved"
              && recovery.evidence?.approvalId === approval.id && recovery.fingerprint === revisionKey)) {
              blocker = `recovery_action:${recovery.id}`;
            }
          }
          const [dependency] = await tx.select({ id: issues.id }).from(issueRelations).innerJoin(issues,
            and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, approval.companyId)))
            .where(and(eq(issueRelations.companyId, approval.companyId), inArray(issueRelations.relatedIssueId, issueIds),
              eq(issueRelations.type, "blocks"), isNull(issues.hiddenAt), sql`${issues.status} not in ('done', 'cancelled')`)).limit(1);
          if (!blocker && dependency) blocker = `issue:${dependency.id}`;
          // Sharing a task with another approval does not make that proposal a
          // dependency of editing this revision. Business execution remains gated
          // by normal admission and each proposal's independent board decision.
          const human = linkedIssues.find(issue => issue.assigneeUserId);
          if (!blocker && human) blocker = `user:${human.assigneeUserId}:issue:${human.id}`;
          const monitor = linkedIssues.find(issue => !["done", "cancelled"].includes(issue.status)
            && issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > Date.now());
          if (!blocker && monitor) blocker = `monitor:${monitor.id}:${monitor.monitorNextCheckAt!.toISOString()}`;
          const [liveRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, approval.companyId),
            inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' in (${sql.join(issueIds.map(id => sql`${id}`), sql`, `)})`)).limit(1);
          const [wake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, approval.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "deferred_agent_execution"]),
            sql`${agentWakeupRequests.payload}->>'issueId' in (${sql.join(issueIds.map(id => sql`${id}`), sql`, `)})`,
            isNull(agentWakeupRequests.finishedAt))).limit(1);
          activeExecution = Boolean(liveRun || wake);
        }
        if (approval.status === "revision_requested" && !blocker && agent?.status === "paused") blocker = `agent:${agent.id}:paused`;
        const target = linkedIssues.length === 1 ? linkedIssues[0]! : null;
        const review = target?.status === "in_review" ? parseIssueExecutionState(target.executionState) : null;
        if (!blocker && review?.status === "pending" && review.currentParticipant) {
          blocker = `execution_review:${target!.id}:${review.currentStageId ?? "pending"}`;
        }
        if (!blocker && target?.unblockDescriptor) blocker = `unblock_descriptor:${target.id}`;
        if (approval.status !== "revision_requested") blocker = null;
        const unsafe = !target || !requester || !agent || target.assigneeAgentId !== requester ||
          !["todo", "in_progress", "blocked"].includes(target.status) || Boolean(target.hiddenAt);
        const held = target && await isAutomaticRecoverySuppressedByPauseHold(db, approval.companyId, target.id, tree);
        const operatorHeld = Boolean(held) || agent?.status === "paused";
        const invokable = !unsafe && !held && (await evaluateAgentInvokabilityFromDb(db, agent)).invokable;
        const decision = decideRevisionRecovery({ status: approval.status, decidedAt, now: new Date(),
          attemptCount: attempts.length, lastAttemptAt: attempts[0]?.createdAt ?? null,
          blocker, activeExecution: activeExecution || operatorHeld, invokable, operatorHeld });
        const nextAction = ["resubmitted", "disposed"].includes(decision.outcome) ? "No follow-up required." :
          decision.action === "retry" ? "Resubmit this same approval or record a durable named blocker." :
          decision.action === "escalate" ? "Board: resolve revision ownership or exhausted follow-through; do not infer disposition from run success." :
          blocker ? `Wait for ${blocker}.` : activeExecution || held ? "Preserve the current execution or operator hold; recheck domain outcome on the existing sweep." :
          decision.nextFollowUpAt ? "Recheck on the existing recovery sweep after nextFollowUpAt." : "No follow-up required.";
        let recoveryActionId: string | null = null;
        if (decision.action === "escalate" && linkedIssues[0]) {
          // Never replace an existing action or change issue assignment/status. The existing
          // board-owned action is the durable attention path used by recovery UI and inboxes.
          const [inserted] = await tx.insert(issueRecoveryActions).values({ companyId: approval.companyId,
            sourceIssueId: linkedIssues[0].id, kind: "stranded_assigned_issue", ownerType: "board",
            cause: "approval_revision_unresolved", fingerprint: revisionKey,
            nextAction, maxAttempts: REVISION_RECOVERY_MAX_ATTEMPTS, attemptCount: attempts.length,
            status: "escalated", evidence: { approvalId: approval.id, revisionKey,
              outcome: "unresolved", linkedIssueIds: issueIds, reason: unsafe ? "missing_or_ambiguous_owner_or_terminal_link" : "retry_budget_exhausted_or_agent_unavailable" } }).onConflictDoNothing().returning();
          const action = inserted ?? (await tx.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, approval.companyId), eq(issueRecoveryActions.sourceIssueId, linkedIssues[0].id),
            inArray(issueRecoveryActions.status, ["active", "escalated"]))).limit(1))[0];
          recoveryActionId = action?.id ?? null;
          if (action) blocker = `recovery_action:${action.id}`;
        }
        const details = { revisionKey, revisionDecidedAt: decidedAt.toISOString(), outcome: approval.status === "revision_requested" && blocker ? "durable_blocker" : decision.outcome,
          blocker, recoveryActionId, requestedByAgentId: requester, ownerAgentId: target?.assigneeAgentId ?? null,
          ownerUserId: target?.assigneeUserId ?? null, linkedIssueIds: issueIds,
          attemptCount: attempts.length + (decision.action === "retry" ? 1 : 0), nextFollowUpAt: decision.nextFollowUpAt, nextAction,
          executionActive: activeExecution, operatorHold: operatorHeld,
          missingOwner: unsafe, missingFollowUp: !activeExecution && !operatorHeld && !decision.nextFollowUpAt
            && !blocker?.startsWith("recovery_action:") && ["unresolved", "durable_blocker"].includes(decision.outcome) };
        if (!isDeepStrictEqual(prior?.details, details)) await logActivity(tx as unknown as Db, {
          companyId: approval.companyId, actorType: "system", actorId: "revision-recovery",
          action: REVISION_OUTCOME_ACTIVITY, entityType: "approval", entityId: approval.id, details }, publications);
        if (approval.status !== "revision_requested" || decision.action !== "retry" || !target || !requester) return null;
        const attempt = attempts.length + 1;
        await tx.insert(activityLog).values({ companyId: approval.companyId, actorType: "system", actorId: "revision-recovery",
          action: REVISION_ATTEMPT_ACTIVITY, entityType: "approval", entityId: approval.id,
          details: { revisionKey, attempt, nextFollowUpAt: decision.nextFollowUpAt } });
        return { companyId: approval.companyId, approvalId: approval.id, requester, issueId: target.id,
          revisionKey, attempt, decidedAt: decidedAt.toISOString() };
      });
      for (const publication of publications) publishActivity(publication);
      if (!reservation) continue;
      const context = { approvalId: reservation.approvalId, approvalStatus: "revision_requested",
        revisionKey: reservation.revisionKey, revisionDecidedAt: reservation.decidedAt,
        issueId: reservation.issueId, taskId: reservation.issueId, issueIds: [reservation.issueId],
        revisionRecoveryAttempt: reservation.attempt, source: "approval.revision_outcome_recovery",
        wakeReason: "approval_revision_requested", instruction:
          "A successful run does not complete this revision. Resubmit the same approval, or record a durable named blocker. Do not create another approval or send to customers." };
      // Admission rechecks current ownership/status. A reserved attempt remains durable on failure,
      // including process death. Later sweeps back off, exhaust, and create board attention.
      try {
        await db.transaction(async tx => {
          const [current] = await tx.select().from(approvals).where(and(eq(approvals.companyId, reservation.companyId),
            eq(approvals.id, reservation.approvalId), eq(approvals.status, "revision_requested"),
            eq(approvals.decidedAt, new Date(reservation.decidedAt)))).for("share");
          const [company] = await tx.select().from(companies).where(and(eq(companies.id, reservation.companyId),
            eq(companies.status, "active")));
          if (!current || !company || current.requestedByAgentId !== reservation.requester) return;
          await enqueueWakeup(reservation.requester, { source: "automation", triggerDetail: "system",
          reason: "approval_revision_requested", requestedByActorType: "system", requestedByActorId: null,
          idempotencyKey: `approval-revision-recovery:${reservation.revisionKey}:${reservation.attempt}`,
          issueStateGuard: { statuses: ["todo", "in_progress", "blocked"], assigneeAgentId: reservation.requester },
          payload: context, contextSnapshot: context });
        });
      } catch {
        // Deliberately retain the reservation. Do not spin or erase the bounded failure evidence.
      }
      } catch (error) {
        // One corrupt/unavailable card must not prevent the remaining sweep or generic recovery.
        logger.warn({ approvalId: candidate.id, companyId: candidate.companyId,
          errorType: error instanceof Error ? error.name : "unknown" }, "revision outcome reconciliation failed; retained for next sweep");
      }
    }
    return handledIssueIds;
  }
  return { reconcile };
}
