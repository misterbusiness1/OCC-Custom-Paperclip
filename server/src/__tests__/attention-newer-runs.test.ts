import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { listLatestAttentionRunTimes } from "../services/attention-newer-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

(support.supported ? describe : describe.skip)("newer runs for failed-run attention", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-attention-newer-runs-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Attention test", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values([agentId, otherAgentId].map(id => ({ id, companyId, name: "Test agent", role: "engineer", status: "idle", adapterType: "codex_local" })));
    const add = async (patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId, status: "succeeded", runtimeMode: "legacy",
        contextSnapshot: { issueId }, createdAt: at(1), ...patch,
      }).returning();
      return run!;
    };
    const find = (id: string | null = issueId, after = at(0)) => listLatestAttentionRunTimes(db, companyId, [{ agentId, issueId: id, after }]);
    return { companyId, agentId, otherAgentId, issueId, add, find };
  }

  it("returns nothing for an empty candidate list or an absent newer run", async () => {
    const f = await fixture();
    expect(await listLatestAttentionRunTimes(db, f.companyId, [])).toEqual([]);
    expect(await f.find()).toEqual([]);
  });

  it.each([-1, 0])("does not supersede a failure with a run at offset %s", async seconds => {
    const f = await fixture(); await f.add({ createdAt: at(seconds) });
    expect(await f.find()).toEqual([]);
  });

  it.each([
    ["primary", true], ["legacy", true], ["null-primary", true],
    ["conflicting-primary", false], ["empty-primary", false], ["numeric-primary", false],
  ] as const)("preserves %s issue identity semantics", async (kind, matches) => {
    const f = await fixture();
    const contextSnapshot = kind === "primary" ? { issueId: f.issueId }
      : kind === "legacy" ? { taskId: f.issueId }
      : { issueId: kind === "null-primary" ? null : kind === "conflicting-primary" ? randomUUID() : kind === "empty-primary" ? "" : 123, taskId: f.issueId };
    await f.add({ contextSnapshot });
    expect(await f.find()).toEqual(matches ? [{ agentId: f.agentId, issueId: f.issueId, createdAt: at(1) }] : []);
  });

  it.each([
    ["missing", true], ["nulls", true], ["empty-primary", true], ["empty-task", true],
    ["empty-primary-with-task", true], ["real-issue", false], ["legacy-issue", false],
    ["numeric-primary", false], ["boolean-primary", false],
  ] as const)("preserves the no-issue group for %s contexts", async (kind, matches) => {
    const f = await fixture();
    const contextSnapshot = kind === "missing" ? {}
      : kind === "nulls" ? { issueId: null, taskId: null }
      : kind === "empty-primary" ? { issueId: "" }
      : kind === "empty-task" ? { taskId: "" }
      : kind === "empty-primary-with-task" ? { issueId: "", taskId: f.issueId }
      : kind === "real-issue" ? { issueId: f.issueId }
      : kind === "legacy-issue" ? { taskId: f.issueId }
      : { issueId: kind === "numeric-primary" ? 123 : false };
    await f.add({ contextSnapshot });
    expect(await f.find(null)).toEqual(matches ? [{ agentId: f.agentId, issueId: null, createdAt: at(1) }] : []);
  });

  it.each([[1, 2, 2], [3, 2, 3], [2, 2, 2]])("chooses the latest primary (%s) or fallback (%s) timestamp", async (primary, fallback, expected) => {
    const f = await fixture();
    await f.add({ createdAt: at(primary) });
    await f.add({ contextSnapshot: { taskId: f.issueId }, createdAt: at(fallback) });
    expect(await f.find()).toEqual([{ agentId: f.agentId, issueId: f.issueId, createdAt: at(expected) }]);
  });

  it("does not let another agent's newer run supersede this agent's failure", async () => {
    const f = await fixture(); await f.add({ agentId: f.otherAgentId });
    expect(await f.find()).toEqual([]);
  });

  it("enforces company scope even when given an agent ID from another company", async () => {
    const f = await fixture(), foreign = await fixture();
    await foreign.add({ contextSnapshot: { issueId: f.issueId } });
    expect(await listLatestAttentionRunTimes(db, f.companyId, [{ agentId: foreign.agentId, issueId: f.issueId, after: at(0) }])).toEqual([]);
  });

  it.each(["succeeded", "failed", "timed_out", "cancelled", "interrupted", "running", "queued"])("preserves newer-run suppression regardless of %s status", async status => {
    const f = await fixture(); await f.add({ status });
    expect(await f.find()).toHaveLength(1);
  });

  it("deduplicates repeated failure scopes using their earliest cutoff", async () => {
    const f = await fixture(); await f.add();
    const rows = await listLatestAttentionRunTimes(db, f.companyId, [
      { agentId: f.agentId, issueId: f.issueId, after: at(2) },
      { agentId: f.agentId, issueId: f.issueId, after: at(0) },
    ]);
    expect(rows).toEqual([{ agentId: f.agentId, issueId: f.issueId, createdAt: at(1) }]);
    expect(rows[0]!.createdAt > at(0)).toBe(true);
    expect(rows[0]!.createdAt > at(2)).toBe(false);
  });

  it("keeps millisecond precision consistent with the alert timestamp comparison", async () => {
    const f = await fixture();
    const run = await f.add({ createdAt: at(0) });
    await db.update(heartbeatRuns).set({ createdAt: sql`'2026-01-01T00:00:00.000900Z'::timestamptz` })
      .where(eq(heartbeatRuns.id, run.id));
    const rows = await f.find();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAt.getTime()).toBe(at(0).getTime());
    expect(rows[0]!.createdAt > at(0)).toBe(false);
  });

  it("does not truncate more than one batch of unique issue scopes", async () => {
    const f = await fixture(), ids = Array.from({ length: 205 }, () => randomUUID());
    await db.insert(heartbeatRuns).values(ids.map(issueId => ({
      companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "legacy",
      createdAt: at(1), contextSnapshot: { issueId },
    })));
    const rows = await listLatestAttentionRunTimes(db, f.companyId, ids.map(issueId => ({ agentId: f.agentId, issueId, after: at(0) })));
    expect(rows.map(row => row.issueId).sort()).toEqual(ids.sort());
  });

  it("excludes unrelated recent contexts and returns only the requested run times", async () => {
    const f = await fixture(); await f.add({ contextSnapshot: { issueId: f.issueId, prompt: "private context".repeat(5_000) } });
    await db.insert(heartbeatRuns).values(Array.from({ length: 25 }, () => ({
      companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "legacy",
      createdAt: at(2), contextSnapshot: { issueId: randomUUID(), prompt: "unrelated private context".repeat(1_000) },
    })));
    const rows = await f.find();
    expect(rows).toEqual([{ agentId: f.agentId, issueId: f.issueId, createdAt: at(1) }]);
    expect(JSON.stringify(rows)).not.toContain("private context");
  });
});
