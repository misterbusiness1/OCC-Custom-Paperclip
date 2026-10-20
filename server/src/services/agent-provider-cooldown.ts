import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
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

/** MUST be called on a transaction that also reads admission and commits the
 * claim/stamp. Outside a transaction PostgreSQL releases this lock immediately.
 * Serializes decisions, never a healthy provider turn. */
export async function lockProviderAccountAdmission(db: Pick<Db, "execute">, companyId: string, providerAccountKey: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`provider-account:${companyId}:${providerAccountKey}`}, 0))`);
}

export async function providerAccountRecoveryAdmission(
  db: Pick<Db, "select">,
  companyId: string,
  providerAccountKey: string,
  runId: string,
  now = new Date(),
  options?: { afterSourceRead?: () => Promise<void> },
): Promise<{ allowed: boolean; recoveryOf: string | null; retryAt: Date | null }> {
  const scope = and(eq(heartbeatRuns.companyId, companyId),
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'providerAccountKey' = ${providerAccountKey}`);
  const [source] = await db.select({ id: heartbeatRuns.id, finishedAt: heartbeatRuns.finishedAt,
    retryAt: sql<string | null>`${heartbeatRuns.resultJson}->>'retryNotBefore'`,
  }).from(heartbeatRuns).where(and(scope, eq(heartbeatRuns.status, "failed"),
    sql`${heartbeatRuns.resultJson}->>'errorFamily' = 'transient_upstream'`,
    sql`${heartbeatRuns.resultJson}->'providerHttpStatus' = '429'::jsonb`,
    isNotNull(heartbeatRuns.finishedAt),
  )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(1);
  if (!source?.finishedAt) return { allowed: true, recoveryOf: null, retryAt: null };
  await options?.afterSourceRead?.();
  // Only a causal post-wait ordinary probe can clear this failure. An older
  // in-flight success, or a reset-only turn, carries no recovery evidence.
  const [recovered] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(scope,
    eq(heartbeatRuns.status, "succeeded"),
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'providerAccountRecoveryOf' = ${source.id}`,
    gte(heartbeatRuns.startedAt, source.finishedAt),
    sql`${heartbeatRuns.resultJson}->>'conversationReset' is distinct from 'true'`,
  )).limit(1);
  if (recovered) return { allowed: true, recoveryOf: null, retryAt: null };
  const retryAt = source.retryAt ? new Date(source.retryAt) : null;
  // Legacy structured evidence without a persisted timing contract cannot
  // invent a reset. Its own bounded retry remains the recovery authority.
  const [retry] = retryAt && Number.isFinite(retryAt.getTime()) ? [] : await db.select({ at: heartbeatRuns.scheduledRetryAt })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, source.id), isNotNull(heartbeatRuns.scheduledRetryAt)))
    .orderBy(heartbeatRuns.scheduledRetryAt).limit(1);
  const dueAt = retryAt && Number.isFinite(retryAt.getTime()) ? retryAt : retry?.at ?? null;
  if (!dueAt) return { allowed: true, recoveryOf: null, retryAt: null };
  if (dueAt > now) return { allowed: false, recoveryOf: source.id, retryAt: dueAt };
  const [probe] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(scope,
    eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.id} <> ${runId}`,
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'providerAccountRecoveryOf' is not null`,
  )).limit(1);
  return { allowed: !probe, recoveryOf: source.id, retryAt: dueAt };
}
