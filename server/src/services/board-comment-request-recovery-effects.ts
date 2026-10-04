import { taskWatchdogService, type TaskWatchdogServiceDeps } from "./task-watchdogs.js";
import type { BoardCommentWatchdogTarget } from "./board-comment-watchdog-claim.js";
import { and, eq } from "drizzle-orm";
import { issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { issueService } from "./issues.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { persistActivity } from "./activity-log.js";
import type { CommentEffectHandler } from "./issue-comment-requests.js";

type SourceIssue = typeof issues.$inferSelect;
export interface BoardCommentRecoveryDescriptor {
  version: 1;
  targetRecoveryActionId: string;
  statusChanged: boolean;
  resumeRequested: boolean;
  reopened: boolean;
  blockedToTodoRecovery: boolean;
}
function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type SourceRecoveryRevalidationTrigger =
  "issue_update" | "comment" | "document" | "work_product" | "read_projection";

/** Shared source-recovery classification; comment flags are immutable accepted intent. */
export async function classifyBoardCommentSourceRecovery(db: Db, input: {
  issue: SourceIssue; trigger: SourceRecoveryRevalidationTrigger;
  statusChanged?: boolean; assigneeChanged?: boolean; blockersChanged?: boolean;
  executionPolicyChanged?: boolean; monitorChanged?: boolean; documentChanged?: boolean;
  workProductChanged?: boolean; resumeRequested?: boolean; reopened?: boolean; blockedToTodoRecovery?: boolean;
}): Promise<string | null> {
  const svc = issueService(db);
  const issueThreadInteractionsSvc = issueThreadInteractionService(db);
  const issueApprovalsSvc = issueApprovalService(db);
    const { issue } = input;
    if (issue.status === "done" || issue.status === "cancelled") {
      return `Recovery action became stale because the source issue reached ${issue.status}.`;
    }
    if (input.blockedToTodoRecovery === true) {
      return "Recovery action became stale because the source issue was manually moved from blocked to todo.";
    }

    if (input.trigger === "read_projection") return null;
    if (
      input.trigger === "comment" &&
      input.resumeRequested !== true &&
      input.reopened !== true &&
      input.statusChanged !== true
    ) {
      return null;
    }

    const durableSourceChange =
      input.statusChanged === true ||
      input.assigneeChanged === true ||
      input.blockersChanged === true ||
      input.executionPolicyChanged === true ||
      input.monitorChanged === true ||
      input.documentChanged === true ||
      input.workProductChanged === true ||
      input.resumeRequested === true ||
      input.reopened === true;
    if (!durableSourceChange) return null;

    if (issue.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id);
      if (readiness.unresolvedBlockerCount > 0) {
        return "Recovery action became stale because the source issue now has unresolved first-class blockers.";
      }
      return null;
    }

    if (
      issue.assigneeUserId &&
      issue.status !== "done" &&
      issue.status !== "cancelled"
    ) {
      return "Recovery action became stale because the source issue now has a human owner.";
    }

    if (
      (issue.status === "todo" || issue.status === "in_progress") &&
      issue.assigneeAgentId
    ) {
      return `Recovery action became stale because the source issue is ${issue.status} with an agent owner.`;
    }

    if (issue.status === "in_review") {
      const executionState = parseIssueExecutionState(issue.executionState);
      const participant =
        executionState?.status === "pending"
          ? executionState.currentParticipant
          : null;
      if (
        (participant?.type === "agent" &&
          readNonEmptyString(participant.agentId)) ||
        (participant?.type === "user" && readNonEmptyString(participant.userId))
      ) {
        return "Recovery action became stale because the source issue now has a typed review participant.";
      }

      const interactions = await issueThreadInteractionsSvc.listForIssue(
        issue.id,
      );
      if (
        interactions.some((interaction) => interaction.status === "pending")
      ) {
        return "Recovery action became stale because the source issue now has a pending issue interaction.";
      }

      const approvals = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
      if (
        approvals.some(
          (approval) =>
            approval.status === "pending" ||
            approval.status === "revision_requested",
        )
      ) {
        return "Recovery action became stale because the source issue now has a pending approval.";
      }
    }

    const monitor = { nextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor?.nextCheckAt ?? null };
    if (monitor.nextCheckAt && Date.parse(monitor.nextCheckAt) > Date.now()) {
      return "Recovery action became stale because the source issue now has a scheduled monitor.";
    }

    return null;
}

export function createBoardCommentSourceRecoveryHandler(): CommentEffectHandler {
  return { transaction: async (tx, request, effect) => {
    const d = effect.descriptor;
    const flags = ["statusChanged", "resumeRequested", "reopened", "blockedToTodoRecovery"] as const;
    if (effect.kind !== "source_recovery_revalidation" || effect.companyId !== request.companyId || effect.requestId !== request.id
      || d.version !== 1 || typeof d.targetRecoveryActionId !== "string" || flags.some(flag => typeof d[flag] !== "boolean")
      || Object.keys(d).some(key => !["version", "targetRecoveryActionId", ...flags].includes(key))) {
      throw conflict("Invalid source recovery identity");
    }
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, request.companyId), eq(issues.id, request.issueId))).for("update");
    const [target] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, d.targetRecoveryActionId),
      eq(issueRecoveryActions.companyId, request.companyId), eq(issueRecoveryActions.sourceIssueId, request.issueId))).for("update");
    if (!issue || !target) throw conflict("Accepted source recovery target is unavailable");
    const base = { version: 1, kind: effect.kind, requestId: request.id, effectId: effect.id,
      targetRecoveryActionId: target.id, generation: effect.generation };
    if (!["active", "escalated"].includes(target.status)) return { ...base, resolved: false, targetAlreadySettled: true };
    const resolutionNote = await classifyBoardCommentSourceRecovery(tx as unknown as Db, {
      issue, trigger: "comment", statusChanged: d.statusChanged as boolean, resumeRequested: d.resumeRequested as boolean,
      reopened: d.reopened as boolean, blockedToTodoRecovery: d.blockedToTodoRecovery as boolean,
    });
    if (!resolutionNote) return { ...base, resolved: false, targetAlreadySettled: false };
    const resolved = await issueRecoveryActionService(tx as unknown as Db).resolveActiveForIssue({
      companyId: request.companyId, sourceIssueId: request.issueId, actionId: target.id,
      status: "cancelled", outcome: "cancelled", resolutionNote,
    }, tx);
    if (!resolved) throw conflict("Source recovery target changed during resolution");
    const { activity } = await persistActivity(tx as unknown as Db, {
      companyId: request.companyId, actorType: "user", actorId: request.authorUserId,
      responsibleUserIdOverride: request.responsibleUserId, action: "issue.recovery_action_resolved",
      entityType: "issue", entityId: request.issueId, details: {
        identifier: issue.identifier, recoveryActionId: resolved.id, recoveryActionStatus: resolved.status,
        outcome: resolved.outcome, sourceIssueStatus: issue.status, resolutionNote: resolved.resolutionNote,
        source: "source_revalidation", trigger: "comment", commentRequestId: request.id, commentId: request.commentId,
      },
    });
    return { ...base, resolved: true, activityId: activity.id };
  } };
}

/** No replay after an uncertain watchdog attempt; completion is an observed local outcome. */
export function createBoardCommentWatchdogHandler(db: Db, deps: TaskWatchdogServiceDeps): CommentEffectHandler {
  return {
    execute: async (request, effect) => {
      const d = effect.descriptor;
      if (effect.kind !== "watchdog" || effect.requestId !== request.id || effect.companyId !== request.companyId
        || d.version !== 1 || !Array.isArray(d.targets) || Object.keys(d).some(key => !["version", "targets"].includes(key))) {
        throw conflict("Invalid accepted watchdog effect");
      }
      const targets = d.targets as BoardCommentWatchdogTarget[];
      if (targets.some(target => !target || typeof target.watchdogId !== "string" || typeof target.watchedIssueId !== "string"
        || !/^[a-f0-9]{64}$/.test(target.configurationSha256)
        || Object.keys(target).some(key => !["watchdogId", "watchedIssueId", "configurationSha256"].includes(key)))
        || new Set(targets.map(target => target.watchdogId)).size !== targets.length) throw conflict("Invalid watchdog target set");
      const service = taskWatchdogService(db, { ...deps, boardCommentClaim: {
        requestId: request.id, effectId: effect.id, generation: effect.generation,
      } });
      const outcomes = await service.reconcileAcceptedBoardCommentTargets(request.companyId, targets);
      return { version: 1, kind: "watchdog", requestId: request.id, effectId: effect.id,
        generation: effect.generation, dispatchObserved: true, downstreamDeliveryConfirmed: false, outcomes };
    },
    reconcile: async () => null,
  };
}
