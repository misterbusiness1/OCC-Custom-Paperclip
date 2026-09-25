import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySkills,
  completionContracts,
  costEvents,
  createDb,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisions,
  decisionTriage,
  decisionTriageEvents,
  documents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueReadStates,
  issues,
  nativeRunResults,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(decisionTriageEvents);
    await db.delete(decisionQueueItems);
    await db.delete(decisionQueues);
    await db.delete(decisionRetention);
    await db.delete(decisionTriage);
    await db.delete(decisions);
    await db.delete(decisionBundles);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(nativeRunResults);
    await db.delete(completionContracts);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes heartbeat events by run id before deleting company-owned runs", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
  });

  it("removes native-runner rows before deleting company issues and runs", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const contractId = randomUUID();
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "1",
      policyVersion: "1",
      risk: "low",
      completionAuthority: "agent",
      incompleteCriteriaPolicy: "block",
      contractJson: {},
      canonicalSha256: "a".repeat(64),
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db
      .update(heartbeatRuns)
      .set({ nativeIssueId: issueId, completionContractId: contractId })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: "fingerprint-1",
      schemaStatus: "valid",
      resultJson: {},
      canonicalSha256: "b".repeat(64),
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(completionContracts).where(eq(completionContracts.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
  });

  it("removes run-linked cost events before deleting company-owned runs", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      heartbeatRunId: runId,
      provider: "test",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
  });

  it("removes run-linked decision rows before deleting company-owned runs", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();
    const queueId = randomUUID();
    const bundleId = randomUUID();

    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "review",
      title: "Review",
      createdByType: "system",
      createdByRunId: runId,
    });
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId,
      sourceKind: "issue",
      sourceId: issueId,
      addedByType: "system",
      addedByRunId: runId,
    });
    await db.insert(decisionTriage).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      setByType: "agent",
      setByAgentId: agentId,
      setByRunId: runId,
    });
    await db.insert(decisionTriageEvents).values({
      companyId,
      queueId,
      action: "added",
      actorType: "system",
      actorRunId: runId,
    });
    await db.insert(decisionRetention).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      sourceActivityAt: new Date(),
      archivedAt: new Date(),
      archivedByType: "system",
      archivedByRunId: runId,
    });
    await db.insert(decisionBundles).values({
      id: bundleId,
      companyId,
      title: "Bundle",
      summary: "Summary",
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
    });
    await db.insert(decisions).values({
      companyId,
      bundleId,
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
      title: "Decision",
      body: "Body",
      options: [],
      expiresAt: new Date(Date.now() + 60_000),
      signedSpec: "signed",
      targetSnapshots: {},
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(decisionQueues).where(eq(decisionQueues.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(decisionRetention).where(eq(decisionRetention.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(decisions).where(eq(decisions.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
  });

  it("removes routines before deleting company agents", async () => {
    const { agentId, companyId } = await seedFixture();
    const routineId = randomUUID();

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Daily cleanup",
      assigneeAgentId: agentId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(routines).where(eq(routines.id, routineId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });
});
