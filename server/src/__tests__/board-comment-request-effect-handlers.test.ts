import { acceptedCommentDigest, type CommentRequestEnvelope } from "../services/issue-comment-request-canonical.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, closeRegisteredClients, issueComments, issueCommentRequests,
  issueCommentRequestEffects, issueReferenceMentions, issues, issueThreadInteractions, activityLog, externalObjectMentions, issueRecoveryActions, issueWatchdogs, agents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { createBoardCommentSourceRecoveryHandler } from "../services/board-comment-request-recovery-effects.js";
import { assertBoardCommentWatchdogClaim, withBoardCommentWatchdogMutation, boardCommentWatchdogConfigurationSha256 } from "../services/board-comment-watchdog-claim.js";
import { externalObjectService } from "../services/external-objects.js";
import { persistActivity, loadActivityPublication } from "../services/activity-log.js";
import { createBoardCommentProjectionHandlers, createBoardCommentActivityPublicationHandler } from "../services/board-comment-request-effect-handlers.js";

const supported = await getEmbeddedPostgresTestSupport();
const suite = supported.supported ? describe : describe.skip;
suite("concrete accepted Board comment reference effects", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-effects-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  }, 60_000);
  afterAll(async () => {
    if (database) { await closeRegisteredClients(database.connectionString); await database.cleanup(); }
  });
  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), targetId = randomUUID();
    const prefix = `R${companyId.slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Reference fixture", issuePrefix: prefix });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Source", identifier: `${prefix}-1`, status: "todo", priority: "medium" },
      { id: targetId, companyId, title: "Target", identifier: `${prefix}-2`, status: "todo", priority: "medium" },
    ]);
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "board-fixture",
      authorType: "user", body: `See ${prefix}-2`, clientRequestId: randomUUID() }).returning();
    const [request] = await db.insert(issueCommentRequests).values({ companyId, issueId, authorUserId: "board-fixture",
      clientRequestId: comment!.clientRequestId!, commentId: comment!.id, canonicalEnvelope: {},
      acceptedCommentUpdatedAt: comment!.updatedAt, payloadSha256: "a".repeat(64) }).returning();
    const [effect] = await db.insert(issueCommentRequestEffects).values({ companyId, requestId: request!.id, ordinal: 0,
      kind: "references", descriptor: { version: 1, commentId: comment!.id }, idempotencyKey: `issue-comment-request:${randomUUID()}` }).returning();
    return { companyId, issueId, targetId, comment: comment!, request: request!, effect: effect! };
  }
  async function mentions(companyId: string, commentId: string) {
    return db.select().from(issueReferenceMentions).where(and(eq(issueReferenceMentions.companyId, companyId),
      eq(issueReferenceMentions.sourceRecordId, commentId)));
  }
  const handler = createBoardCommentProjectionHandlers().references.transaction!;
  it("commits concrete reference projection and receipt together; repeated projection stays idempotent", async () => {
    const f = await seed();
    const receipt = await db.transaction(async tx => {
      const result = await handler(tx, f.request, f.effect);
      await tx.update(issueCommentRequestEffects).set({ status: "delivered", receipt: result }).where(eq(issueCommentRequestEffects.id, f.effect.id));
      return result;
    });
    expect(receipt.addedReferencedIssueIds).toEqual([f.targetId]);
    expect(receipt.currentReferencedIssueIds).toEqual([f.targetId]);
    expect(await mentions(f.companyId, f.comment.id)).toHaveLength(1);
    await db.transaction(tx => handler(tx, f.request, f.effect));
    expect(await mentions(f.companyId, f.comment.id)).toHaveLength(1);
  });
  it("rolls back projection when the receipt transaction fails, then recovers without duplicate mentions", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await handler(tx, f.request, f.effect); throw new Error("crash before receipt"); }))
      .rejects.toThrow("crash before receipt");
    expect(await mentions(f.companyId, f.comment.id)).toEqual([]);
    await db.transaction(tx => handler(tx, f.request, f.effect));
    expect(await mentions(f.companyId, f.comment.id)).toHaveLength(1);
  });
  for (const mutation of ["wrong-company", "wrong-comment", "unknown-descriptor", "changed-revision", "deleted-comment", "wrong-author"] as const) {
    it(`rejects ${mutation} before changing projection`, async () => {
      const f = await seed();
      if (mutation === "wrong-company") f.effect.companyId = randomUUID();
      if (mutation === "wrong-comment") f.effect.descriptor = { version: 1, commentId: randomUUID() };
      if (mutation === "unknown-descriptor") f.effect.descriptor = { ...f.effect.descriptor, command: "unexpected" };
      if (mutation === "changed-revision") await db.update(issueComments).set({ body: "changed", updatedAt: new Date(f.comment.updatedAt.getTime() + 1000) }).where(eq(issueComments.id, f.comment.id));
      if (mutation === "deleted-comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.comment.id));
      if (mutation === "wrong-author") f.request.authorUserId = "different-user";
      await expect(db.transaction(tx => handler(tx, f.request, f.effect))).rejects.toThrow();
      expect(await mentions(f.companyId, f.comment.id)).toEqual([]);
    });
  }
  it("binds repeat publication to the existing activity ID and original timestamp", async () => {
    const f = await seed();
    const saved = await persistActivity(db, { companyId: f.companyId, actorType: "user", actorId: f.request.authorUserId,
      action: "issue.comment_added", entityType: "issue", entityId: f.issueId, details: { commentId: f.comment.id } });
    const loaded = await loadActivityPublication(db, f.companyId, saved.activity.id);
    expect(loaded?.payload.activityId).toBe(saved.activity.id);
    expect(loaded?.pluginEvent?.eventId).toBe(saved.activity.id);
    expect(loaded?.pluginEvent?.occurredAt).toBe(saved.publication.pluginEvent?.occurredAt);
    expect(await loadActivityPublication(db, randomUUID(), saved.activity.id)).toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(1);
    expect(await createBoardCommentActivityPublicationHandler(db).reconcile!(f.request, f.effect)).toBeNull();
  });
  it("expires only accepted terminal targets and rolls deferred telemetry IDs back with the transaction", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const rows = await db.insert(issueThreadInteractions).values([0, 1].map(() => ({ companyId: f.companyId,
      issueId: f.issueId, kind: "request_confirmation", payload: { version: 1, prompt: "Proceed?", target: { type: "custom" as const, key: "test-plan" } } }))).returning();
    f.effect.kind = "terminal_interaction_expiry";
    f.effect.descriptor = { version: 1, commentId: f.comment.id, interactionIds: [rows[0]!.id] };
    const expire = createBoardCommentProjectionHandlers().terminal_interaction_expiry.transaction!;
    await expect(db.transaction(async tx => { await expire(tx, f.request, f.effect); throw new Error("rollback expiry"); })).rejects.toThrow("rollback expiry");
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, rows[0]!.id)))[0]?.status).toBe("pending");
    const receipt = await db.transaction(tx => expire(tx, f.request, f.effect));
    expect(receipt.deferredTelemetryInteractionIds).toEqual([rows[0]!.id]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, rows[1]!.id)))[0]?.status).toBe("pending");
  });

  it("detects accepted external links before the projection transaction and rolls back projection atomically", async () => {
    const f = await seed();
    const external = externalObjectService(db, { github: false, enabled: true, failOnDetectorError: true });
    const projection = await external.prepareAcceptedCommentProjection({ ...f.comment, body: "See https://example.com/accepted" });
    expect(projection.detections).toHaveLength(1);
    expect(await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.companyId, f.companyId))).toHaveLength(0);
    await expect(db.transaction(async tx => {
      await external.applyAcceptedCommentProjection(projection, tx as unknown as typeof db);
      throw new Error("rollback external projection");
    })).rejects.toThrow("rollback external projection");
    expect(await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.companyId, f.companyId))).toHaveLength(0);
    await db.transaction(tx => external.applyAcceptedCommentProjection(projection, tx as unknown as typeof db));
    expect(await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.companyId, f.companyId))).toHaveLength(1);
  });
  it("keeps detector failures visible on the durable path instead of replacing them with generic links", async () => {
    const f = await seed();
    const external = externalObjectService(db, { github: false, enabled: true, failOnDetectorError: true,
      detectors: [{ key: "failing-provider", detect: async () => { throw new Error("uncertain detector RPC"); } }] });
    await expect(external.prepareAcceptedCommentProjection({ ...f.comment, body: "https://example.com/accepted" }))
      .rejects.toThrow("uncertain detector RPC");
    expect(await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.companyId, f.companyId))).toHaveLength(0);
  });

  it("resolves only the captured recovery action and rolls its attributed audit back atomically", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const [target] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "manual", cause: "test", fingerprint: randomUUID(), nextAction: "review" }).returning();
    f.effect.kind = "source_recovery_revalidation";
    f.effect.descriptor = { version: 1, targetRecoveryActionId: target!.id,
      statusChanged: false, resumeRequested: false, reopened: false, blockedToTodoRecovery: false };
    const handler = createBoardCommentSourceRecoveryHandler().transaction!;
    await expect(db.transaction(async tx => { await handler(tx, f.request, f.effect); throw new Error("rollback recovery"); }))
      .rejects.toThrow("rollback recovery");
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, target!.id)))[0]?.status).toBe("active");
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
    const receipt = await db.transaction(tx => handler(tx, f.request, f.effect));
    expect(receipt.resolved).toBe(true);
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(f.request.authorUserId);
    expect(receipt.activityId).toBe(audits[0]?.id);
    await db.transaction(tx => handler(tx, f.request, f.effect));
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(1);
  });
  it("rejects a stale watchdog generation before any target lookup or mutation", async () => {
    const f = await seed();
    await db.update(issueCommentRequestEffects).set({ kind: "watchdog", status: "dispatching", generation: 2,
      descriptor: { version: 1, targets: [] } }).where(eq(issueCommentRequestEffects.id, f.effect.id));
    await expect(assertBoardCommentWatchdogClaim(db, { requestId: f.request.id, effectId: f.effect.id, generation: 1 }, randomUUID()))
      .rejects.toThrow("Watchdog claim is no longer current");
  });

  it("holds the effect generation fence until its concrete watchdog mutation commits", async () => {
    const f = await seed();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Watchdog fixture" }).returning();
    const [watchdog] = await db.insert(issueWatchdogs).values({ companyId: f.companyId, issueId: f.issueId, watchdogAgentId: agent!.id }).returning();
    const envelope = { authorization: { source: "local_implicit" }, attachments: [] } as unknown as CommentRequestEnvelope;
    await db.update(issueCommentRequests).set({ canonicalEnvelope: envelope as unknown as Record<string, unknown>, payloadSha256: acceptedCommentDigest(envelope, f.comment) }).where(eq(issueCommentRequests.id, f.request.id));
    await db.update(issueCommentRequestEffects).set({ kind: "watchdog", status: "dispatching", generation: 1,
      descriptor: { version: 1, targets: [{ watchdogId: watchdog!.id, watchedIssueId: f.issueId,
        configurationSha256: boardCommentWatchdogConfigurationSha256(watchdog!) }] } }).where(eq(issueCommentRequestEffects.id, f.effect.id));
    const contender = createDb(database.connectionString, { maxConnections: 1, applicationName: "watchdog-fence-contender" });
    await withBoardCommentWatchdogMutation(db, { requestId: f.request.id, effectId: f.effect.id, generation: 1 }, watchdog!.id, async tx => {
      await expect(contender.transaction(async concurrent => {
        await concurrent.execute(sql`SET LOCAL lock_timeout = '50ms'`);
        await concurrent.update(issueCommentRequestEffects).set({ generation: 2 }).where(eq(issueCommentRequestEffects.id, f.effect.id));
      })).rejects.toThrow();
      await tx.update(issueWatchdogs).set({ triggerCount: 1 }).where(eq(issueWatchdogs.id, watchdog!.id));
    });
    expect((await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, watchdog!.id)))[0]?.triggerCount).toBe(1);
    await db.update(issueCommentRequestEffects).set({ generation: 2 }).where(eq(issueCommentRequestEffects.id, f.effect.id));
    await expect(withBoardCommentWatchdogMutation(db, { requestId: f.request.id, effectId: f.effect.id, generation: 1 }, watchdog!.id,
      async tx => { await tx.update(issueWatchdogs).set({ triggerCount: 2 }).where(eq(issueWatchdogs.id, watchdog!.id)); }))
      .rejects.toThrow("Accepted effect claim is no longer current");
    expect((await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, watchdog!.id)))[0]?.triggerCount).toBe(1);
  });

  for (const validWorkspace of [true, false]) {
    it(`${validWorkspace ? "publishes" : "rejects"} workspace audit with ${validWorkspace ? "matching" : "wrong"} captured entity`, async () => {
      const f = await seed();
      const workspaceId = randomUUID();
      const primary = await persistActivity(db, { companyId: f.companyId, actorType: "user", actorId: f.request.authorUserId,
        action: "issue.comment_added", entityType: "issue", entityId: f.issueId, details: { commentId: f.comment.id } });
      const workspace = await persistActivity(db, { companyId: f.companyId, actorType: "user", actorId: f.request.authorUserId,
        action: "execution_workspace.reopen_consumed", entityType: "execution_workspace", entityId: validWorkspace ? workspaceId : randomUUID(),
        details: { commentRequestId: f.request.id } });
      await db.update(issueCommentRequestEffects).set({ kind: "workspace_cleanup", status: "delivered", receipt: {
        kind: "workspace_cleanup", requestId: f.request.id, effectId: f.effect.id, workspaceId, workspaceActivityIds: [workspace.activity.id],
      } }).where(eq(issueCommentRequestEffects.id, f.effect.id));
      const [publication] = await db.insert(issueCommentRequestEffects).values({ companyId: f.companyId, requestId: f.request.id,
        ordinal: 1, kind: "activity_publication", status: "dispatching", generation: 1,
        descriptor: { version: 1, activityId: primary.activity.id, workspaceEffectOrdinals: [0] }, idempotencyKey: randomUUID() }).returning();
      const result = createBoardCommentActivityPublicationHandler(db).execute!(f.request, publication!);
      if (validWorkspace) expect(await result).toMatchObject({ dispatchObserved: true, downstreamDeliveryConfirmed: false });
      else await expect(result).rejects.toThrow("Workspace activity does not belong to this request");
    });
  }

  for (const validSource of [true, false]) {
    it(`${validSource ? "accepts" : "rejects"} the ${validSource ? "correlated" : "unrelated"} status audit source`, async () => {
      const f = await seed();
      const primary = await persistActivity(db, { companyId: f.companyId, actorType: "user", actorId: f.request.authorUserId,
        action: "issue.updated", entityType: "issue", entityId: f.issueId,
        details: { commentId: f.comment.id, source: validSource ? "auto_approval_comment" : "unrelated" } });
      const [publication] = await db.update(issueCommentRequestEffects).set({ kind: "activity_publication", status: "dispatching", generation: 1,
        descriptor: { version: 1, activityId: primary.activity.id } }).where(eq(issueCommentRequestEffects.id, f.effect.id)).returning();
      const result = createBoardCommentActivityPublicationHandler(db).execute!(f.request, publication!);
      if (validSource) expect(await result).toMatchObject({ dispatchObserved: true });
      else await expect(result).rejects.toThrow("Activity does not belong to the accepted comment");
    });
    it(`${validSource ? "publishes" : "rejects"} runtime cancellation audit with ${validSource ? "matching" : "wrong"} source`, async () => {
      const f = await seed();
      const targetRunId = randomUUID();
      const primary = await persistActivity(db, { companyId: f.companyId, actorType: "user", actorId: f.request.authorUserId,
        action: "issue.comment_added", entityType: "issue", entityId: f.issueId, details: { commentId: f.comment.id } });
      const runtime = await persistActivity(db, { companyId: f.companyId, actorType: "user", actorId: f.request.authorUserId,
        action: "heartbeat.cancelled", entityType: "heartbeat_run", entityId: targetRunId, details: {
          requestId: f.request.id, effectId: f.effect.id, commentId: f.comment.id, targetRunId,
          source: validSource ? "issue_comment_interrupt" : "issue_comment_scheduled_retry_superseded",
        } });
      await db.update(issueCommentRequestEffects).set({ kind: "interrupt", status: "delivered", receipt: {
        targetRunId, runtimeActivityIds: [runtime.activity.id],
      } }).where(eq(issueCommentRequestEffects.id, f.effect.id));
      const [publication] = await db.insert(issueCommentRequestEffects).values({ companyId: f.companyId, requestId: f.request.id,
        ordinal: 1, kind: "activity_publication", status: "dispatching", generation: 1,
        descriptor: { version: 1, activityId: primary.activity.id, runtimeEffectOrdinals: [0] }, idempotencyKey: randomUUID() }).returning();
      const result = createBoardCommentActivityPublicationHandler(db).execute!(f.request, publication!);
      if (validSource) expect(await result).toMatchObject({ dispatchObserved: true, downstreamDeliveryConfirmed: false });
      else await expect(result).rejects.toThrow("Runtime activity does not belong to this request");
    });
  }

});
