import { lockBoardCommentEffectClaim } from "./board-comment-effect-claim.js";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companies, agents, heartbeatRuns, issueComments, issueCommentRequests, issueCommentRequestEffects, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { authorizeBoardCommentRequest } from "./board-comment-request-authority.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { runnerGoalService } from "./runner-goals.js";
import { captureLiveRunnerPrpSteerTarget, queueLiveRunnerPrpCommand, readCapturedRunnerPrpSteerOutcome,
  type CapturedRunnerPrpSteerTarget } from "../realtime/runner-prp-ws.js";
import type { CommentEffectHandler } from "./issue-comment-requests.js";

export interface BoardCommentSteerDescriptor { version: 1; agentId: string; target: CapturedRunnerPrpSteerTarget }
export async function captureBoardCommentSteerDescriptor(db: Db, input: { companyId: string; issueId: string; agentId: string }): Promise<BoardCommentSteerDescriptor | null> {
  const goal = await runnerGoalService(db).projection(input.companyId, input.issueId, input.agentId);
  if (goal?.goal?.status !== "active" || !goal.workingNow) return null;
  const target = captureLiveRunnerPrpSteerTarget(input);
  return target && goal.activeRunId === target.runId ? { version: 1, agentId: input.agentId, target } : null;
}

function descriptor(value: Record<string, unknown>): BoardCommentSteerDescriptor {
  const target = value.target as Record<string, unknown> | null;
  const keys = ["runId", "controllerInstanceId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId", "providerTurnId", "providerSessionId"];
  if (value.version !== 1 || typeof value.agentId !== "string" || !target || typeof target !== "object"
    || Object.keys(value).some(key => !["version", "agentId", "target"].includes(key))
    || Object.keys(target).length !== keys.length || keys.some(key => typeof target[key] !== "string" || !target[key])) {
    throw conflict("Invalid accepted steering target");
  }
  return value as unknown as BoardCommentSteerDescriptor;
}
function resultReceipt(result: Record<string, unknown> | null, commandId: string, target: CapturedRunnerPrpSteerTarget) {
  const value = result?.result && typeof result.result === "object" ? result.result as Record<string, unknown> : result;
  if (value?.status === "steered") return { version: 1, steered: true, commandId, targetRunId: target.runId,
    providerTurnId: target.providerTurnId, durableCommandOutcome: true };
  if (value?.status === "rejected" && ["stale_provider_turn", "stale_provider_session", "provider_command_unavailable"].includes(String(value.code))) {
    return { version: 1, steered: false, commandId, targetRunId: target.runId, providerTurnId: target.providerTurnId,
      durableCommandOutcome: true, providerRejectedBeforeSteer: true };
  }
  return null;
}

export function createBoardCommentSteerHandler(db: Db): CommentEffectHandler {
  return {
    execute: async (request, effect) => {
      const d = descriptor(effect.descriptor);
      if (effect.kind !== "steer" || effect.requestId !== request.id || effect.companyId !== request.companyId) throw conflict("Invalid steering owner");
      const commandId = `board_comment_steer_${effect.id}`;
      const body = await db.transaction(async tx => {
        await lockBoardCommentEffectClaim(tx, { companyId: request.companyId, requestId: request.id, effectId: effect.id, generation: effect.generation, kind: "steer" });
        const [owner] = await tx.select().from(issueCommentRequests).where(eq(issueCommentRequests.id, request.id)).for("update");
        const [current] = await tx.select().from(issueCommentRequestEffects).where(and(eq(issueCommentRequestEffects.id, effect.id),
          eq(issueCommentRequestEffects.requestId, request.id), eq(issueCommentRequestEffects.companyId, request.companyId))).for("update");
        if (!owner || owner.contentInvalidatedAt || !current || current.generation !== effect.generation || current.status !== "dispatching") {
          throw conflict("Steering claim is no longer current");
        }
        const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, request.commentId),
          eq(issueComments.companyId, request.companyId), eq(issueComments.issueId, request.issueId))).for("update");
        const [issue] = await tx.select().from(issues).where(and(eq(issues.id, request.issueId), eq(issues.companyId, request.companyId)));
        const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, d.target.runId),
          eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.agentId, d.agentId)));
        if (!comment || comment.deletedAt || comment.updatedAt.getTime() !== request.acceptedCommentUpdatedAt.getTime()
          || comment.authorUserId !== request.authorUserId || comment.createdByRunId !== null
          || !issue || issue.assigneeAgentId !== d.agentId || !run || run.nativeIssueId !== request.issueId
          || !["queued", "running"].includes(run.status) || !(await authorizeBoardCommentRequest(tx, owner))) {
          throw conflict("Accepted steering target is no longer authorized");
        }
        const [company] = await tx.select().from(companies).where(eq(companies.id, request.companyId));
        const [agent] = await tx.select().from(agents).where(and(eq(agents.id, d.agentId), eq(agents.companyId, request.companyId)));
        const goal = await runnerGoalService(tx as unknown as Db).projection(request.companyId, request.issueId, d.agentId);
        if (company?.status !== "active" || !(await evaluateAgentInvokabilityFromDb(tx as unknown as Db, agent)).invokable
          || goal?.goal?.status !== "active" || !goal.workingNow || goal.activeRunId !== d.target.runId) {
          throw conflict("Accepted steering work is no longer active");
        }
        // Durable immutable command intent precedes provider delivery. A crash at
        // this boundary is receipt-only recovery, never a new command/target.
        await tx.update(issueCommentRequestEffects).set({ receipt: { version: 1, kind: "steer_intent",
          requestId: request.id, effectId: effect.id, commandId, target: d.target,
          textSha256: createHash("sha256").update(comment.body).digest("hex") } }).where(eq(issueCommentRequestEffects.id, effect.id));
        return comment.body;
      });
      const queued = queueLiveRunnerPrpCommand({ companyId: request.companyId, issueId: request.issueId, agentId: d.agentId,
        type: "turn.steer", payload: { text: body, expectedProviderTurnId: d.target.providerTurnId,
          expectedProviderSessionId: d.target.providerSessionId }, commandId, expectedSteerTarget: d.target });
      if (!queued) return { version: 1, steered: false, commandId, targetRunId: d.target.runId, notQueued: true };
      const receipt = resultReceipt(await queued.completion, commandId, d.target);
      if (!receipt) throw conflict("Steering outcome requires reconciliation");
      return receipt;
    },
    reconcile: async (request, effect) => {
      const d = descriptor(effect.descriptor);
      const commandId = `board_comment_steer_${effect.id}`;
      const intent = effect.receipt;
      if (intent?.kind !== "steer_intent" || intent.requestId !== request.id || intent.effectId !== effect.id
        || intent.commandId !== commandId || typeof intent.textSha256 !== "string") return null;
      const outcome = readCapturedRunnerPrpSteerOutcome({ companyId: request.companyId, issueId: request.issueId,
        agentId: d.agentId, target: d.target, commandId, expectedTextSha256: intent.textSha256 });
      return outcome?.status === "completed" ? resultReceipt(outcome.result, commandId, d.target) : null;
    },
  };
}
