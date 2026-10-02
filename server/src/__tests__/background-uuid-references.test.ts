import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRunEvents,
  heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { canonicalUuidTextReference } from "../services/canonical-uuid-text-reference.js";
import { conversationRecoveryActionPredicate } from "../services/conversation-continuation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const cases = ["canonical", "uppercase", "without-dashes", "braced", "trailing-newline", "invalid", "empty", "missing", "null", "object", "number"] as const;
type ReferenceCase = typeof cases[number];

function reference(kind: ReferenceCase, id: string): unknown {
  switch (kind) {
    case "canonical": return id;
    case "uppercase": return id.toUpperCase();
    case "without-dashes": return id.replaceAll("-", "");
    case "braced": return `{${id}}`;
    case "trailing-newline": return `${id}\n`;
    case "invalid": return "not-a-uuid";
    case "empty": return "";
    case "missing": return undefined;
    case "null": return null;
    case "object": return { id };
    case "number": return 123;
  }
}

(support.supported ? describe : describe.skip)("background UUID references", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-background-uuid-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reference test", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test agent", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Target" });
    const addRun = async (patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const [run] = await db.insert(heartbeatRuns).values({
        id: `a${randomUUID().slice(1)}`, companyId, agentId,
        status: "interrupted", runtimeMode: "legacy", contextSnapshot: { issueId },
        runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } }, ...patch,
      }).returning();
      return run!;
    };
    const addAction = async (evidence: Record<string, unknown>, patch: Partial<typeof issueRecoveryActions.$inferInsert> = {}) => {
      const [action] = await db.insert(issueRecoveryActions).values({
        companyId, sourceIssueId: issueId, kind: "execution_recovery",
        cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
        nextAction: "Retain evidence", evidence, ...patch,
      }).returning();
      return action!;
    };
    const matches = async (id: string) => db.select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, id), conversationRecoveryActionPredicate()));
    return { companyId, agentId, issueId, addRun, addAction, matches };
  }

  it.each(cases)("preserves recovery run identity for a %s reference without throwing", async (kind) => {
    const f = await fixture(), run = await f.addRun();
    const raw = reference(kind, run.id);
    const action = await f.addAction(raw === undefined ? {} : { runId: raw });
    const priorMatch = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .innerJoin(issueRecoveryActions, sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`)
      .where(eq(issueRecoveryActions.id, action.id));
    const actual = await f.matches(action.id);
    expect(actual.length).toBe(priorMatch.length);
    expect(actual.length).toBe(kind === "canonical" ? 1 : 0);
  });

  it("retains recovery tenant isolation for a valid foreign run reference", async () => {
    const f = await fixture(), foreign = await fixture(), run = await foreign.addRun();
    const action = await f.addAction({ runId: run.id });
    expect(await f.matches(action.id)).toEqual([]);
  });

  it("retains native issue precedence over conflicting legacy issue evidence", async () => {
    const f = await fixture(), otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Other" });
    const run = await f.addRun({ nativeIssueId: otherIssueId });
    const action = await f.addAction({ runId: run.id });
    expect(await f.matches(action.id)).toEqual([]);
  });

  it("does not retire a non-conversation hold based on a valid run reference", async () => {
    const f = await fixture(), run = await f.addRun({ runnerProfileJson: { adapterDispatch: { adapterType: "process" } } });
    const action = await f.addAction({ runId: run.id });
    expect(await f.matches(action.id)).toEqual([]);
  });

  it("continues to use historical conversation adapter evidence", async () => {
    const f = await fixture(), run = await f.addRun({ runnerProfileJson: null });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: run.id, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "kimi_local" } });
    const action = await f.addAction({ runId: run.id });
    expect(await f.matches(action.id)).toEqual([{ id: action.id }]);
  });

  it("retains unrelated recovery causes", async () => {
    const f = await fixture(), run = await f.addRun();
    const action = await f.addAction({ runId: run.id }, { cause: "process_lost" });
    expect(await f.matches(action.id)).toEqual([]);
  });

  it.each(cases)("preserves a %s coalesced owner reference and the self-owner fallback", async (kind) => {
    const f = await fixture(), ownerId = `a${randomUUID().slice(1)}`, receiptId = randomUUID();
    const raw = reference(kind, ownerId);
    await db.insert(agentWakeupRequests).values([
      { id: ownerId, companyId: f.companyId, agentId: f.agentId, source: "assignment" },
      { id: receiptId, companyId: f.companyId, agentId: f.agentId, source: "assignment", payload: raw === undefined ? {} : { coalescedIntoWakeupRequestId: raw } },
    ]);
    const owner = alias(agentWakeupRequests, "owner");
    const text = sql`coalesce(${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId', ${agentWakeupRequests.id}::text)`;
    const scope = and(eq(agentWakeupRequests.id, receiptId), eq(owner.companyId, f.companyId));
    const before = await db.select({ id: owner.id }).from(agentWakeupRequests)
      .innerJoin(owner, sql`${owner.id}::text = ${text}`).where(scope);
    const after = await db.select({ id: owner.id }).from(agentWakeupRequests)
      .innerJoin(owner, eq(owner.id, canonicalUuidTextReference(text))).where(scope);
    expect(after).toEqual(before);
    expect(after).toEqual(kind === "canonical" ? [{ id: ownerId }] : kind === "missing" || kind === "null" ? [{ id: receiptId }] : []);
  });

  it("does not accept a coalesced owner in a different company", async () => {
    const f = await fixture(), foreign = await fixture(), ownerId = randomUUID(), receiptId = randomUUID();
    await db.insert(agentWakeupRequests).values([
      { id: ownerId, companyId: foreign.companyId, agentId: foreign.agentId, source: "assignment" },
      { id: receiptId, companyId: f.companyId, agentId: f.agentId, source: "assignment", payload: { coalescedIntoWakeupRequestId: ownerId } },
    ]);
    const owner = alias(agentWakeupRequests, "owner");
    const text = sql`coalesce(${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId', ${agentWakeupRequests.id}::text)`;
    const result = await db.select({ id: owner.id }).from(agentWakeupRequests)
      .innerJoin(owner, eq(owner.id, canonicalUuidTextReference(text)))
      .where(and(eq(agentWakeupRequests.id, receiptId), eq(owner.companyId, f.companyId)));
    expect(result).toEqual([]);
  });
});
