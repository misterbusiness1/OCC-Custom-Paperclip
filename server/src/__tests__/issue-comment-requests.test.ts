import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, agentWakeupRequests, heartbeatRuns, companies, instanceSettings, createDb, issues, issueComments, issueCommentRequests, issueCommentRequestEffects,
  closeRegisteredClients, startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport,
} from "@paperclipai/db";
import { assertCommentRequestRollbackSafe, issueCommentRequestService, type CommentRequestInput } from "../services/issue-comment-requests.js";

import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { admitBoardCommentCancellation } from "../services/board-comment-cancellation.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
const defer = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

suite("durable Board comment request admission and delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-request-");
    // Tiny independent pools expose accidental nested-pool transaction deadlocks.
    first = createDb(database.connectionString, { maxConnections: 1 });
    second = createDb(database.connectionString, { maxConnections: 1 });
  }, 30_000);
  afterAll(async () => {
    if (database) { await closeRegisteredClients(database.connectionString); await database.cleanup(); }
  });
  async function seed() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await first.insert(companies).values({ id: companyId, name: "Request fixture", issuePrefix: `Q${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await first.insert(issues).values({ id: issueId, companyId, title: "Request fixture", status: "done", priority: "medium" });
    return { companyId, issueId, authorUserId: "board-fixture", clientRequestId: randomUUID(), body: "Original approved intent", interrupt: true } satisfies CommentRequestInput;
  }
  const service = (db: typeof first) => issueCommentRequestService(db, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => true, handlers: {} });
  function persist(input: CommentRequestInput, hook?: () => Promise<void>) {
    return async (tx: Parameters<Parameters<typeof first.transaction>[0]>[0]) => {
      await hook?.();
      const [comment] = await tx.insert(issueComments).values({ companyId: input.companyId, issueId: input.issueId, authorUserId: input.authorUserId, authorType: "user", clientRequestId: input.clientRequestId, body: input.body }).returning();
      await tx.update(issues).set({ status: "todo" }).where(eq(issues.id, input.issueId));
      return { commentId: comment!.id, effects: [{ kind: "references" as const, descriptor: { issueId: input.issueId } }] };
    };
  }

  it("commits the retained protocol floor atomically with acceptance, never on rejection", async () => {
    const floor = async () => (await first.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0].minimumBoardCommentRequestProtocolVersion;
    expect(await floor()).toBe(0);
    const input = await seed();
    await expect(service(first).admit(input, async (tx) => {
      await persist(input)(tx); throw new Error("before watermark");
    })).rejects.toThrow("before watermark");
    expect(await floor()).toBe(0);
    // The closed kind constraint fails after the ledger row and watermark were
    // written, exercising the opposite side of the same transaction boundary.
    await expect(service(first).admit(input, async (tx) => ({ ...await persist(input)(tx),
      effects: [{ kind: "invalid_fixture_kind" as "references", descriptor: {} }],
    }))).rejects.toThrow();
    expect(await floor()).toBe(0);
    expect(await first.select().from(issueCommentRequests).where(eq(issueCommentRequests.issueId, input.issueId))).toHaveLength(0);
    expect(await first.select().from(issueComments).where(eq(issueComments.issueId, input.issueId))).toHaveLength(0);
    const denied = issueCommentRequestService(first, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => false, handlers: {} });
    await expect(denied.admit(input, persist(input))).rejects.toMatchObject({ status: 403 });
    expect(await floor()).toBe(0);
    await expect(assertCommentRequestRollbackSafe(first, 0)).resolves.toBeUndefined();
  });

  it("recovers late authoritative receipts with bounded inspection and no repeated external action", async () => {
    const input = await seed(); let clock = Date.now(); let executions = 0; let inspections = 0; let proven = false;
    const delivery = issueCommentRequestService(first, { now: () => new Date(clock),
      controls: () => ({ admission: true, dispatch: true }), authorize: async () => true,
      handlers: { wake: { execute: async () => { executions++; throw new Error("lost completion"); },
        reconcile: async () => { inspections++; return proven ? { durableAdmission: true } : null; } } } });
    const accepted = await delivery.admit(input, async tx => ({ ...await persist(input)(tx), effects: [{ kind: "wake", descriptor: {} }] }));
    await delivery.dispatchOne(input.companyId, accepted.request.id);
    await delivery.dispatchOne(input.companyId, accepted.request.id);
    expect(executions).toBe(1); expect(inspections).toBe(1);
    proven = true; clock += 31_000;
    await delivery.dispatchOne(input.companyId, accepted.request.id);
    const [effect] = await first.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(effect.status).toBe("delivered"); expect(executions).toBe(1); expect(inspections).toBe(2);
  });
  it("stops automatic ambiguous receipt inspection after eight attempts", async () => {
    const input = await seed(); let clock = Date.now(); let executions = 0; let inspections = 0;
    const delivery = issueCommentRequestService(first, { now: () => new Date(clock),
      controls: () => ({ admission: true, dispatch: true }), authorize: async () => true,
      handlers: { wake: { execute: async () => { executions++; return null as never; },
        reconcile: async () => { inspections++; return null; } } } });
    const accepted = await delivery.admit(input, async tx => ({ ...await persist(input)(tx), effects: [{ kind: "wake", descriptor: {} }] }));
    for (let i = 0; i < 12; i++) { clock += 31_000; await delivery.dispatchOne(input.companyId, accepted.request.id); }
    const [effect] = await first.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(effect.status).toBe("reconciliation_required"); expect(effect.attemptCount).toBe(8);
    expect(executions).toBe(1); expect(inspections).toBe(7);
  });

  it("renews a live external claim without replaying or reconciling it prematurely", async () => {
    const input = await seed(); const entered = defer(); const release = defer();
    let executions = 0; let reconciliations = 0;
    const handlers = { wake: { execute: async () => { executions++; entered.resolve(); await release.promise; return { accepted: true }; },
      reconcile: async () => { reconciliations++; return null; } } };
    const options = { controls: () => ({ admission: true, dispatch: true }), authorize: async () => true, handlers, staleClaimMs: 120 };
    const one = issueCommentRequestService(first, options); const two = issueCommentRequestService(second, options);
    const accepted = await one.admit(input, async tx => ({ ...await persist(input)(tx), effects: [{ kind: "wake", descriptor: {} }] }));
    const delivery = one.dispatchOne(input.companyId, accepted.request.id); await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 280));
    await two.dispatchOne(input.companyId, accepted.request.id);
    expect(executions).toBe(1); expect(reconciliations).toBe(0);
    release.resolve(); await delivery;
    const [effect] = await first.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(effect.status).toBe("delivered"); expect(effect.generation).toBe(1);
  });

  it("serializes actual simultaneous first writers across independent clients", async () => {
    const input = await seed();
    const admitted = defer(); const release = defer();
    let winners = 0;
    const a = service(first).admit(input, persist(input, async () => { winners++; admitted.resolve(); await release.promise; }));
    await admitted.promise;
    let followerDone = false;
    const b = service(second).admit(input, persist(input, async () => { winners++; })).finally(() => { followerDone = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(followerDone).toBe(false);
    release.resolve();
    const [winner, follower] = await Promise.all([a, b]);
    expect(winners).toBe(1);
    expect((await first.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0].minimumBoardCommentRequestProtocolVersion).toBe(1);
    expect(winner.duplicate).toBe(false);
    expect(follower.duplicate).toBe(true);
    expect(follower.request.id).toBe(winner.request.id);
    expect(follower.request.commentId).toBe(winner.request.commentId);
    expect(await first.select().from(issueComments).where(eq(issueComments.issueId, input.issueId))).toHaveLength(1);
    expect(await first.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, winner.request.id))).toHaveLength(1);
  });

  it.each(["body", "interrupt", "resume", "reopen", "attachments"])("rejects conflicting concurrent first-writer %s without follower effects", async (field) => {
    const input = await seed(); const entered = defer(); const release = defer();
    const conflicting = { ...input, ...(field === "body" ? { body: "different" } : field === "attachments" ? { attachmentIds: [randomUUID()] } : { [field]: field === "interrupt" ? false : true }) };
    const a = service(first).admit(input, persist(input, async () => { entered.resolve(); await release.promise; }));
    await entered.promise;
    let followers = 0;
    const b = service(second).admit(conflicting, persist(conflicting, async () => { followers++; })).catch((error) => error);
    release.resolve(); await a;
    const error = await b;
    expect(error.status).toBe(409);
    expect(followers).toBe(0);
  });

  it("does not serialize independent issues", async () => {
    const input = await seed(); const other = await seed(); const entered = defer(); const release = defer();
    const a = service(first).admit(input, persist(input, async () => { entered.resolve(); await release.promise; }));
    await entered.promise;
    const independent = await service(second).admit(other, persist(other));
    expect(independent.duplicate).toBe(false);
    release.resolve(); await a;
  });

  it("recovers committed intent on a recreated service and does not repeat a settled database effect", async () => {
    const input = await seed();
    const accepted = await service(first).admit(input, persist(input));
    let executions = 0;
    const recovered = issueCommentRequestService(second, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => true, handlers: {
      references: { transaction: async (tx, request) => { executions++; await tx.update(issues).set({ description: "delivered once" }).where(eq(issues.id, request.issueId)); return { synchronized: true }; } },
    } });
    await recovered.dispatchOne(input.companyId, accepted.request.id);
    await recovered.dispatchOne(input.companyId, accepted.request.id);
    expect(executions).toBe(1);
    const [request] = await first.select().from(issueCommentRequests).where(eq(issueCommentRequests.id, accepted.request.id));
    expect(request.status).toBe("delivered");
    expect((await service(first).admit(input, persist(input))).duplicate).toBe(true);
  });

  it("rolls back database effect and receipt together on failure", async () => {
    const input = await seed(); const accepted = await service(first).admit(input, persist(input));
    const delivery = issueCommentRequestService(second, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => true, handlers: { references: { transaction: async (tx, request) => {
      await tx.update(issues).set({ description: "must roll back" }).where(eq(issues.id, request.issueId)); throw new Error("fault before receipt");
    } } } });
    await expect(delivery.dispatchOne(input.companyId, accepted.request.id)).rejects.toThrow("fault before receipt");
    const [issue] = await first.select().from(issues).where(eq(issues.id, input.issueId));
    const [effect] = await first.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(issue.description).toBeNull(); expect(effect.status).toBe("pending");
  });

  it("does not replay ambiguous external work", async () => {
    const input = await seed(); const accepted = await service(first).admit(input, persist(input)); let executions = 0;
    const delivery = issueCommentRequestService(second, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => true, handlers: { references: { execute: async () => { executions++; throw new Error("connection lost after external acceptance"); } } } });
    await delivery.dispatchOne(input.companyId, accepted.request.id);
    await delivery.dispatchOne(input.companyId, accepted.request.id);
    expect(executions).toBe(1);
    const [request] = await first.select().from(issueCommentRequests).where(eq(issueCommentRequests.id, accepted.request.id));
    expect(request.status).toBe("reconciliation_required");
  });

  it.each(["deleted", "revoked", "edited"])("blocks delivery after comment is %s", async (reason) => {
    const input = await seed(); const accepted = await service(first).admit(input, persist(input));
    if (reason === "deleted") await first.update(issueComments).set({ deletedAt: new Date(), body: "" }).where(eq(issueComments.id, accepted.request.commentId));
    if (reason === "edited") await first.update(issueComments).set({ body: "changed after acceptance" }).where(eq(issueComments.id, accepted.request.commentId));
    let executions = 0;
    const delivery = issueCommentRequestService(second, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => reason !== "revoked", handlers: { references: { execute: async () => { executions++; return {}; } } } });
    await delivery.dispatchOne(input.companyId, accepted.request.id);
    expect(executions).toBe(0);
    const [request] = await first.select().from(issueCommentRequests).where(eq(issueCommentRequests.id, accepted.request.id));
    expect(request.status).toBe(reason === "revoked" ? "blocked" : "cancelled");
  });


  it("reconciles a dispatched receipt after authority is revoked without executing again", async () => {
    const input = await seed();
    const accepted = await service(first).admit(input, persist(input));
    const entered = defer(); const release = defer();
    const worker = issueCommentRequestService(first, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => true,
      handlers: { references: { execute: async () => { entered.resolve(); await release.promise; return { original: true }; } } } });
    const original = worker.dispatchOne(input.companyId, accepted.request.id);
    await entered.promise;
    let executions = 0;
    const recovered = issueCommentRequestService(second, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => false,
      now: () => new Date(Date.now() + 60_000), handlers: { references: {
        execute: async () => { executions++; return {}; }, reconcile: async () => ({ durableReceipt: "existing" }),
      } } });
    await recovered.dispatchOne(input.companyId, accepted.request.id);
    release.resolve(); await original;
    expect(executions).toBe(0);
    const [effect] = await second.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(effect.receipt).toEqual({ durableReceipt: "existing" });
    expect(effect.generation).toBe(2);
  });

  it("keeps both switches fail closed without falling back to legacy persistence", async () => {
    const input = await seed(); let writes = 0;
    const paused = issueCommentRequestService(first, { controls: () => ({ admission: false, dispatch: false }), authorize: async () => true, handlers: {} });
    await expect(paused.admit(input, persist(input, async () => { writes++; }))).rejects.toMatchObject({ status: 503 });
    expect(writes).toBe(0);
    const accepted = await service(first).admit(input, persist(input));
    await paused.dispatchOne(input.companyId, accepted.request.id);
    const [effect] = await first.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(effect.status).toBe("pending"); expect(effect.attemptCount).toBe(0);
  });


  it("fences cancellation admission and records the accepted target identity", async () => {
    const input = { ...await seed(), actorSource: "local_implicit" };
    const agentId = randomUUID(); const runId = randomUUID();
    await first.insert(agents).values({ id: agentId, companyId: input.companyId, name: "Cancellation fixture" });
    await first.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId, status: "queued", executionStage: "preparing" });
    const accepted = await service(first).admit(input, async (tx) => ({ ...await persist(input)(tx),
      effects: [{ kind: "interrupt" as const, descriptor: { version: 1, targetRunId: runId } }],
    }));
    let recorded: Record<string, unknown> | undefined;
    const delivery = issueCommentRequestService(second, { controls: () => ({ admission: true, dispatch: true }), authorize: async () => true,
      handlers: { interrupt: { execute: async (request, effect) => {
        await expect(admitBoardCommentCancellation(first, runId, { companyId: request.companyId, requestId: request.id, effectId: effect.id, generation: effect.generation - 1, kind: "interrupt" })).rejects.toMatchObject({ status: 409 });
        const [untouched] = await first.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(untouched.resultJson).toBeNull();
        recorded = await admitBoardCommentCancellation(first, runId, { companyId: request.companyId, requestId: request.id, effectId: effect.id, generation: effect.generation, kind: "interrupt" });
        return { accepted: true };
      } } },
    });
    await delivery.dispatchOne(input.companyId, accepted.request.id);
    expect(recorded).toMatchObject({ requestId: accepted.request.id, commentId: accepted.request.commentId,
      clientRequestId: input.clientRequestId, targetRunId: runId, authorUserId: input.authorUserId });
    const [run] = await first.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.resultJson?.boardCommentCancellation).toEqual(recorded);
    expect(run.status).toBe("queued"); // Admission itself never fabricates a stop receipt.
  });

  it("refuses unaware rollback after even settled accepted requests", async () => {
    await expect(assertCommentRequestRollbackSafe(first, 0)).rejects.toThrow("Rollback target");
    await expect(assertCommentRequestRollbackSafe(first, 1)).resolves.toBeUndefined();
  });

  it("reconciles a real worker crash after wake admission without a second wake", async () => {
    const input = await seed();
    const agentId = randomUUID();
    await first.insert(agents).values({ id: agentId, companyId: input.companyId, name: "Never executed fixture" });
    const accepted = await service(first).admit(input, async (tx) => {
      const result = await persist(input)(tx);
      return { ...result, effects: [{ kind: "wake" as const, descriptor: { agentId } }] };
    });
    const worker = spawn(process.execPath, [
      "--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      fileURLToPath(new URL("./helpers/comment-request-crash-worker.ts", import.meta.url)),
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let diagnostics = "";
    worker.stderr.on("data", (chunk) => { diagnostics += chunk; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      worker.once("error", reject); worker.once("exit", (code, signal) => resolve({ code, signal }));
    });
    worker.stdin.end(JSON.stringify({ connectionString: database.connectionString, companyId: input.companyId, requestId: accepted.request.id, agentId }));
    const outcome = await exited;
    expect(outcome, diagnostics.replaceAll(database.connectionString, "[ephemeral database]")).toEqual({ code: null, signal: "SIGKILL" });
    let replayed = 0;
    const restarted = issueCommentRequestService(second, {
      controls: () => ({ admission: true, dispatch: true }), authorize: async () => true,
      // Advance only the injected fixture clock; do not edit delivery state.
      now: () => new Date(Date.now() + 60_000),
      handlers: { wake: {
        execute: async () => { replayed++; return {}; },
        reconcile: async (request, effect) => {
          const [wake] = await second.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, effect.idempotencyKey));
          return wake && wake.companyId === request.companyId ? { wakeRequestId: wake.id } : null;
        },
      } },
    });
    await restarted.dispatchOne(input.companyId, accepted.request.id);
    await restarted.dispatchOne(input.companyId, accepted.request.id);
    expect(replayed).toBe(0);
    const wakes = await first.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    const [saved] = await first.select().from(issueCommentRequests).where(eq(issueCommentRequests.id, accepted.request.id));
    expect(saved.status).toBe("delivered");
    // Permanent idempotency remains after a terminal queue disposition.
    await first.update(agentWakeupRequests).set({ status: "succeeded" }).where(eq(agentWakeupRequests.id, wakes[0].id));
    await expect(first.insert(agentWakeupRequests).values({ companyId: input.companyId, agentId, source: "automation", idempotencyKey: wakes[0].idempotencyKey })).rejects.toThrow();
  }, 30_000);

  it("retains rollback restriction after supported deletion and ordinary settings changes", async () => {
    const settings = instanceSettingsService(first);
    const exposed = await settings.get();
    expect(exposed).not.toHaveProperty("minimumBoardCommentRequestProtocolVersion");
    await settings.updateGeneral({ censorUsernameInLogs: false });
    const rows = await first.select({ id: issues.id }).from(issues);
    for (const row of rows) await issueService(first).remove(row.id);
    expect(await first.select().from(issueCommentRequests)).toHaveLength(0);
    expect((await first.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0].minimumBoardCommentRequestProtocolVersion).toBe(1);
    await expect(assertCommentRequestRollbackSafe(first, 0)).rejects.toThrow("Rollback target");
    await expect(assertCommentRequestRollbackSafe(first, 1)).resolves.toBeUndefined();
    // Missing migrated singleton is an integrity error, not a fresh lineage.
    await first.execute(sql`delete from instance_settings where singleton_key = 'default'`);
    await expect(assertCommentRequestRollbackSafe(first, 1)).rejects.toThrow("watermark");
  });

});
