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

export type ProviderAdmissionScope =
  | { kind: "account"; providerAccountKey: string }
  | { kind: "provider_route"; agentId: string; providerCooldownKey: string };

export function providerAdmissionScope(agentId: string, providerCooldownKey: string | null,
  providerAccountKey: string | null): ProviderAdmissionScope | null {
  if (providerAccountKey) return { kind: "account", providerAccountKey };
  return providerCooldownKey ? { kind: "provider_route", agentId, providerCooldownKey } : null;
}

/** Preserve account receipts while making an ungrouped route's provenance explicit. */
export function providerAdmissionMetadata(scope: ProviderAdmissionScope | null, recoveryOf: string | null) {
  return {
    providerAdmissionScopeKind: scope?.kind ?? null,
    providerAccountKey: scope?.kind === "account" ? scope.providerAccountKey : null,
    providerAccountRecoveryOf: scope?.kind === "account" ? recoveryOf : null,
    providerAgentRecoveryOf: scope?.kind === "provider_route" ? recoveryOf : null,
  };
}

function admissionScopePredicate(companyId: string, scope: ProviderAdmissionScope) {
  return and(eq(heartbeatRuns.companyId, companyId), scope.kind === "account"
    ? sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'providerAccountKey' = ${scope.providerAccountKey}`
    : and(sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'providerCooldownKey' = ${scope.providerCooldownKey}`,
      // Only an explicitly sampled null identity establishes an ungrouped scope.
      // Historical runs without that preparation receipt remain unassociated.
      sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->'providerAccountKey' = 'null'::jsonb`));
}

/** MUST be called on a transaction that also reads admission and commits the
 * claim/stamp. Outside a transaction PostgreSQL releases this lock immediately.
 * Serializes decisions, never a healthy provider turn. */
export async function lockProviderAdmission(db: Pick<Db, "execute">, companyId: string, scope: ProviderAdmissionScope) {
  const lockKey = scope.kind === "account"
    ? `provider-account:${companyId}:${scope.providerAccountKey}`
    : `provider-route:${companyId}:${scope.providerCooldownKey}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

export async function providerRecoveryAdmission(
  db: Pick<Db, "select">,
  companyId: string,
  scope: ProviderAdmissionScope,
  runId: string,
  now = new Date(),
  options?: { afterSourceRead?: () => Promise<void> },
): Promise<{ allowed: boolean; recoveryOf: string | null; retryAt: Date | null }> {
  const predicate = admissionScopePredicate(companyId, scope);
  const recoveryField = scope.kind === "account" ? "providerAccountRecoveryOf" : "providerAgentRecoveryOf";
  const failures = await db.select({ id: heartbeatRuns.id, finishedAt: heartbeatRuns.finishedAt,
    retryAt: sql<string | null>`${heartbeatRuns.resultJson}->>'retryNotBefore'`,
    // Nested SQL keeps correlated outer columns qualified in Drizzle projections.
    childRetryAt: sql<Date | null>`(select min(child.scheduled_retry_at) from heartbeat_runs child
      where child.company_id = ${sql`${heartbeatRuns.companyId}`} and child.retry_of_run_id = ${sql`${heartbeatRuns.id}`})`,
  }).from(heartbeatRuns).where(and(predicate, eq(heartbeatRuns.status, "failed"),
    sql`${heartbeatRuns.resultJson}->>'errorFamily' = 'transient_upstream'`,
    sql`${heartbeatRuns.resultJson}->'providerHttpStatus' = '429'::jsonb`,
    isNotNull(heartbeatRuns.finishedAt),
  ));
  const finiteDate = (value: string | Date | null) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  // A later-finishing or delayed writer must not shorten an outstanding wait.
  // Rank safely parsed receipts, not raw JSON timestamp casts or commit order.
  // Old structured failures may use their actual typed retry-child deadline.
  const sources = failures.flatMap(failure => {
    const dueAt = finiteDate(failure.retryAt) ?? finiteDate(failure.childRetryAt);
    return dueAt && failure.finishedAt ? [{ ...failure, finishedAt: failure.finishedAt, dueAt }] : [];
  }).sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime()
    || b.finishedAt.getTime() - a.finishedAt.getTime() || b.id.localeCompare(a.id));
  const source = sources[0];
  if (!source) return { allowed: true, recoveryOf: null, retryAt: null };
  await options?.afterSourceRead?.();
  const dueAt = source.dueAt;
  // Only an ordinary probe of this exact strongest receipt, started after its
  // wait, can clear it. An older in-flight or reset-only success is not proof.
  const [recovered] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(predicate,
    eq(heartbeatRuns.status, "succeeded"),
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>${recoveryField} = ${source.id}`,
    gte(heartbeatRuns.startedAt, source.finishedAt), gte(heartbeatRuns.startedAt, dueAt),
    sql`${heartbeatRuns.resultJson}->>'conversationReset' is distinct from 'true'`,
  )).limit(1);
  if (recovered) return { allowed: true, recoveryOf: null, retryAt: null };
  if (dueAt > now) return { allowed: false, recoveryOf: source.id, retryAt: dueAt };
  const [probe] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(predicate,
    eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.id} <> ${runId}`,
    sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>${recoveryField} is not null`,
  )).limit(1);
  return { allowed: !probe, recoveryOf: source.id, retryAt: dueAt };
}
