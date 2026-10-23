import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues, issueInboxArchives, issueThreadInteractions, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  __getIssueListResponseCacheSizeForTests,
  ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES,
  issueRoutes,
} from "../routes/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { logActivity } from "../services/activity-log.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveRequiredSuccessfulRunHandoffOnValidPath } from "../services/successful-run-handoff-state.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes assigneeAgentId filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(
    companyId: string,
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id") ?? "cloud-user-1";
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }


  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCloudTenantMember(companyId: string, userId = "cloud-user-1") {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  it("returns only unassigned issues for assigneeAgentId=null", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: unassignedIssueId,
        companyId,
        title: "Unassigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId: "null", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([unassignedIssueId]);
  });

  it("returns compact issue list rows with recovery chips but without detail-only fields", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Recovery owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Compact issue",
      description: "This long detail belongs on the issue detail endpoint, not the board list.",
      status: "todo",
      priority: "medium",
      billingCode: "product",
    });
    const recoveryAction = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:compact-route",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      agentId: ownerAgentId,
      runId: null,
      details: {
        sourceRunId,
        detectedProgressSummary: "Implemented the requested change without choosing a disposition.",
      },
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.etag).toMatch(/^"compact-issues:/);
    expect(res.headers["cache-control"]).toBe("private, must-revalidate");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: issueId,
      companyId,
      title: "Compact issue",
      description: "This long detail belongs on the issue detail endpoint, not the board list.",
      status: "todo",
      priority: "medium",
      billingCode: "product",
      activeRecoveryAction: {
        id: recoveryAction.id,
        sourceIssueId: issueId,
        ownerAgentId,
        kind: "missing_disposition",
      },
      successfulRunHandoff: {
        state: "required",
        required: true,
        hasLiveContinuation: false,
        sourceRunId,
        assigneeAgentId: ownerAgentId,
      },
    });
    expect(res.body[0]).not.toHaveProperty("workProducts");
    expect(res.body[0]).not.toHaveProperty("project");
    expect(res.body[0]).not.toHaveProperty("goal");
  });

  it("marks a required successful-run handoff live while a run targets the issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live handoff issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: { sourceRunId: randomUUID() },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { taskId: issueId },
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]?.successfulRunHandoff).toMatchObject({
      state: "required",
      required: true,
      hasLiveContinuation: true,
      liveRunId: runId,
    });
  });

  it("marks an escalated successful-run handoff live while a run targets the issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Escalated handoff issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_escalated",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: { sourceRunId: randomUUID() },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { taskId: issueId },
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]?.successfulRunHandoff).toMatchObject({
      state: "escalated",
      required: false,
      hasLiveContinuation: true,
      liveRunId: runId,
    });
  });

  it("logs resolved when a valid-path skip closes a stale required handoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const resolverRunId = randomUUID();
    const sourceRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: resolverRunId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${uniqueIssuePrefix()}-1`,
      title: "Stale handoff",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: { sourceRunId },
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    await expect(resolveRequiredSuccessfulRunHandoffOnValidPath(db, {
      companyId,
      issueId,
      issueIdentifier: "PAP-1",
      agentId,
      runId: resolverRunId,
      skipReason: "persisted issue monitor owns the next action",
    })).resolves.toBe(true);

    const resolved = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.find((row) => row.action === "issue.successful_run_handoff_resolved"));
    expect(resolved).toMatchObject({
      runId: resolverRunId,
      details: {
        sourceRunId,
        resolvedByRunId: resolverRunId,
        resolvedBySkipReason: "persisted issue monitor owns the next action",
      },
    });
  });

  it("returns 304 for unchanged compact issue list ETags", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cached compact issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId);
    const first = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.headers.etag).toBeTruthy();

    const second = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" })
      .set("If-None-Match", first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });

  it("coalesces simultaneous identical compact issue-list requests into one service computation", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    let computeCount = 0;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Coalesced issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        async onComputeStart() {
          computeCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
    });
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ view: "compact", limit: "20" })
    ));

    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(responses.map((res) => res.body.map((issue: { id: string }) => issue.id))).toEqual(
      Array.from({ length: 10 }, () => [issueId]),
    );
    expect(computeCount).toBe(1);
    expect(responses.some((res) => res.headers["x-paperclip-request-cache"] === "coalesced")).toBe(true);
  });

  it("keeps compact issue-list cache keys separated by board user identity", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    let computeCount = 0;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId, "cloud-user-1");
    await seedCloudTenantMember(companyId, "cloud-user-2");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Separated issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        async onComputeStart() {
          computeCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
      },
    });
    const [first, second] = await Promise.all([
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .set("X-Test-User-Id", "cloud-user-1")
        .query({ view: "compact", limit: "20" }),
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .set("X-Test-User-Id", "cloud-user-2")
        .query({ view: "compact", limit: "20" }),
    ]);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(computeCount).toBe(2);
    expect(first.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(second.headers["x-paperclip-request-cache"]).toBe("miss");
  });

  it("serves repeated compact issue-list requests from the short server cache", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    let computeCount = 0;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cached issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        onComputeStart() {
          computeCount += 1;
        },
      },
    });
    const first = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });
    const second = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(computeCount).toBe(1);
    expect(first.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(second.headers["x-paperclip-request-cache"]).toBe("hit");
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function seedCachedInboxFixture() {
    const companyId = randomUUID(), issueId = randomUUID();
    const completedAt = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(companies).values({ id: companyId, name: "Cache fixture", issuePrefix: uniqueIssuePrefix(), requireBoardApprovalForNewAgents: false });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({ id: issueId, companyId, title: "Archived completion", status: "done", priority: "medium", createdByUserId: "cloud-user-1", completedAt });
    await db.insert(issueInboxArchives).values({ companyId, issueId, userId: "cloud-user-1", archivedAt: completedAt });
    return { companyId, issueId };
  }

  it("immediately resurfaces a new user mention after a primed compact Mine cache", async () => {
    const { companyId, issueId } = await seedCachedInboxFixture();
    const app = createApp(companyId), path = `/api/companies/${companyId}/issues`;
    const query = { view: "compact", touchedByUserId: "me", inboxArchivedByUserId: "me" };
    expect((await request(app).get(path).query(query)).body).toEqual([]);
    expect((await request(app).get(path).query(query)).headers["x-paperclip-request-cache"]).toBe("hit");
    const comment = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "New attention [Me](user://cloud-user-1)", reopen: false });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    const visible = await request(app).get(path).query(query);
    expect(visible.status).toBe(200);
    expect(visible.body.map((row: { id: string }) => row.id)).toContain(issueId);
    expect(visible.headers["x-paperclip-request-cache"]).toBe("miss");
  });

  it("invalidates committed issue caches before a company listener can throw", async () => {
    const { companyId, issueId } = await seedCachedInboxFixture();
    const app = createApp(companyId), path = `/api/companies/${companyId}/issues`;
    const query = { view: "compact" };
    await request(app).get(path).query(query);
    expect((await request(app).get(path).query(query)).headers["x-paperclip-request-cache"]).toBe("hit");
    const notificationFailure = new Error("synthetic company listener failure");
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "activity.logged" && event.payload.entityId === issueId) throw notificationFailure;
    });
    try {
      await db.update(issues).set({ title: "Committed title after cached read" }).where(eq(issues.id, issueId));
      await expect(logActivity(db, {
        companyId, actorType: "user", actorId: "cloud-user-1",
        action: "issue.updated", entityType: "issue", entityId: issueId,
      })).rejects.toBe(notificationFailure);
      const after = await request(app).get(path).query(query);
      expect(after.headers["x-paperclip-request-cache"]).toBe("miss");
      expect(after.body[0].title).toBe("Committed title after cached read");
    } finally { unsubscribe(); }
  });

  it("detaches pre-write reads without joining or caching their stale completion", async () => {
    const { companyId, issueId } = await seedCachedInboxFixture();
    const oldReady = deferred(), releaseOld = deferred(), newDecision = deferred();
    let joinedOld = false;
    let computes = 0;
    const app = createApp(companyId, { issueListDiagnostics: {
      onComputeStart() { computes += 1; if (computes === 2) newDecision.resolve(); },
      onCoalesced() { joinedOld = true; newDecision.resolve(); },
      async onComputeComplete() { if (computes === 1) { oldReady.resolve(); await releaseOld.promise; } },
    } });
    const path = `/api/companies/${companyId}/issues`;
    const query = { view: "compact", touchedByUserId: "me", inboxArchivedByUserId: "me" };
    const old = request(app).get(path).query(query).then(response => response);
    await oldReady.promise;
    let fresh: Promise<Awaited<typeof old>> | undefined;
    try {
      const comment = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "New attention [Me](user://cloud-user-1)", reopen: false });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);
      fresh = request(app).get(path).query(query).then(response => response);
      await newDecision.promise;
      expect(joinedOld).toBe(false);
      expect(computes).toBe(2);
      const response = await fresh;
      expect(response.body.map((row: { id: string }) => row.id)).toContain(issueId);
      releaseOld.resolve();
      expect((await old).body).toEqual([]);
      const final = await request(app).get(path).query(query);
      expect(final.body.map((row: { id: string }) => row.id)).toContain(issueId);
      expect(final.headers["x-paperclip-request-cache"]).toBe("hit");
      expect(computes).toBe(2);
    } finally { releaseOld.resolve(); await old; await fresh; }
  });

  it("keeps another company's compact cache and does not invalidate on a no-op conditional archive", async () => {
    const first = await seedCachedInboxFixture(), other = await seedCachedInboxFixture();
    const app = createApp(first.companyId), otherApp = createApp(other.companyId);
    const query = { view: "compact", touchedByUserId: "me", inboxArchivedByUserId: "me" };
    const path = `/api/companies/${first.companyId}/issues`, otherPath = `/api/companies/${other.companyId}/issues`;
    await request(app).get(path).query(query);
    await request(otherApp).get(otherPath).query(query);
    const noop = await request(app).post(`/api/issues/${first.issueId}/inbox-archive`).send({ expectedCompletedAt: "2025-01-01T00:00:00.000Z" });
    expect(noop.status, JSON.stringify(noop.body)).toBe(200);
    expect(noop.body.archived).toBe(false);
    expect((await request(app).get(path).query(query)).headers["x-paperclip-request-cache"]).toBe("hit");
    const comment = await request(app).post(`/api/issues/${first.issueId}/comments`).send({ body: "New attention [Me](user://cloud-user-1)", reopen: false });
    expect(comment.status).toBe(201);
    expect((await request(otherApp).get(otherPath).query(query)).headers["x-paperclip-request-cache"]).toBe("hit");
    expect((await request(app).get(path).query(query)).headers["x-paperclip-request-cache"]).toBe("miss");
  });

  it("keeps a newer coalescing entry when the detached old read finishes", async () => {
    const { companyId, issueId } = await seedCachedInboxFixture();
    const oldReady = deferred(), releaseOld = deferred(), newReady = deferred(), releaseNew = deferred(), decision = deferred();
    let computes = 0, completed = 0, joined = false;
    const app = createApp(companyId, { issueListDiagnostics: {
      onComputeStart() { computes += 1; if (computes > 2) decision.resolve(); },
      onCoalesced() { joined = true; decision.resolve(); },
      async onComputeComplete() {
        completed += 1;
        if (completed === 1) { oldReady.resolve(); await releaseOld.promise; }
        else if (completed === 2) { newReady.resolve(); await releaseNew.promise; }
      },
    } });
    const path = `/api/companies/${companyId}/issues`;
    const query = { view: "compact", touchedByUserId: "me", inboxArchivedByUserId: "me" };
    const old = request(app).get(path).query(query).then(response => response);
    await oldReady.promise;
    let fresh: Promise<Awaited<typeof old>> | undefined, follower: Promise<Awaited<typeof old>> | undefined;
    try {
      expect((await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "New attention [Me](user://cloud-user-1)", reopen: false })).status).toBe(201);
      fresh = request(app).get(path).query(query).then(response => response);
      await newReady.promise;
      releaseOld.resolve();
      expect((await old).body).toEqual([]);
      follower = request(app).get(path).query(query).then(response => { decision.resolve(); return response; });
      await decision.promise;
      expect(joined).toBe(true);
      expect(computes).toBe(2);
      releaseNew.resolve();
      for (const response of await Promise.all([fresh, follower])) {
        expect(response.body.map((row: { id: string }) => row.id)).toContain(issueId);
      }
    } finally { releaseOld.resolve(); releaseNew.resolve(); await Promise.all([old, fresh, follower]); }
  });

  it("counts invalidated reads until completion when enforcing the actor admission cap", async () => {
    const { companyId, issueId } = await seedCachedInboxFixture();
    const allReady = deferred(), release = deferred();
    let computes = 0, completed = 0;
    const app = createApp(companyId, { issueListDiagnostics: {
      onComputeStart() { computes += 1; },
      async onComputeComplete() { completed += 1; if (completed === 8) allReady.resolve(); await release.promise; },
    } });
    const path = `/api/companies/${companyId}/issues`;
    const reads = Array.from({ length: 8 }, (_, index) => request(app).get(path).query({ view: "compact", q: `held-${index}` }).then(response => response));
    await allReady.promise;
    try {
      const comment = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "New attention [Me](user://cloud-user-1)", reopen: false });
      expect(comment.status).toBe(201);
      const overflow = await request(app).get(path).query({ view: "compact", q: "new-after-write" });
      expect(overflow.status).toBe(429);
      expect(computes).toBe(8);
    } finally { release.resolve(); await Promise.all(reads); }
  });

  it.each([false, true])("publishes confirmation cache invalidation only after its owner commits (rollback=%s)", async (rollback) => {
    const { companyId, issueId } = await seedCachedInboxFixture();
    await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, issueId));
    const issue = { id: issueId, companyId, projectId: null, goalId: null };
    const interaction = await issueThreadInteractionService(db).create(issue, {
      kind: "request_confirmation", payload: { version: 1, prompt: "Confirm the synthetic task" },
    }, { userId: "cloud-user-1" });
    const originalTime = new Date("2026-01-01T00:00:00.000Z");
    await db.update(issues).set({ updatedAt: originalTime }).where(eq(issues.id, issueId));
    const app = createApp(companyId), path = `/api/companies/${companyId}/issues`;
    const query = { view: "compact" };
    expect((await request(app).get(path).query(query)).body[0].updatedAt).toBe(originalTime.toISOString());
    const beforeCommit = deferred(), release = deferred();
    const events: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "activity.logged" && event.payload.action === "issue.thread_interaction_accepted") events.push(String(event.payload.action));
    });
    const effects: Array<(committedDb: typeof db) => Promise<void>> = [];
    const write = db.transaction(async (tx) => {
      const result = await issueThreadInteractionService(tx as unknown as typeof db).acceptInteraction(issue, interaction.id, {}, { systemId: "system:pr-merged" }, {
        deferConfirmationCommitEffects: (effect) => { effects.push(effect); },
      });
      beforeCommit.resolve();
      await release.promise;
      if (rollback) throw new Error("synthetic owner rollback");
      return result;
    });
    const settled = write.then(result => ({ result, failed: false }), () => ({ result: null, failed: true }));
    try {
      await Promise.race([beforeCommit.promise, settled.then(outcome => { expect(outcome.failed).toBe(false); })]);
      expect(events).toEqual([]);
      const during = await request(app).get(path).query(query);
      expect(during.headers["x-paperclip-request-cache"]).toBe("hit");
      expect(during.body[0].updatedAt).toBe(originalTime.toISOString());
      release.resolve();
      const outcome = await settled;
      expect(outcome.failed).toBe(rollback);
      if (!rollback) for (const effect of effects) await effect(db);
      expect(events).toHaveLength(rollback ? 0 : 1);
      const after = await request(app).get(path).query(query);
      expect(after.headers["x-paperclip-request-cache"]).toBe(rollback ? "hit" : "miss");
      if (rollback) expect(after.body[0].updatedAt).toBe(originalTime.toISOString());
      else expect(new Date(after.body[0].updatedAt).getTime()).toBeGreaterThan(originalTime.getTime());
      const [persisted] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
      expect(persisted.status).toBe(rollback ? "pending" : "accepted");
    } finally { release.resolve(); await settled; unsubscribe(); }
  });

  it("bounds compact issue-list server cache entries", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bounded cache issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId);
    // Exercise capacity independently of query duration and TTL expiry.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      for (let index = 0; index < ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES + 5; index += 1) {
        const res = await request(app)
          .get(`/api/companies/${companyId}/issues`)
          .query({ view: "compact", limit: "20", q: `cache-key-${index}` });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }

      expect(__getIssueListResponseCacheSizeForTests()).toBe(ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES);
    } finally { clock.mockRestore(); }
  });

  it("logs request_storm_detected for identical in-flight compact issue-list fanout without query values", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const stormEvents: unknown[] = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Storm issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        async onComputeStart() {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
        onStormDetected(event) {
          stormEvents.push(event);
        },
      },
    });
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .set("Referer", "http://localhost:3100/issues?q=do-not-log-this")
        .set("X-Paperclip-Tab-Visible", "visible")
        .query({ view: "compact", limit: "20", q: "do-not-log-this" })
    ));

    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(stormEvents).toHaveLength(1);
    expect(stormEvents[0]).toMatchObject({
      event: "request_storm_detected",
      route: "GET /api/companies/:companyId/issues",
      companyId,
      visibilityHint: "visible",
      referer: "/issues",
    });
    expect((stormEvents[0] as { queryKeys: string[] }).queryKeys).toEqual(
      expect.arrayContaining(["limit", "q", "view"]),
    );
    expect(JSON.stringify(stormEvents[0])).not.toContain("do-not-log-this");
  });

  it("keeps UUID assignee filtering behavior unchanged", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([assignedIssueId]);
  });

  it("returns 422 for malformed assigneeAgentId filters", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId: "bad", limit: "20" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "assigneeAgentId must be a UUID or 'null'",
    });
  });

  it("returns opt-in live descendant counts for offscreen live descendants only", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const hiddenChildIssueId = randomUUID();
    const crossCompanyChildIssueId = randomUUID();
    const rootRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const hiddenRunId = randomUUID();
    const crossCompanyRunId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: uniqueIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Company",
        issuePrefix: uniqueIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: rootRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: rootIssueId },
      },
      {
        id: grandchildRunId,
        companyId,
        agentId,
        status: "queued",
        contextSnapshot: { issueId: grandchildIssueId },
      },
      {
        id: hiddenRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: hiddenChildIssueId },
      },
      {
        id: crossCompanyRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "running",
        contextSnapshot: { issueId: crossCompanyChildIssueId },
      },
    ]);
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "critical",
        executionRunId: rootRunId,
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        title: "Offscreen child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        assigneeAgentId: agentId,
      },
      {
        id: grandchildIssueId,
        companyId,
        title: "Offscreen live grandchild",
        status: "todo",
        priority: "medium",
        parentId: childIssueId,
        executionRunId: grandchildRunId,
        assigneeAgentId: agentId,
      },
      {
        id: hiddenChildIssueId,
        companyId,
        title: "Hidden live child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        executionRunId: hiddenRunId,
        hiddenAt: new Date("2026-07-02T00:00:00.000Z"),
        assigneeAgentId: agentId,
      },
      {
        id: crossCompanyChildIssueId,
        companyId: otherCompanyId,
        title: "Cross-company live child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        executionRunId: crossCompanyRunId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);
    const withoutSummary = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", limit: "20" });

    expect(withoutSummary.status, JSON.stringify(withoutSummary.body)).toBe(200);
    expect(withoutSummary.body).toHaveLength(1);
    expect(withoutSummary.body[0].id).toBe(rootIssueId);
    expect(withoutSummary.body[0].liveDescendantCount).toBeUndefined();

    const withSummary = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", includeLiveDescendantSummary: "true", limit: "20" });

    expect(withSummary.status, JSON.stringify(withSummary.body)).toBe(200);
    expect(withSummary.body).toHaveLength(1);
    expect(withSummary.body[0]).toMatchObject({
      id: rootIssueId,
      liveDescendantCount: 1,
    });
  });

  it("does not recurse forever when live descendant summaries encounter a parent cycle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: childIssueId },
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Cycle parent",
        status: "blocked",
        priority: "medium",
        parentId: childIssueId,
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        title: "Cycle live child",
        status: "in_progress",
        priority: "medium",
        parentId: parentIssueId,
        executionRunId: runId,
        assigneeAgentId: agentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", includeLiveDescendantSummary: "true", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: parentIssueId,
      liveDescendantCount: 1,
    });
  });
});
