import { and, eq, sql } from "drizzle-orm";
import { approvals, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { APPROVAL_DECISION_WAKE_REASONS } from "./approval-decision-wake.js";

/**
 * Serialize post-commit delivery against approval changes/revocation. Acquire
 * approval SHARE before the callback takes wake/run locks, matching revocation's
 * approval -> wake -> run order. The existing dedicated-connection seam keeps a
 * waiting approval lock from consuming the normal pool used by wake admission.
 * The callback must not update this approval or attempt to upgrade its lock.
 */
export async function deliverCurrentApprovalDecision<T>(db: Db, decision: {
  id: string; companyId: string; status: string; updatedAt: Date;
}, deliver: () => Promise<T>): Promise<T | undefined> {
  if (!APPROVAL_DECISION_WAKE_REASONS.has(`approval_${decision.status}`)
      || !Number.isFinite(decision.updatedAt?.getTime())) return undefined;
  return withDedicatedDbConnection(db, (dedicated) => dedicated.transaction(async (tx) => {
    const [current] = await tx.select({ id: approvals.id }).from(approvals).where(and(
      eq(approvals.id, decision.id), eq(approvals.companyId, decision.companyId),
      eq(approvals.status, decision.status),
      sql`date_trunc('milliseconds', ${approvals.updatedAt}) = ${decision.updatedAt.toISOString()}::timestamptz`,
    )).for("share");
    return current ? deliver() : undefined;
  }));
}
