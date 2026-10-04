import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, issues, issueComments, issueCommentRequestEffects, createDb, closeRegisteredClients,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
const state = vi.hoisted(() => ({ barrier: null as any }));
vi.mock("../services/startup-work-barrier.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/startup-work-barrier.js")>();
  return { ...actual, isStartupWorkHeld: () => state.barrier?.isHeld() ?? false,
    assertStartupWorkAllowed: () => state.barrier?.assertWorkAllowed() };
});
import { createStartupWorkBarrier } from "../services/startup-work-barrier.js";
import { issueCommentRequestService } from "../services/issue-comment-requests.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
suite("startup hold preserves durable protocol backlog", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-held-protocol-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { state.barrier = null; await closeRegisteredClients(database.connectionString); await database.cleanup(); });
  it("blocks direct admission and effect claims while held, then resumes the same accepted request exactly once", async () => {
    const companyId = randomUUID(); const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "held fixture", issuePrefix: "HLD" });
    await db.insert(issues).values({ id: issueId, companyId, title: "pending accepted intent" });
    const input = { companyId, issueId, authorUserId: "local-board", actorSource: "local_implicit", clientRequestId: randomUUID(), body: "accepted before restart" };
    const execute = vi.fn(async () => ({ delivered: true }));
    const service = () => issueCommentRequestService(db, { authorize: async () => true,
      controls: () => ({ admission: true, dispatch: true }), handlers: { references: { transaction: execute } } });
    const accepted = await service().admit(input, async tx => {
      const [comment] = await tx.insert(issueComments).values({ companyId, issueId, authorUserId: input.authorUserId,
        authorType: "user", clientRequestId: input.clientRequestId, body: input.body }).returning();
      return { commentId: comment.id, effects: [{ kind: "references", descriptor: {} }] };
    });
    state.barrier = createStartupWorkBarrier({ PAPERCLIP_STARTUP_WORK_HELD: "true" });
    const persist = vi.fn();
    await expect(service().admit({ ...input, clientRequestId: randomUUID() }, persist)).rejects.toMatchObject({ status: 503 });
    expect(persist).not.toHaveBeenCalled();
    await service().dispatchOne(companyId, accepted.request.id);
    const [pending] = await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(pending).toMatchObject({ status: "pending", attemptCount: 0 }); expect(execute).not.toHaveBeenCalled();
    const boot = state.barrier.snapshot();
    state.barrier.release({ expectedBootId: boot.bootId, expectedGeneration: boot.generation, qualificationSha256: "a".repeat(64) });
    await service().dispatchOne(companyId, accepted.request.id);
    await service().dispatchOne(companyId, accepted.request.id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.id, pending.id)))[0].status).toBe("delivered");
  });
});
