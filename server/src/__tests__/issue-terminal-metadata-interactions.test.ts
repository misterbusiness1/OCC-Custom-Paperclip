import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companySecretProposals,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  toolActionRequests,
  toolInvocations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const terminalAt = new Date("2026-05-01T12:00:00.000Z");

describeEmbeddedPostgres("terminal issue metadata interaction reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-metadata-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedHistoricalIssue(status: "done" | "cancelled" | "todo") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Historical interaction reconciliation",
      issuePrefix: `TM${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Historical task owner", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    // Import a historical terminal row that predates canonical card cleanup.
    await db.insert(issues).values({
      id: issueId, companyId, title: "Historical task", status, priority: "medium",
      assigneeAgentId: agentId, statusVersion: 7,
      completedAt: status === "done" ? terminalAt : null,
      cancelledAt: status === "cancelled" ? terminalAt : null,
    });
    const [card] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", createdByAgentId: agentId,
      payload: { version: 1, prompt: "Approve the historical task?" },
    }).returning();
    return { companyId, agentId, issueId, card: card! };
  }

  it.each(["done", "cancelled"] as const)("archives an already %s task and expires its historical card exactly once", async (status) => {
    const fixture = await seedHistoricalIssue(status);
    const completedAt = status === "done" ? terminalAt : null;
    const cancelledAt = status === "cancelled" ? terminalAt : null;
    const hiddenAt = new Date();
    const deferredTerminalInteractionTelemetry = { interactionIds: [] as string[] };
    const updated = await issueService(db).update(fixture.issueId, {
      hiddenAt, actorUserId: "local-board",
    }, undefined, undefined, undefined, { deferredTerminalInteractionTelemetry });

    expect(await issueThreadInteractionService(db).getById(fixture.card.id)).toMatchObject({
      status: "expired", resolvedByUserId: "local-board",
      result: { version: 1, outcome: "issue_closed" },
    });
    expect(updated).toMatchObject({ status, statusVersion: 7, completedAt, cancelledAt, hiddenAt });
    expect(await issueService(db).getById(fixture.issueId)).toMatchObject({
      status, statusVersion: 7, completedAt, cancelledAt, hiddenAt,
    });
    const resolved = await issueThreadInteractionService(db).getById(fixture.card.id);
    await issueService(db).update(fixture.issueId, { hiddenAt: null, actorUserId: "local-board" },
      undefined, undefined, undefined, { deferredTerminalInteractionTelemetry });
    expect(deferredTerminalInteractionTelemetry.interactionIds).toEqual([fixture.card.id]);
    expect(await issueThreadInteractionService(db).getById(fixture.card.id)).toEqual(resolved);
    expect(await issueService(db).getById(fixture.issueId)).toMatchObject({
      status, statusVersion: 7, completedAt, cancelledAt, hiddenAt: null,
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.companyId))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toEqual([]);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.companyId),
      eq(activityLog.action, "issue.thread_interaction_expired"),
    ))).toEqual([expect.objectContaining({ details: expect.objectContaining({
      reconciledWithoutStatusChange: true, interactionId: fixture.card.id,
    }) })]);
  });

  it("preserves pending cards on open issues during metadata updates and another company's reconciliation", async () => {
    const open = await seedHistoricalIssue("todo");
    const terminal = await seedHistoricalIssue("done");
    await issueService(db).update(open.issueId, { hiddenAt: new Date(), actorUserId: "local-board" });
    await issueService(db).update(terminal.issueId, { hiddenAt: new Date(), actorUserId: "local-board" });
    expect(await issueThreadInteractionService(db).getById(terminal.card.id)).toMatchObject({ status: "expired" });
    expect(await issueThreadInteractionService(db).getById(open.card.id)).toMatchObject({
      status: "pending", resolvedAt: null, result: null,
    });
    expect(await issueService(db).getById(open.issueId)).toMatchObject({ status: "todo", statusVersion: 7 });
  });

  it("revokes pending and approved linked tool requests while preserving already executing requests", async () => {
    const fixture = await seedHistoricalIssue("cancelled");
    const [invocation] = await db.insert(toolInvocations).values({
      companyId: fixture.companyId, issueId: fixture.issueId, toolName: "fixture_action",
    }).returning();
    const requests = await db.insert(toolActionRequests).values(
      (["pending", "approved", "executing"] as const).map((status) => ({
        companyId: fixture.companyId, invocationId: invocation!.id,
        issueId: fixture.issueId, interactionId: fixture.card.id, status,
        canonicalArgumentsHash: "fixture-hash", canonicalArgumentsSummary: { summary: "Fixture only" },
      })),
    ).returning();
    await issueService(db).update(fixture.issueId, { hiddenAt: new Date(), actorUserId: "local-board" });
    for (const request of requests) {
      const [persisted] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request.id));
      expect(persisted?.status).toBe(request.status === "executing" ? "executing" : "expired");
    }
  });

  it("expires the linked secret proposal and scrubs its ciphertext without creating a new run", async () => {
    const fixture = await seedHistoricalIssue("cancelled");
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId, agentId: fixture.agentId, status: "succeeded",
    }).returning();
    const [proposal] = await db.insert(companySecretProposals).values({
      companyId: fixture.companyId, kind: "secret", status: "pending",
      proposedName: "Fixture secret", proposedKey: "fixture/secret", justification: "Fixture only",
      valueCiphertext: { fixture: "not-a-real-secret" }, proposedByAgentId: fixture.agentId,
      originIssueId: fixture.issueId, originRunId: run!.id, interactionId: fixture.card.id,
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    await db.update(issueThreadInteractions).set({ payload: {
      version: 1, prompt: "Historical secret request", secretProposal: {
        version: 1, proposalId: proposal!.id, sourceSecretLabel: "fixture/secret",
        configPath: "env.FIXTURE_TOKEN", targetAgentId: fixture.agentId, targetAgentName: "Historical task owner",
        justification: "Fixture only", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    } }).where(eq(issueThreadInteractions.id, fixture.card.id));
    await issueService(db).update(fixture.issueId, { hiddenAt: new Date(), actorUserId: "local-board" });
    const [persisted] = await db.select().from(companySecretProposals).where(eq(companySecretProposals.id, proposal!.id));
    expect(persisted).toMatchObject({ status: "expired", valueCiphertext: null, ciphertextScrubbedAt: expect.any(Date) });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.companyId))).toEqual([run]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toEqual([]);
  });
});
