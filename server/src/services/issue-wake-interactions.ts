import { and, eq, inArray } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";

/**
 * A pending response with its own continuation is already a live wake path.
 * Dependency and self-unblock notifications must not restart its assignee.
 * A different unblock owner can still receive the notification and do work.
 */
export async function findPendingAssigneeWakeInteraction(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; agentId: string },
) {
  return db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issues.assigneeAgentId, input.agentId),
      eq(issueThreadInteractions.status, "pending"),
      inArray(issueThreadInteractions.continuationPolicy, [
        "wake_assignee", "wake_assignee_on_accept",
      ]),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
