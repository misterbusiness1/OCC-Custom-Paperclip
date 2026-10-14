import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  budgetPolicies,
  companies,
  completionContracts,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { issueService } from "../services/issues.ts";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.ts";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
} from "../services/issue-dependency-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat resolved dependency wake reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Dependency reconciliation heals missing wakes by enqueuing an
    // on-demand wake, which dispatches a heartbeat run fire-and-forget (see
    // startNextQueuedRunForAgent → executeRun in the heartbeat service). That
    // background run keeps writing rows (workspace_operations, heartbeat_run_events)
    // after the awaited call resolves. Deterministically await those in-flight
    // executions before clearing tables — otherwise an escaping heartbeat_run_events
    // insert can land between the events delete and the heartbeat_runs delete and
    // trip the run_events → runs foreign key.
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(nativeRunFinalizations);
    await db.delete(statusDecisionEffects);
    await db.update(issues).set({ lastStatusDecisionId: null });
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunResults);
    await db.update(heartbeatRuns).set({ completionContractId: null });
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
    blockedIssueId?: string;
    dependentStatus?: "blocked" | "in_review";
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = opts.blockedIssueId ?? randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: opts.dependentStatus ?? "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  it("runs exactly one bounded review-path recovery before surfacing a stalled decision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PAP-14994 fingerprint",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const attention = await issueService(db)
      .listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }]);
    expect(attention.get(issueId)).toMatchObject({ state: "stalled", paths: [] });

    const feed = await attentionService(db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === issueId)).toMatchObject({
      sourceKind: "review",
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
  });

  it("keeps resolved dependency wake reconciliation active", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("heals an in_review dependent after its blocker workspace finalizes", async () => {
    const { agentId, blockedIssueId } = await seedResolvedDependencyBackstopFixture({
      workspaceState: "finalized",
      dependentStatus: "in_review",
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    const wake = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wake?.reason).toBe("issue_blockers_resolved");
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("excludes archived companies from global dependency wake recovery while healing active companies", async () => {
    const archived = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(companies)
      .set({ status: "archived" })
      .where(eq(companies.id, archived.companyId));
    const active = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.checked).toBe(1);
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([active.blockedIssueId]);

    const archivedWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, archived.companyId));
    expect(archivedWakes).toHaveLength(0);
  });

  it("filters non-ready blocked issues before applying the candidate page limit", async () => {
    const readyBlockedIssueId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const { companyId, agentId, blockedIssueId } = await seedResolvedDependencyBackstopFixture({
      workspaceState: "none",
      blockedIssueId: readyBlockedIssueId,
    });
    const unfinishedBlockerIssueId = "10000000-0000-4000-8000-ffffffffffff";
    const missingBlockerIssueId = "10000000-0000-4000-9000-ffffffffffff";
    const unresolvedDependentIds = Array.from(
      { length: 501 },
      (_, index) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );

    await db.insert(issues).values([
      {
        id: unfinishedBlockerIssueId,
        companyId,
        title: "Unfinished blocker",
        status: "todo",
        priority: "medium",
        issueNumber: 3,
        identifier: "PAGE-3",
      },
      {
        id: missingBlockerIssueId,
        companyId,
        title: "Blocked without a blocker relation",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 4,
        identifier: "PAGE-4",
      },
      ...unresolvedDependentIds.map((id, index) => ({
        id,
        companyId,
        title: `Blocked on unfinished dependency ${index + 1}`,
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: index + 5,
        identifier: `PAGE-${index + 5}`,
      })),
    ]);
    await db.insert(issueRelations).values(
      unresolvedDependentIds.map((relatedIssueId) => ({
        companyId,
        issueId: unfinishedBlockerIssueId,
        relatedIssueId,
        type: "blocks" as const,
      })),
    );

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.checked).toBe(1);
    expect(result.candidateLimitSkipped).toBe(0);
    expect(result.notReadySkipped).toBe(0);
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(db);

    const beforeAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeAssignment.healed).toBe(0);
    expect(beforeAssignment.checked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterAssignment.healed).toBe(1);
    expect(afterAssignment.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  async function seedExecutionWait(status: "active" | "resolved" = "resolved") {
    const fixture = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId, sourceIssueId: fixture.blockedIssueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: fixture.agentId,
      cause: "legacy_execution_requires_reconciliation", status,
      evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {},
      fingerprint: randomUUID(), nextAction: "Check the stopped execution before resuming.",
    }).returning();
    return { ...fixture, action: action! };
  }

  it.each(["active", "resolved"] as const)("keeps repeated wakes behind a %s execution hold run-free, then resumes once", async (status) => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait(status);
    const heartbeat = heartbeatService(db);
    // Different producers and wake keys must not create new attempts or notices.
    await Promise.all(Array.from({ length: 6 }, (_, i) => heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      idempotencyKey: `producer-${i}`, payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId },
    })));
    for (let i = 0; i < 3; i++) {
      // Recreate the service to prove the wait is durable across scheduler restarts.
      expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(0);
    }
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      status: "skipped", runId: null, reason: "execution_reconciliation_required", coalescedCount: 8,
      payload: { issueId: blockedIssueId, executionWait: { recoveryActionId: action.id } },
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted"),
    ))).toHaveLength(0);

    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockedIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Finished the dependency-ready task.", provider: "test", model: "test-model" };
    });
    await db.update(issueRecoveryActions).set({ status: "resolved", evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(1);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("rechecks every gate after an execution hold clears", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, action } = await seedExecutionWait();
    const wake = () => heartbeatService(db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    await wake();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    await wake();
    await wake();
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(2);
    expect(waits.find((row) => row.reason === "issue_dependencies_blocked")?.coalescedCount).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(1);
  });

  it("preserves distinct comments through a hold and adopts them on the next eligible wake", async () => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait();
    const heartbeat = heartbeatService(db);
    const commentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [comment] = await db.insert(issueComments).values({
        companyId, issueId: blockedIssueId, authorUserId: "board-user", body: `Follow-up ${i}`,
      }).returning();
      commentIds.push(comment!.id);
      expect(await heartbeat.wakeup(agentId, {
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "board-user",
        payload: { issueId: blockedIssueId, commentId: comment!.id },
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_commented", wakeCommentId: comment!.id },
      })).toBeNull();
    }
    const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(deferred).toHaveLength(2);
    expect(deferred.every((row) => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    const resumed = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_resumed",
      requestedByActorType: "user", requestedByActorId: "board-user",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    expect(resumed?.contextSnapshot?.wakeCommentIds).toEqual(commentIds);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipts.filter((row) => row.status === "coalesced")).toHaveLength(2);
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The route-time wake writes the level-triggered state key. A skip records a
    // `skipped` row with that key. `skipped` is not an in-flight status, so the
    // backstop must still re-emit for the same ready state.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatService(db);

    const beforeFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeFinalize.healed).toBe(0);
    expect(beforeFinalize.notReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterFinalize.healed).toBe(1);
    expect(afterFinalize.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
  });

  it("heals a multi-blocker dependent when only a completed wake for an earlier blocker exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Earlier completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    // An earlier partial resolution left a `completed` per-edge wake. The bug was
    // that this stale wake suppressed the wake for the current ready state. The
    // level-triggered dedup keys on the full blocker set, so this completed wake
    // no longer strands the dependent.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: secondBlockerIssueId,
      },
      status: "completed",
      finishedAt: new Date(),
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${secondBlockerIssueId}`,
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    expect(readiness.isDependencyReady).toBe(true);

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: readiness.blockerIssueIds,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    // A second reconciliation pass finds the state-key wake and stays bounded:
    // it heals nothing more and never enqueues a second wake for the same state.
    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const stateKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)));
    expect(stateKeyWakes).toHaveLength(1);
  });

  async function seedDeliveredExternalWait() {
    const fixture = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    const blockerCompletedAt = new Date("2026-07-31T12:00:00.000Z");
    const deliveredAt = new Date("2026-08-01T12:00:01.000Z");
    // An external action can be described with the executing agent as its
    // structured owner; do not rely on owner != assignee to recognize the wait.
    const unblockDescriptor = {
      owner: { agentId: fixture.agentId },
      action: "Wait for the board to authorize the external purchase test.",
    };
    await db.update(issues).set({
      unblockDescriptor,
      blockedTransitionAt,
      blockedOwnerNotifiedAt: blockedTransitionAt,
    }).where(eq(issues.id, fixture.blockedIssueId));
    await db.update(issues).set({ completedAt: blockerCompletedAt })
      .where(eq(issues.id, fixture.blockerIssueId));
    const deliveredKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: fixture.blockedIssueId,
      blockerIssueIds: [fixture.blockerIssueId],
      blockerGenerations: [{ issueId: fixture.blockerIssueId, completedAt: blockerCompletedAt }],
      blockedTransitionAt,
    });
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: {
        issueId: fixture.blockedIssueId,
        resolvedBlockerIssueId: fixture.blockerIssueId,
        blockerIssueIds: [fixture.blockerIssueId],
      },
      status: "completed",
      requestedAt: deliveredAt,
      finishedAt: deliveredAt,
      idempotencyKey: deliveredKey,
    });
    return { ...fixture, unblockDescriptor, blockedTransitionAt, blockerCompletedAt, deliveredKey };
  }

  async function seedNativeExternalWait() {
    const fixture = await seedDeliveredExternalWait();
    const contractId = randomUUID();
    await db.insert(completionContracts).values({
      id: contractId, companyId: fixture.companyId, issueId: fixture.blockedIssueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { criteria: [] }, canonicalSha256: `w2-contract:${contractId}`,
      createdByActorType: "system", createdByActorId: "w2-regression",
    });
    const commitWait = async (descriptor = fixture.unblockDescriptor) => {
      const current = await issueService(db).checkout(fixture.blockedIssueId, fixture.agentId, ["blocked", "in_progress"], null);
      const runId = randomUUID();
      const resultId = randomUUID();
      const assessmentId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: fixture.companyId, agentId: fixture.agentId, status: "succeeded",
        runtimeMode: "native", nativeIssueId: fixture.blockedIssueId,
        contextSnapshot: { issueId: fixture.blockedIssueId }, completionContractId: contractId,
      });
      await db.insert(nativeRunResults).values({
        id: resultId, companyId: fixture.companyId, issueId: fixture.blockedIssueId, runId,
        completionContractId: contractId, serverFingerprint: `w2-result:${resultId}`,
        schemaStatus: "accepted", resultJson: {}, canonicalSha256: `w2-result:${resultId}`,
      });
      await db.insert(workAssessments).values({
        id: assessmentId, companyId: fixture.companyId, issueId: fixture.blockedIssueId, runId,
        contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: fixture.companyId,
        priorIssueStatus: current.status, priorStatusVersion: current.statusVersion,
        priorDecisionId: current.lastStatusDecisionId, policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        assessmentJson: {}, inputDigest: `w2-assessment:${assessmentId}`,
      });
      await db.insert(nativeRunFinalizations).values({
        runId, companyId: fixture.companyId, issueId: fixture.blockedIssueId,
        phase: "assessing", resultId, assessmentId,
      });
      return commitNativeStatusDecision({
        db, companyId: fixture.companyId, issueId: fixture.blockedIssueId, runId, assessmentId,
        priorStatus: current.status, priorStatusVersion: current.statusVersion,
        priorDecisionId: current.lastStatusDecisionId,
        decision: {
          policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
          statusAction: "blocked", toStatus: "blocked", reasonCode: "task_wide_blocker_bound",
          unblockDescriptor: descriptor,
          effects: [
            { kind: "bind_blocker", owner: descriptor.owner, action: descriptor.action },
            { kind: "notify_owner", agentId: fixture.agentId, reason: "task_wide_blocker_bound" },
          ],
        },
      });
    };
    return { ...fixture, commitWait };
  }

  it("W2 native blocker notifications cannot bypass continuation provenance", async () => {
    const fixture = await seedNativeExternalWait();
    const heartbeat = heartbeatService(db);
    for (const action of [
      fixture.unblockDescriptor.action,
      fixture.unblockDescriptor.action,
      "Approve the newly required renewal.",
    ]) {
      await fixture.commitWait({ ...fixture.unblockDescriptor, action });
      const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: fixture.companyId });
      expect(result.scanned).toBeGreaterThan(0);
      expect(result.dispatched).toBe(0);
      await heartbeat.drainActiveRunExecutions();
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    }
    // These effects are notifications, not authorized continuations. Their
    // queued intent rows must not be mistaken for a second provider-run loop.
    const proofRejections = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, fixture.companyId),
      eq(agentWakeupRequests.reason, "chat_control_recovery_proof_unresolved"),
    ));
    expect(proofRejections.length).toBeGreaterThan(0);
    expect(proofRejections.every((wake) => wake.status === "skipped" && wake.runId === null)).toBe(true);
  });

  it("W2 keeps an already-delivered external wait quiet after checkout and the same owner/action reblock", async () => {
    const fixture = await seedDeliveredExternalWait();
    const svc = issueService(db);
    const heartbeat = heartbeatService(db);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const checkedOut = await svc.checkout(fixture.blockedIssueId, fixture.agentId, ["blocked"], null);
      expect(checkedOut.status).toBe("in_progress");
      const reblocked = await svc.update(fixture.blockedIssueId, {
        status: "blocked",
        unblockDescriptor: fixture.unblockDescriptor,
        actorAgentId: fixture.agentId,
      });

      const result = await heartbeat.reconcileResolvedDependencyWakes();
      expect(result.healed).toBe(0);
      expect(result.existingWakeSkipped).toBe(1);
      expect(reblocked?.blockedTransitionAt).toEqual(fixture.blockedTransitionAt);
      expect(reblocked?.blockedOwnerNotifiedAt).toEqual(fixture.blockedTransitionAt);
      expect(reblocked?.unblockDescriptor).toEqual(fixture.unblockDescriptor);
      const dependencyWakes = await db.select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, fixture.companyId));
      expect(dependencyWakes.filter((wake) => wake.idempotencyKey?.startsWith("issue_blockers_resolved:")))
        .toEqual([{ idempotencyKey: fixture.deliveredKey }]);
    }
  });

  it("W2 still wakes the same external wait once when its blocker genuinely completes again", async () => {
    const fixture = await seedDeliveredExternalWait();
    const svc = issueService(db);
    const heartbeat = heartbeatService(db);

    await svc.update(fixture.blockerIssueId, {
      status: "in_progress",
      assigneeAgentId: fixture.agentId,
    });
    const whileUnresolved = await heartbeat.reconcileResolvedDependencyWakes();
    expect(whileUnresolved.healed).toBe(0);

    const completedBlocker = await svc.update(fixture.blockerIssueId, { status: "done" });
    expect(completedBlocker?.completedAt?.getTime()).toBeGreaterThan(fixture.blockerCompletedAt.getTime());
    const result = await heartbeat.reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([fixture.blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const newKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: fixture.blockedIssueId,
      blockerIssueIds: [fixture.blockerIssueId],
      blockerGenerations: [{ issueId: fixture.blockerIssueId, completedAt: completedBlocker?.completedAt }],
      blockedTransitionAt: fixture.blockedTransitionAt,
    });
    expect(newKey).not.toBe(fixture.deliveredKey);
    const newWakes = await db.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.idempotencyKey, newKey),
      ));
    expect(newWakes).toHaveLength(1);
    const secondPass = await heartbeat.reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);
  });

  it.each(["owner", "action"] as const)("W2 starts a fresh wait when the %s changes after checkout", async (changedField) => {
    const fixture = await seedDeliveredExternalWait();
    const svc = issueService(db);
    await svc.checkout(fixture.blockedIssueId, fixture.agentId, ["blocked"], null);
    const unblockDescriptor = changedField === "owner"
      ? { ...fixture.unblockDescriptor, owner: "board" as const }
      : { ...fixture.unblockDescriptor, action: "Wait for the board to authorize the renewal test." };
    const reblocked = await svc.update(fixture.blockedIssueId, {
      status: "blocked",
      unblockDescriptor,
      actorAgentId: fixture.agentId,
    });

    expect(reblocked?.blockedTransitionAt?.getTime()).toBeGreaterThan(fixture.blockedTransitionAt.getTime());
    expect(reblocked?.blockedOwnerNotifiedAt).toBeNull();
    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([fixture.blockedIssueId]);
  });

  it("W2 keeps a blocked cycle when an identical descriptor is patched separately", async () => {
    const fixture = await seedDeliveredExternalWait();
    const svc = issueService(db);
    const patched = await svc.update(fixture.blockedIssueId, {
      unblockDescriptor: { ...fixture.unblockDescriptor },
    });
    expect(patched?.blockedTransitionAt).toEqual(fixture.blockedTransitionAt);
    expect(patched?.blockedOwnerNotifiedAt).toEqual(fixture.blockedTransitionAt);
    await svc.checkout(fixture.blockedIssueId, fixture.agentId, ["blocked"], null);
    await svc.update(fixture.blockedIssueId, {
      status: "blocked",
      unblockDescriptor: fixture.unblockDescriptor,
      actorAgentId: fixture.agentId,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
  });

  it.each([false, true])("W2 starts a fresh wait when a blocked descriptor is edited before checkout (explicit status: %s)", async (explicitStatus) => {
    const fixture = await seedDeliveredExternalWait();
    const svc = issueService(db);
    const unblockDescriptor = {
      ...fixture.unblockDescriptor,
      action: "Wait for the board to authorize the changed purchase test.",
    };
    // HTTP accepts a descriptor-only patch while the issue remains blocked.
    // Editing that descriptor must not relabel the old cycle as the new wait.
    await svc.update(fixture.blockedIssueId, {
      unblockDescriptor,
      ...(explicitStatus ? { status: "blocked" } : {}),
    });
    await svc.checkout(fixture.blockedIssueId, fixture.agentId, ["blocked"], null);
    const reblocked = await svc.update(fixture.blockedIssueId, {
      status: "blocked",
      unblockDescriptor,
      actorAgentId: fixture.agentId,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([fixture.blockedIssueId]);
    expect(reblocked?.blockedTransitionAt?.getTime()).toBeGreaterThan(fixture.blockedTransitionAt.getTime());
    expect(reblocked?.blockedOwnerNotifiedAt).toBeNull();
  });

  it("W2 starts a fresh wait after completing and reopening the dependent", async () => {
    const fixture = await seedDeliveredExternalWait();
    const svc = issueService(db);
    await svc.checkout(fixture.blockedIssueId, fixture.agentId, ["blocked"], null);
    await svc.update(fixture.blockedIssueId, { status: "done" });
    await svc.update(fixture.blockedIssueId, { status: "in_progress" });
    const reblocked = await svc.update(fixture.blockedIssueId, {
      status: "blocked",
      unblockDescriptor: fixture.unblockDescriptor,
      actorAgentId: fixture.agentId,
    });

    expect(reblocked?.blockedTransitionAt?.getTime()).toBeGreaterThan(fixture.blockedTransitionAt.getTime());
    expect(reblocked?.blockedOwnerNotifiedAt).toBeNull();
    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([fixture.blockedIssueId]);
  });

  it("W2 still wakes the same external wait when its dependency set changes", async () => {
    const fixture = await seedDeliveredExternalWait();
    const newBlockerId = randomUUID();
    await db.insert(issues).values({
      id: newBlockerId,
      companyId: fixture.companyId,
      title: "Newly added completed blocker",
      status: "done",
      completedAt: fixture.blockerCompletedAt,
      priority: "medium",
      issueNumber: 3,
      identifier: "R-EXTERNAL-WAIT-3",
    });
    const svc = issueService(db);
    await svc.checkout(fixture.blockedIssueId, fixture.agentId, ["blocked"], null);
    await svc.update(fixture.blockedIssueId, {
      status: "blocked",
      unblockDescriptor: fixture.unblockDescriptor,
      blockedByIssueIds: [fixture.blockerIssueId, newBlockerId],
      actorAgentId: fixture.agentId,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([fixture.blockedIssueId]);
    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);
  });

  it("heals a blocked dependent after a terminal reset when a previous-cycle old-key wake exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const previousCycleWakeAt = new Date("2026-07-01T12:00:00.000Z");
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: previousCycleWakeAt,
      requestedAt: previousCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const cycleKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const cycleKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)));
    expect(cycleKeyWakes).toHaveLength(1);
  });

  it("does not re-heal when a completed old-key wake is from the current blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    const sameCycleWakeAt = new Date("2026-08-01T12:00:01.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: sameCycleWakeAt,
      requestedAt: sameCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.deferredOrFailed).toBe(1);
    expect(result.enqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

});
