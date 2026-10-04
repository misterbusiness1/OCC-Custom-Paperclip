import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { authorizationService, type AuthorizationActor } from "./authorization.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Resolve current grants; accepted provenance never supplies cached membership/admin flags. */
export async function authorizeBoardCommentRequest(tx: Transaction, identity: {
  companyId: string; issueId: string; authorUserId: string;
  actorSource?: string;
  canonicalEnvelope?: Record<string, unknown>;
}) {
  const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, identity.companyId), eq(issues.id, identity.issueId)));
  if (!issue || issue.conversationAgentId) return false;
  const authorization = identity.canonicalEnvelope?.authorization;
  const recordedSource = authorization && typeof authorization === "object" && "source" in authorization
    ? authorization.source : identity.actorSource;
  const sources = ["local_implicit", "session", "board_key", "cloud_tenant", "cloud_control"] as const;
  if (!sources.some((source) => source === recordedSource)) return false;
  const actor: AuthorizationActor = { type: "board", userId: identity.authorUserId,
    source: recordedSource as AuthorizationActor["source"] };
  const decision = await authorizationService(tx as unknown as Db).decide({ actor, action: "issue:comment",
    resource: { type: "issue", companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId,
      parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status },
    scope: { issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId },
  });
  return decision.allowed;
}
