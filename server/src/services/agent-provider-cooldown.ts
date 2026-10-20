import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { classifyAdapterFailureForRecovery } from "./recovery/service.js";

/** Keep an agent's other queued work behind its latest provider cooldown.
 * Read persisted outcomes so restarts retain the wait. A newer successful turn
 * clears it. Anchor fallback delays to completion, never to each scheduler tick.
 * This deliberately stays agent/company scoped: adapter type alone does not
 * establish that two agents share the same provider account.
 */
export async function agentProviderCooldownUntil(
  db: Db,
  companyId: string,
  agentId: string,
  providerKey: string,
  now = new Date(),
  probeAt?: Date | null,
): Promise<Date | null> {
  const [latest] = await db.select({
    status: heartbeatRuns.status,
    finishedAt: heartbeatRuns.finishedAt,
    errorCode: heartbeatRuns.errorCode,
    error: sql<string | null>`left(${heartbeatRuns.error}, 8192)`,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object(
      'errorFamily', ${heartbeatRuns.resultJson}->'errorFamily',
      'retryNotBefore', ${heartbeatRuns.resultJson}->'retryNotBefore',
      'transientRetryNotBefore', ${heartbeatRuns.resultJson}->'transientRetryNotBefore',
      'providerQuotaRetryNotBefore', ${heartbeatRuns.resultJson}->'providerQuotaRetryNotBefore',
      'providerQuotaResetSource', ${heartbeatRuns.resultJson}->'providerQuotaResetSource'
    )`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.agentId, agentId),
    // A success on another provider must not clear this provider's wait; nor
    // may an old provider's quota prevent an explicitly changed configuration.
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'providerCooldownKey' = ${providerKey}`,
    inArray(heartbeatRuns.status, ["failed", "succeeded"]),
    sql`((${heartbeatRuns.status} = 'succeeded' and ${heartbeatRuns.resultJson}->>'conversationReset' is distinct from 'true') or ${heartbeatRuns.errorCode} = 'provider_quota' or ${heartbeatRuns.resultJson}->>'errorFamily' = 'provider_quota')`,
    isNotNull(heartbeatRuns.finishedAt),
  )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(1);
  if (!latest || latest.status !== "failed" || !latest.finishedAt) return null;
  if (probeAt && probeAt > latest.finishedAt) return null;
  const recovery = classifyAdapterFailureForRecovery(latest, latest.finishedAt);
  return recovery?.kind === "provider_quota" && recovery.retryAt > now
    ? recovery.retryAt
    : null;
}
