import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, environmentLeases, heartbeatRunEvents,
  heartbeatRuns, issues,
} from "@paperclipai/db";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("conversation ownership issue matching", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-conversation-ownership-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ownership test", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test agent", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Target" },
      { id: otherIssueId, companyId, title: "Other" },
    ]);
    const addRun = async (patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId, status: "failed", runtimeMode: "legacy",
        contextSnapshot: { issueId }, processPid: process.pid,
        runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
        ...patch,
      }).returning();
      return run!;
    };
    return { companyId, agentId, issueId, otherIssueId, addRun };
  }

  it.each([
    ["target", "target", true],
    ["target", "other", true],
    ["target", "missing", true],
    ["other", "target", false],
    ["other", "missing", false],
    ["none", "target", true],
    ["none", "other", false],
    ["none", "missing", false],
    ["none", "malformed", false],
  ] as const)("native=%s context=%s retains the correct owner (%s)", async (native, context, expected) => {
    const f = await fixture();
    const contextSnapshot = context === "missing" ? {} : {
      issueId: context === "target" ? f.issueId : context === "other" ? f.otherIssueId : "not-a-uuid",
    };
    const run = await f.addRun({ nativeIssueId: native === "none" ? null : native === "target" ? f.issueId : f.otherIssueId, contextSnapshot });
    const result = await getConversationOwnershipBlocker(db, f.companyId, f.issueId);
    if (expected) expect(result).toMatchObject({ runId: run.id, agentId: f.agentId, cause: "execution_owner_active" });
    else expect(result).toBeNull();
  });

  it("does not match an issue identifier carried by another company's run", async () => {
    const target = await fixture(), foreign = await fixture();
    await foreign.addRun({ contextSnapshot: { issueId: target.issueId } });
    expect(await getConversationOwnershipBlocker(db, target.companyId, target.issueId)).toBeNull();
  });

  it.each(["failed", "timed_out", "interrupted", "cancelled"])("retains a live owner after %s", async (status) => {
    const f = await fixture(), run = await f.addRun({ status });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: run.id });
  });

  it("does not classify a successful run as an ownership blocker", async () => {
    const f = await fixture(); await f.addRun({ status: "succeeded" });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("does not retain a dead process without an environment lease", async () => {
    const f = await fixture(); await f.addRun({ processPid: 2147483647 });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each([
    ["active", null, null, true],
    ["pending_cleanup", new Date(0), null, true],
    ["released", new Date(0), "failed", true],
    ["released", new Date(0), "complete", false],
  ] as const)("respects lease status=%s releasedAt=%s cleanup=%s", async (status, releasedAt, cleanupStatus, expected) => {
    const f = await fixture(), run = await f.addRun({ processPid: null });
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: run.id, status, releasedAt, cleanupStatus });
    const result = await getConversationOwnershipBlocker(db, f.companyId, f.issueId);
    if (expected) expect(result).toMatchObject({ runId: run.id, cause: "execution_owner_active" });
    else expect(result).toBeNull();
  });

  it("uses historical adapter evidence when the runner profile is missing", async () => {
    const f = await fixture(), run = await f.addRun({ runnerProfileJson: null });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: run.id, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "kimi_local" } });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: run.id });
  });

  it("does not infer conversation ownership from unrelated adapter evidence", async () => {
    const f = await fixture();
    await f.addRun({ runnerProfileJson: { adapterDispatch: { adapterType: "process" } } });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
});
