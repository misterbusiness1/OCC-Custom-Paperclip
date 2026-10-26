import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, toolAccessAuditEvents, toolApplications, toolCallEvents, toolConnections } from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("runtime MCP diagnostic audit boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let stop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const fixture = await startEmbeddedPostgresTestDatabase("gateway-diagnostic-audit");
    db = createDb(fixture.connectionString);
    stop = fixture.stop;
  });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolCallEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });
  afterAll(async () => { await stop?.(); });

  async function seed(input: { fixture?: boolean; spoofedName?: boolean } = {}) {
    const [company] = await db.insert(companies).values({ name: `Diagnostic ${randomUUID()}`, issuePrefix: `DG${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: input.spoofedName ? "Smoke Lab fixture agent" : "Diagnostic agent", role: "engineer", adapterType: "process" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "manual", status: "running", contextSnapshot: { fixture: true, auditScope: "fixture" } }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: input.fixture ? "paperclip.smoke-lab.http-fixture" : `real-${randomUUID()}`, name: input.spoofedName ? "Smoke Lab HTTP fixture" : "Application", type: "mcp_http", status: "active", metadata: input.fixture ? { smokeLab: true } : {} }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: application.name, uid: `diagnostic/${randomUUID()}`, transport: "mcp_remote", status: "active", enabled: true, config: {} }).returning();
    return { company, agent, run, connection };
  }
  const gateway = () => createToolGatewayService(db, { toolActionSigningSecret: "synthetic-diagnostic-test-secret" });

  it("writes a diagnostic instead of a failed successful call, without a tool invocation", async () => {
    const f = await seed();
    await gateway().recordRuntimeMcpDeliveryDiagnostic({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id, permittedNotInstalledConnections: [{ id: f.connection.id, name: f.connection.name }] });
    const [row] = await db.select().from(toolAccessAuditEvents);
    expect(row).toMatchObject({ action: "runtime_diagnostic", outcome: "diagnostic", reasonCode: "permitted_connections_not_installed", details: { eventCategory: "diagnostic", auditClassificationVersion: 1, auditScope: "production", fixtureScopeAuthoritative: false, permittedNotInstalledCount: 1 } });
    expect(await db.select().from(toolCallEvents)).toEqual([]);
    const [activity] = await db.select().from(activityLog);
    expect(activity).toMatchObject({ action: "tool_gateway.runtime_mcp_delivery", details: { eventCategory: "diagnostic", auditScope: "production" } });
  });
  it("tags persisted Smoke Lab metadata only as a non-authoritative candidate", async () => {
    const f = await seed({ fixture: true });
    await gateway().recordRuntimeMcpDeliveryDiagnostic({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id, permittedNotInstalledConnections: [{ id: f.connection.id, name: f.connection.name }] });
    const [row] = await db.select().from(toolAccessAuditEvents);
    expect(row).toMatchObject({ action: "runtime_diagnostic", outcome: "diagnostic", details: { auditScope: "fixture_candidate", fixtureCandidateConnectionIds: [f.connection.id], fixtureScopeAuthoritative: false } });
  });
  it("does not trust a Smoke Lab display name or caller-controlled run context", async () => {
    const f = await seed({ spoofedName: true });
    await gateway().recordRuntimeMcpDeliveryDiagnostic({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id, permittedNotInstalledConnections: [{ id: f.connection.id, name: f.connection.name }] });
    const [row] = await db.select().from(toolAccessAuditEvents);
    expect(row.details).toMatchObject({ auditScope: "production", fixtureCandidateConnectionIds: [] });
  });
  it("does not borrow foreign-company fixture metadata", async () => {
    const own = await seed();
    const foreign = await seed({ fixture: true });
    await gateway().recordRuntimeMcpDeliveryDiagnostic({ companyId: own.company.id, agentId: own.agent.id, runId: own.run.id, permittedNotInstalledConnections: [{ id: foreign.connection.id, name: "unresolved connection" }] });
    const [row] = await db.select().from(toolAccessAuditEvents);
    expect(row).toMatchObject({ companyId: own.company.id, details: { auditScope: "unknown", unresolvedConnectionCount: 1, fixtureCandidateConnectionIds: [] } });
  });
  it("refuses a mismatched run identity before writing diagnostic rows", async () => {
    const f = await seed();
    await expect(gateway().recordRuntimeMcpDeliveryDiagnostic({ companyId: randomUUID(), agentId: f.agent.id, runId: f.run.id, permittedNotInstalledConnections: [{ id: f.connection.id, name: f.connection.name }] })).rejects.toThrow("run identity mismatch");
    expect(await db.select().from(toolAccessAuditEvents)).toEqual([]);
    expect(await db.select().from(activityLog)).toEqual([]);
  });
  it("does not emit a diagnostic when no permitted connection is missing", async () => {
    const f = await seed();
    await gateway().recordRuntimeMcpDeliveryDiagnostic({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id, permittedNotInstalledConnections: [] });
    expect(await db.select().from(toolAccessAuditEvents)).toEqual([]);
  });
});
