import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

type AttentionRunScope = { agentId: string; issueId: string | null; after: Date };
type LatestAttentionRun = { agentId: string; issueId: string | null; createdAt: Date };
const LOOKUP_BATCH_SIZE = 200;

/** Find only the newer runs that can supersede the supplied failed-run alerts.
 * Keeping the issueId and legacy taskId probes separate uses their existing
 * indexes without detoasting every recent run context for the affected agents.
 */
export async function listLatestAttentionRunTimes(
  db: Db,
  companyId: string,
  requestedScopes: readonly AttentionRunScope[],
): Promise<LatestAttentionRun[]> {
  const distinct = new Map<string, AttentionRunScope>();
  for (const scope of requestedScopes) {
    const key = JSON.stringify([scope.agentId, scope.issueId]);
    const previous = distinct.get(key);
    if (!previous || scope.after < previous.after) distinct.set(key, scope);
  }
  const results: LatestAttentionRun[] = [];
  for (const hasIssue of [true, false]) {
    const scopes = [...distinct.values()].filter(scope => (scope.issueId !== null) === hasIssue);
    for (let offset = 0; offset < scopes.length; offset += LOOKUP_BATCH_SIZE) {
      const batch = scopes.slice(offset, offset + LOOKUP_BATCH_SIZE);
      const values = sql.join(batch.map(scope => sql`(
        ${scope.agentId}::uuid, ${scope.issueId}::text, ${scope.after.toISOString()}::timestamptz
      )`), sql`, `);
      const query = hasIssue
        ? sql`select scope.agent_id as "agentId", scope.issue_id as "issueId",
            greatest(primary_run.created_at, fallback_run.created_at) as "createdAt"
          from (values ${values}) as scope(agent_id, issue_id, after_at)
          left join lateral (
            select run.created_at from heartbeat_runs run
            where run.company_id = ${companyId}::uuid and run.agent_id = scope.agent_id
              and run.context_snapshot->>'issueId' = scope.issue_id
              and run.created_at > scope.after_at
            order by run.created_at desc limit 1
          ) primary_run on true
          left join lateral (
            select run.created_at from heartbeat_runs run
            where run.company_id = ${companyId}::uuid and run.agent_id = scope.agent_id
              and run.context_snapshot->>'taskId' = scope.issue_id
              and run.created_at > greatest(scope.after_at, primary_run.created_at)
              and run.context_snapshot->>'issueId' is null
            order by run.created_at desc limit 1
          ) fallback_run on true
          where primary_run.created_at is not null or fallback_run.created_at is not null`
        : sql`select scope.agent_id as "agentId", scope.issue_id as "issueId", latest.created_at as "createdAt"
          from (values ${values}) as scope(agent_id, issue_id, after_at)
          join lateral (
            select run.created_at from heartbeat_runs run
            where run.company_id = ${companyId}::uuid and run.agent_id = scope.agent_id
              and run.created_at > scope.after_at
              and nullif(coalesce(run.context_snapshot->>'issueId', run.context_snapshot->>'taskId'), '') is null
            order by run.created_at desc limit 1
          ) latest on true`;
      const rows = await db.execute<{ agentId: string; issueId: string | null; createdAt: string | Date }>(query);
      results.push(...rows.map(row => ({
        ...row,
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      })));
    }
  }
  return results;
}
