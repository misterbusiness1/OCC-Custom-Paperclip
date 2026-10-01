import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
  AGENT_ACTIVE_ASSIGNMENT_STATUSES,
  AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
  AGENT_CAPACITY_ESCALATION_ORIGIN_KIND,
  AGENT_CAPACITY_OVERRIDE_MIN_REASON_LENGTH,
  AGENT_CAPACITY_OVERRIDE_PRIORITY,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

export const AGENT_CAPACITY_ACTIVITY_ACTIONS = {
  blocked: "agent.capacity_assignment_blocked",
  observed: "agent.capacity_assignment_observed",
  overridden: "agent.capacity_override_granted",
  escalated: "agent.capacity_escalation_opened",
  escalationUnroutable: "agent.capacity_escalation_unroutable",
  episodeReset: "agent.capacity_episode_reset",
} as const;

export const AGENT_CAPACITY_CONFLICT_CODE = "agent_at_active_capacity";

/**
 * `enforce` rejects over-cap assignments. `observe` records the same activity
 * evidence but lets the assignment through, so the guardrail is never silently
 * disabled — turning the flag off degrades it to reporting, not to nothing.
 */
export type AgentCapacityMode = "enforce" | "observe";

export type AgentCapacityOutcome = "allowed" | "blocked" | "observed" | "overridden";

export interface AgentCapacityOverride {
  reason: string;
}

export interface AgentCapacityDecision {
  companyId: string;
  agentId: string;
  issueId: string | null;
  /** Active assignments already held by the agent, excluding the issue under mutation. */
  activeCount: number;
  /** `activeCount` + 1, i.e. what the agent would hold if this assignment lands. */
  projectedCount: number;
  cap: number;
  warnThreshold: number;
  mode: AgentCapacityMode;
  outcome: AgentCapacityOutcome;
  /** True once the projected count reaches the warn threshold. */
  warning: boolean;
}

export interface AgentCapacityAssignmentInput {
  companyId: string;
  /** The agent that would end up owning the issue. */
  agentId: string;
  /** Null for a not-yet-inserted issue. */
  issueId: string | null;
  /** Resulting priority of the issue; only `critical` may carry an override. */
  priority: string | null | undefined;
  override?: AgentCapacityOverride | null;
  /** Free-form label for audit evidence, e.g. `issue.create`. */
  mutation: string;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  runId?: string | null;
}

function activeStatusList(): string[] {
  return [...AGENT_ACTIVE_ASSIGNMENT_STATUSES];
}

/**
 * Counts the target agent's active assignments.
 *
 * Served by the existing `issues_company_assignee_status_idx` composite index on
 * `(company_id, assignee_agent_id, status)`, so no extra index is required.
 */
export async function countActiveAssignments(
  dbOrTx: Db,
  companyId: string,
  agentId: string,
  options: { excludeIssueId?: string | null } = {},
): Promise<number> {
  const conditions = [
    eq(issues.companyId, companyId),
    eq(issues.assigneeAgentId, agentId),
    inArray(issues.status, activeStatusList()),
  ];
  if (options.excludeIssueId) {
    conditions.push(ne(issues.id, options.excludeIssueId));
  }
  const [row] = await dbOrTx
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(...conditions));
  return Number(row?.count ?? 0);
}

/**
 * Serializes capacity decisions for one agent within the caller's transaction.
 *
 * The count-then-write sequence is only atomic if concurrent assignments to the
 * same agent are serialized; a plain count would let N racing requests each read
 * 49 and each write. The lock is keyed on `(companyId, agentId)` so unrelated
 * assignments never contend, and it is released when the caller's transaction
 * ends. MUST be called on the same transaction handle that performs the write.
 */
export async function lockAgentCapacitySlot(tx: Db, companyId: string, agentId: string): Promise<void> {
  const key = `agent-capacity:${companyId}:${agentId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function resolveAgentCapacityMode(db: Db): Promise<AgentCapacityMode> {
  try {
    const experimental = await instanceSettingsService(db).getExperimental();
    return experimental.enableActiveAssignmentCapacityGuardrail ? "enforce" : "observe";
  } catch (err) {
    // Settings are unreadable: fall back to observe so a settings outage can
    // never wedge every assignment path in the instance.
    logger.warn({ err }, "failed to resolve agent capacity guardrail mode; defaulting to observe");
    return "observe";
  }
}

function isValidOverride(input: AgentCapacityAssignmentInput): boolean {
  const reason = input.override?.reason?.trim() ?? "";
  return (
    input.priority === AGENT_CAPACITY_OVERRIDE_PRIORITY &&
    reason.length >= AGENT_CAPACITY_OVERRIDE_MIN_REASON_LENGTH
  );
}

function auditDetails(decision: AgentCapacityDecision, input: AgentCapacityAssignmentInput) {
  return {
    code: AGENT_CAPACITY_CONFLICT_CODE,
    mutation: input.mutation,
    targetAgentId: decision.agentId,
    issueId: decision.issueId,
    activeCount: decision.activeCount,
    projectedCount: decision.projectedCount,
    cap: decision.cap,
    warnThreshold: decision.warnThreshold,
    mode: decision.mode,
    outcome: decision.outcome,
    activeStatuses: activeStatusList(),
    priority: input.priority ?? null,
    overrideReason: input.override?.reason?.trim() ?? null,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? null,
  };
}

async function validActivityRunId(db: Db, runId: string | null | undefined): Promise<string | null> {
  if (!runId) return null;
  const row = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
}

/**
 * Enforces the active-assignment cap for a mutation that newly attaches
 * `input.agentId` to an active issue.
 *
 * Callers must have already taken {@link lockAgentCapacitySlot} on `tx`, and
 * must perform the assignment write on that same `tx`.
 *
 * `rootDb` is a handle outside the caller's transaction. Block evidence is
 * written on it deliberately: this function throws on a block, which rolls the
 * caller's transaction back, and audit evidence for a rejected assignment must
 * survive that rollback. Override evidence is written on `tx` instead, so it
 * commits atomically with the assignment it authorizes.
 */
export async function assertAgentCapacityForAssignment(
  rootDb: Db,
  tx: Db,
  input: AgentCapacityAssignmentInput,
): Promise<AgentCapacityDecision> {
  const mode = await resolveAgentCapacityMode(rootDb);
  const activeCount = await countActiveAssignments(tx, input.companyId, input.agentId, {
    excludeIssueId: input.issueId,
  });
  const projectedCount = activeCount + 1;
  const decision: AgentCapacityDecision = {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    activeCount,
    projectedCount,
    cap: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
    warnThreshold: AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
    mode,
    outcome: "allowed",
    warning: projectedCount >= AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
  };
  const activityRunId = await validActivityRunId(rootDb, input.runId);

  if (projectedCount <= AGENT_ACTIVE_ASSIGNMENT_HARD_CAP) {
    return decision;
  }

  if (input.override) {
    if (!isValidOverride(input)) {
      throw unprocessable(
        `Capacity override requires priority "${AGENT_CAPACITY_OVERRIDE_PRIORITY}" and a reason of at least ` +
          `${AGENT_CAPACITY_OVERRIDE_MIN_REASON_LENGTH} characters`,
        { ...auditDetails(decision, input), code: "agent_capacity_override_invalid" },
      );
    }
    decision.outcome = "overridden";
    await logActivity(tx, {
      companyId: input.companyId,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "system",
      action: AGENT_CAPACITY_ACTIVITY_ACTIONS.overridden,
      entityType: "agent",
      entityId: input.agentId,
      agentId: input.agentId,
      runId: activityRunId,
      issueId: input.issueId,
      details: auditDetails(decision, input),
    });
    return decision;
  }

  decision.outcome = mode === "enforce" ? "blocked" : "observed";
  const action =
    mode === "enforce"
      ? AGENT_CAPACITY_ACTIVITY_ACTIONS.blocked
      : AGENT_CAPACITY_ACTIVITY_ACTIONS.observed;
  // Written on rootDb so it outlives the rollback caused by the throw below.
  await logActivity(rootDb, {
    companyId: input.companyId,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? "system",
    action,
    entityType: "agent",
    entityId: input.agentId,
    agentId: input.agentId,
    runId: activityRunId,
    issueId: input.issueId,
    details: auditDetails(decision, input),
  }).catch((err) => {
    logger.warn({ err, agentId: input.agentId }, "failed to record agent capacity activity");
  });

  if (mode === "observe") {
    return decision;
  }

  throw conflict(
    `Agent is at its active assignment cap (${activeCount}/${AGENT_ACTIVE_ASSIGNMENT_HARD_CAP}). ` +
      "Drain work to blocked/backlog/done/cancelled, reassign to another agent, or retry as a " +
      `${AGENT_CAPACITY_OVERRIDE_PRIORITY}-priority assignment with a capacityOverride reason.`,
    auditDetails(decision, input),
  );
}

/**
 * True when a mutation newly attaches `nextAssigneeAgentId` to an active issue.
 *
 * The cap governs inbound assignment, not the lifecycle of work an agent already
 * owns. So a status change on an issue whose owner is unchanged is never guarded:
 * that keeps every drain transition and every resume of already-owned work
 * (blocked -> todo, backlog -> in_progress on checkout) available to a saturated
 * agent, which is what stops the guardrail from causing the gridlock it exists
 * to prevent.
 */
export function isCapacityGuardedAssignment(input: {
  previousAssigneeAgentId: string | null | undefined;
  nextAssigneeAgentId: string | null | undefined;
  nextStatus: string | null | undefined;
}): boolean {
  if (!input.nextAssigneeAgentId) return false;
  if (input.previousAssigneeAgentId === input.nextAssigneeAgentId) return false;
  return activeStatusList().includes(input.nextStatus ?? "");
}

// ---------------------------------------------------------------------------
// Escalation episodes
// ---------------------------------------------------------------------------

export interface AgentCapacityEscalationDeps {
  createIssue: (
    companyId: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string } | null>;
  updateIssue: (issueId: string, patch: Record<string, unknown>) => Promise<unknown>;
  wakeup?: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
}

let escalationDeps: AgentCapacityEscalationDeps | null = null;

/**
 * Registered once during app wiring. Kept as an injected slot rather than a
 * direct import because the escalation issue is created through `issueService`,
 * which imports this module.
 */
export function setAgentCapacityEscalationDeps(deps: AgentCapacityEscalationDeps | null): void {
  escalationDeps = deps;
}

export async function findOpenCapacityEscalationIssue(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ id: string } | null> {
  const row = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, AGENT_CAPACITY_ESCALATION_ORIGIN_KIND),
        eq(issues.originId, agentId),
        isNull(issues.hiddenAt),
        sql`${issues.status} not in ('done', 'cancelled')`,
      ),
    )
    .then((rows) => rows[0] ?? null);
  return row ?? null;
}

/**
 * Walks up `reportsTo` for the first manager that can actually take the
 * escalation: active, and not itself at or above the warn threshold.
 *
 * Routing upward past a saturated manager is the point. Assigning the
 * escalation to a manager who is already over the line is how the recovery
 * reconciler manager-load bug on OXFA-18472 happened.
 */
export async function resolveCapacityEscalationOwner(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ ownerAgentId: string | null; skippedSaturatedAgentIds: string[] }> {
  const skipped: string[] = [];
  const visited = new Set<string>([agentId]);
  let current = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  while (current?.reportsTo && !visited.has(current.reportsTo)) {
    visited.add(current.reportsTo);
    const manager = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status, reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, current.reportsTo))
      .then((rows) => rows[0] ?? null);
    if (!manager) break;
    current = manager;
    if (manager.companyId !== companyId || manager.status !== "active") continue;
    const managerActive = await countActiveAssignments(db, companyId, manager.id);
    if (managerActive >= AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD) {
      skipped.push(manager.id);
      continue;
    }
    return { ownerAgentId: manager.id, skippedSaturatedAgentIds: skipped };
  }
  return { ownerAgentId: null, skippedSaturatedAgentIds: skipped };
}

function escalationBody(input: {
  agentId: string;
  activeCount: number;
  skippedSaturatedAgentIds: string[];
}): string {
  const lines = [
    `Agent \`${input.agentId}\` holds **${input.activeCount}** active issues ` +
      `(\`${activeStatusList().join("` + `")}\`), at or above the escalation threshold of ` +
      `${AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD}.`,
    "",
    `New assignments are rejected once the agent reaches ${AGENT_ACTIVE_ASSIGNMENT_HARD_CAP} active issues.`,
    "",
    "To clear this episode, reduce the agent's active load below " +
      `${AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD} by:`,
    "",
    "- moving parked work to `blocked` or `backlog`,",
    "- closing finished work to `done` or `cancelled`,",
    "- reassigning issues to another agent.",
    "",
    "This issue closes automatically when the agent drops below the threshold.",
  ];
  if (input.skippedSaturatedAgentIds.length > 0) {
    lines.push(
      "",
      `Routed upward past ${input.skippedSaturatedAgentIds.length} manager(s) already at or above ` +
        `the threshold: ${input.skippedSaturatedAgentIds.map((id) => `\`${id}\``).join(", ")}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Opens exactly one manager escalation per cap episode, and closes it once the
 * agent drops back below the warn threshold.
 *
 * Idempotence comes from the partial unique index on
 * `(company_id, origin_kind, origin_id)` over open issues, so a racing caller
 * gets a unique violation rather than a duplicate escalation.
 *
 * Best-effort and post-commit by design: a failure here must never fail the
 * assignment that triggered it.
 */
export async function reconcileAgentCapacityEpisode(
  db: Db,
  input: { companyId: string; agentId: string; runId?: string | null },
): Promise<void> {
  const deps = escalationDeps;
  if (!deps) {
    logger.warn(
      { agentId: input.agentId },
      "agent capacity escalation deps not registered; skipping episode reconcile",
    );
    return;
  }

  const activeCount = await countActiveAssignments(db, input.companyId, input.agentId);
  const open = await findOpenCapacityEscalationIssue(db, input.companyId, input.agentId);

  if (activeCount < AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD) {
    if (!open) return;
    await deps.updateIssue(open.id, { status: "done" });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "agent_capacity_guardrail",
      action: AGENT_CAPACITY_ACTIVITY_ACTIONS.episodeReset,
      entityType: "agent",
      entityId: input.agentId,
      agentId: input.agentId,
      runId: input.runId ?? null,
      issueId: open.id,
      details: {
        targetAgentId: input.agentId,
        activeCount,
        warnThreshold: AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
        escalationIssueId: open.id,
      },
    });
    return;
  }

  if (open) return;

  const { ownerAgentId, skippedSaturatedAgentIds } = await resolveCapacityEscalationOwner(
    db,
    input.companyId,
    input.agentId,
  );

  if (!ownerAgentId) {
    // No routable manager. Record it rather than silently assigning to someone
    // who is themselves over the line.
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "agent_capacity_guardrail",
      action: AGENT_CAPACITY_ACTIVITY_ACTIONS.escalationUnroutable,
      entityType: "agent",
      entityId: input.agentId,
      agentId: input.agentId,
      runId: input.runId ?? null,
      details: {
        targetAgentId: input.agentId,
        activeCount,
        warnThreshold: AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
        skippedSaturatedAgentIds,
      },
    });
    return;
  }

  let created: { id: string } | null = null;
  try {
    created = await deps.createIssue(input.companyId, {
      title: `Capacity: agent is at ${activeCount} active issues`,
      description: escalationBody({ agentId: input.agentId, activeCount, skippedSaturatedAgentIds }),
      status: "todo",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      originKind: AGENT_CAPACITY_ESCALATION_ORIGIN_KIND,
      originId: input.agentId,
      originFingerprint: "default",
    });
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "23505") {
      // A concurrent reconcile already opened this episode's escalation.
      return;
    }
    throw err;
  }
  if (!created) return;

  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "agent_capacity_guardrail",
    action: AGENT_CAPACITY_ACTIVITY_ACTIONS.escalated,
    entityType: "agent",
    entityId: input.agentId,
    agentId: input.agentId,
    runId: input.runId ?? null,
    issueId: created.id,
    details: {
      targetAgentId: input.agentId,
      ownerAgentId,
      activeCount,
      warnThreshold: AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
      cap: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
      escalationIssueId: created.id,
      skippedSaturatedAgentIds,
    },
  });

  if (deps.wakeup) {
    await deps.wakeup(ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: created.id, mutation: "agent_capacity_escalation" },
      requestedByActorType: "system",
      requestedByActorId: "agent_capacity_guardrail",
      contextSnapshot: {
        issueId: created.id,
        taskId: created.id,
        wakeReason: "issue_assigned",
        source: AGENT_CAPACITY_ESCALATION_ORIGIN_KIND,
      },
    });
  }
}

const pendingEpisodeReconciles = new Set<Promise<void>>();

/**
 * Fire-and-forget wrapper for the post-commit call sites. Episode reconciliation
 * is observability plus routing; it must never surface as an assignment failure.
 */
export function scheduleAgentCapacityEpisodeReconcile(
  db: Db,
  input: { companyId: string; agentId: string | null | undefined; runId?: string | null },
): Promise<void> | undefined {
  if (!input.agentId) return;
  const pending: Promise<void> = reconcileAgentCapacityEpisode(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId ?? null,
  })
    .catch((err) => {
      logger.warn({ err, agentId: input.agentId }, "failed to reconcile agent capacity episode");
    })
    .finally(() => {
      pendingEpisodeReconciles.delete(pending);
    });
  pendingEpisodeReconciles.add(pending);
  return pending;
}

/**
 * Settles every in-flight episode reconcile. Reconciles are scheduled after the
 * assignment commits and can themselves schedule more (an escalation assigns work
 * to a manager), so this drains until the set is empty.
 */
export async function awaitAgentCapacityEpisodeReconciles(): Promise<void> {
  while (pendingEpisodeReconciles.size > 0) {
    await Promise.allSettled([...pendingEpisodeReconciles]);
  }
}
