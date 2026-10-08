import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { approvalComments, approvals, companies, createDb } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const VERSION_CONFLICT = {
  status: 409,
  message: "This request changed after you opened it. Reload it and decide again.",
};

// The expected version of a decision, checked against a real database: the
// stub tests cannot show that the UPDATE's own WHERE holds a stale write back.
describeEmbeddedPostgres("approval decisions with an expected version", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-version-guard-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A pending approval whose times were written by the service's clock (milliseconds). */
  async function createPending(payload: Record<string, unknown> = { title: "First version" }) {
    const now = new Date();
    const [row] = await db
      .insert(approvals)
      .values({ companyId, type: "request_board_approval", payload, createdAt: now, updatedAt: now })
      .returning();
    return row!;
  }

  const read = (id: string) =>
    db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0]!);

  /** Moves the approval on, as a real send-back and resubmission do. */
  async function sendBackAndResubmit(id: string, payload: Record<string, unknown>) {
    const svc = approvalService(db);
    await svc.requestRevision(id, "other-board-user", "Quote the delivery date.");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return svc.resubmit(id, payload);
  }

  it("stores a decision made for the current version", async () => {
    const svc = approvalService(db);
    const pending = await createPending();

    const { approval, applied } = await svc.approve(pending.id, "user-1", "ship it", {
      expectedUpdatedAt: new Date(pending.updatedAt.toISOString()),
    });

    expect(applied).toBe(true);
    expect(approval.status).toBe("approved");
    expect(approval.decisionNote).toBe("ship it");
  });

  it("accepts the version of a row whose updated_at was written by now() with microseconds", async () => {
    const svc = approvalService(db);
    // No updatedAt given: the column default writes it, as the budget and tool-gateway inserts do.
    const [inserted] = await db
      .insert(approvals)
      .values({ companyId, type: "request_board_approval", payload: { title: "Default clock" } })
      .returning();
    // Make the microsecond part certain, whatever the clock gave.
    await db.execute(
      sql`update approvals set updated_at = date_trunc('milliseconds', updated_at) + interval '789 microseconds' where id = ${inserted!.id}`,
    );
    const micros = await db.execute(
      sql`select (extract(microseconds from updated_at)::int % 1000) as micros from approvals where id = ${inserted!.id}`,
    );
    expect(Number((micros as unknown as Array<{ micros: number }>)[0]!.micros)).toBe(789);

    // What a client holds is the API's millisecond string.
    const shown = (await read(inserted!.id)).updatedAt.toISOString();
    const { approval, applied } = await svc.approve(inserted!.id, "user-1", null, {
      expectedUpdatedAt: new Date(shown),
    });

    expect(applied).toBe(true);
    expect(approval.status).toBe("approved");
  });

  it("refuses approve, reject and request-revision for a version that was resubmitted since", async () => {
    const svc = approvalService(db);
    for (const decide of [
      (id: string, expectedUpdatedAt: Date) => svc.approve(id, "user-1", "late", { expectedUpdatedAt }),
      (id: string, expectedUpdatedAt: Date) => svc.reject(id, "user-1", "late", { expectedUpdatedAt }),
      (id: string, expectedUpdatedAt: Date) => svc.requestRevision(id, "user-1", "late", { expectedUpdatedAt }),
    ]) {
      const shown = await createPending();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const revised = await sendBackAndResubmit(shown.id, { title: "Second version" });

      await expect(decide(shown.id, shown.updatedAt)).rejects.toMatchObject({
        ...VERSION_CONFLICT,
        details: {
          code: "approval_version_conflict",
          currentStatus: "pending",
          currentUpdatedAt: revised.updatedAt.toISOString(),
          expectedUpdatedAt: shown.updatedAt.toISOString(),
        },
      });

      // Nothing was written: the revision is still pending, with the change request it answers.
      const stored = await read(shown.id);
      expect(stored.status).toBe("pending");
      expect(stored.payload).toEqual({ title: "Second version" });
      expect(stored.decisionNote).toBe("Quote the delivery date.");
      expect(stored.decidedAt).toBeNull();
      expect(stored.updatedAt.getTime()).toBe(revised.updatedAt.getTime());
    }
  });

  it("refuses a decision for a request that was sent back since", async () => {
    const svc = approvalService(db);
    const shown = await createPending();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await svc.requestRevision(shown.id, "other-board-user", "Quote the delivery date.");

    await expect(
      svc.approve(shown.id, "user-1", null, { expectedUpdatedAt: shown.updatedAt }),
    ).rejects.toMatchObject({ ...VERSION_CONFLICT, details: { currentStatus: "revision_requested" } });

    const stored = await read(shown.id);
    expect(stored.status).toBe("revision_requested");
    expect(stored.decisionNote).toBe("Quote the delivery date.");
  });

  it("answers 409, not an idempotent success, for a request that was decided since", async () => {
    const svc = approvalService(db);
    const shown = await createPending();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await svc.approve(shown.id, "other-board-user", "Fine by me");

    await expect(
      svc.approve(shown.id, "user-1", "mine", { expectedUpdatedAt: shown.updatedAt }),
    ).rejects.toMatchObject({ ...VERSION_CONFLICT, details: { currentStatus: "approved" } });
    // Without a version the same call is today's idempotent no-op.
    await expect(svc.approve(shown.id, "user-1", "mine")).resolves.toMatchObject({ applied: false });

    const stored = await read(shown.id);
    expect(stored.decidedByUserId).toBe("other-board-user");
    expect(stored.decisionNote).toBe("Fine by me");
  });

  /** A db whose first read still sees the row as it was; `afterFirstRead` changes the row before the service writes. */
  function racingDb(afterFirstRead: () => Promise<unknown>) {
    const racing = Object.create(db) as typeof db;
    let reads = 0;
    racing.select = ((...args: Parameters<typeof db.select>) => {
      const builder = db.select(...args);
      reads += 1;
      if (reads !== 1) return builder;
      return {
        from: (table: Parameters<typeof builder.from>[0]) => ({
          where: (condition: Parameters<ReturnType<typeof builder.from>["where"]>[0]) =>
            (builder.from(table) as any).where(condition).then(async (rows: unknown[]) => {
              await afterFirstRead();
              return rows;
            }),
        }),
      };
    }) as typeof db.select;
    return racing;
  }

  it("holds a stale write back in the UPDATE itself, when the row changes after the service read it", async () => {
    const shown = await createPending();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const racing = racingDb(() => sendBackAndResubmit(shown.id, { title: "Second version" }));

    await expect(
      approvalService(racing).approve(shown.id, "user-1", "late", { expectedUpdatedAt: shown.updatedAt }),
    ).rejects.toMatchObject({ ...VERSION_CONFLICT, details: { currentStatus: "pending" } });

    const stored = await read(shown.id);
    expect(stored.status).toBe("pending");
    expect(stored.payload).toEqual({ title: "Second version" });
  });

  it("holds a stale request-revision back in the UPDATE itself", async () => {
    const shown = await createPending();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const racing = racingDb(() => sendBackAndResubmit(shown.id, { title: "Second version" }));

    await expect(
      approvalService(racing).requestRevision(shown.id, "user-1", "late", { expectedUpdatedAt: shown.updatedAt }),
    ).rejects.toMatchObject({ ...VERSION_CONFLICT, details: { currentStatus: "pending" } });

    const stored = await read(shown.id);
    expect(stored.status).toBe("pending");
    expect(stored.payload).toEqual({ title: "Second version" });
    expect(stored.decisionNote).toBe("Quote the delivery date.");
  });

  it("does not let request-revision without a version overwrite a request decided after the read", async () => {
    const shown = await createPending();
    const racing = racingDb(() => approvalService(db).approve(shown.id, "other-board-user", "Fine by me"));

    await expect(approvalService(racing).requestRevision(shown.id, "user-1", "late")).rejects.toMatchObject({
      status: 422,
    });

    const stored = await read(shown.id);
    expect(stored.status).toBe("approved");
    expect(stored.decisionNote).toBe("Fine by me");
  });

  it("does not let resubmit reopen a request approved after the read", async () => {
    const shown = await createPending();
    await approvalService(db).requestRevision(shown.id, "other-board-user", "Quote the delivery date.");
    // A sent-back request can still be approved.
    const racing = racingDb(() => approvalService(db).approve(shown.id, "other-board-user", "Fine by me"));

    await expect(approvalService(racing).resubmit(shown.id, { title: "Late version" })).rejects.toMatchObject({
      status: 422,
    });

    const stored = await read(shown.id);
    expect(stored.status).toBe("approved");
    expect(stored.payload).toEqual({ title: "First version" });
  });

  it("leaves a decision without a version as it was: a revised request is still approved", async () => {
    const svc = approvalService(db);
    const shown = await createPending();
    await sendBackAndResubmit(shown.id, { title: "Second version" });

    const { approval, applied } = await svc.approve(shown.id, "user-1", "ok");

    expect(applied).toBe(true);
    expect(approval.status).toBe("approved");
    expect(approval.payload).toEqual({ title: "Second version" });
  });

  describe("transitions within one millisecond", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Stops the service's clock, so every `new Date()` in it gives this one millisecond. */
    function freezeClock() {
      const at = new Date(Date.now() + 60_000);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
      return at;
    }

    it("gives every transition its own serialized version when the clock does not move", async () => {
      const svc = approvalService(db);
      const frozen = freezeClock();
      const shown = await createPending();
      expect(shown.updatedAt.getTime()).toBe(frozen.getTime());

      const sentBack = await svc.requestRevision(shown.id, "other-board-user", "Quote the delivery date.");
      const revised = await svc.resubmit(shown.id, { title: "Second version" });
      const { approval: decided } = await svc.approve(shown.id, "user-1", "ok");
      expect(new Date().getTime()).toBe(frozen.getTime());

      const versions = [shown, sentBack, revised, decided].map((row) => row.updatedAt.toISOString());
      expect(new Set(versions).size).toBe(4);
      expect(versions).toEqual([...versions].sort());
      expect((await read(shown.id)).updatedAt.toISOString()).toBe(versions[3]);
    });

    it("refuses approve, reject and request-revision for a version revised in the same millisecond", async () => {
      const svc = approvalService(db);
      for (const decide of [
        (id: string, expectedUpdatedAt: Date) => svc.approve(id, "user-1", "late", { expectedUpdatedAt }),
        (id: string, expectedUpdatedAt: Date) => svc.reject(id, "user-1", "late", { expectedUpdatedAt }),
        (id: string, expectedUpdatedAt: Date) => svc.requestRevision(id, "user-1", "late", { expectedUpdatedAt }),
      ]) {
        freezeClock();
        const shown = await createPending();
        await svc.requestRevision(shown.id, "other-board-user", "Quote the delivery date.");
        const revised = await svc.resubmit(shown.id, { title: "Second version" });

        // The version the reader holds is the API's millisecond string.
        await expect(decide(shown.id, new Date(shown.updatedAt.toISOString()))).rejects.toMatchObject({
          ...VERSION_CONFLICT,
          details: { currentStatus: "pending", currentUpdatedAt: revised.updatedAt.toISOString() },
        });

        const stored = await read(shown.id);
        expect(stored.status).toBe("pending");
        expect(stored.payload).toEqual({ title: "Second version" });
        expect(stored.decisionNote).toBe("Quote the delivery date.");
        vi.useRealTimers();
      }
    });

    it("holds a stale write back in the UPDATE when the row is revised in the same millisecond after the read", async () => {
      freezeClock();
      const shown = await createPending();
      const racing = racingDb(async () => {
        await approvalService(db).requestRevision(shown.id, "other-board-user", "Quote the delivery date.");
        await approvalService(db).resubmit(shown.id, { title: "Second version" });
      });

      await expect(
        approvalService(racing).approve(shown.id, "user-1", "late", { expectedUpdatedAt: shown.updatedAt }),
      ).rejects.toMatchObject({ ...VERSION_CONFLICT, details: { currentStatus: "pending" } });
      expect((await read(shown.id)).status).toBe("pending");
    });

    it("refuses a decision for a request cancelled in the same millisecond", async () => {
      const svc = approvalService(db);
      freezeClock();
      const shown = await createPending();
      const cancelled = await svc.cancel(shown.id, "Duplicate hire");

      expect(cancelled!.updatedAt.getTime()).toBeGreaterThan(shown.updatedAt.getTime());
      await expect(
        svc.approve(shown.id, "user-1", "late", { expectedUpdatedAt: shown.updatedAt }),
      ).rejects.toMatchObject({ ...VERSION_CONFLICT, details: { currentStatus: "cancelled" } });
    });

    it("moves past a stored time that is ahead of the clock and holds microseconds", async () => {
      const svc = approvalService(db);
      const shown = await createPending();
      await db.execute(
        sql`update approvals set updated_at = date_trunc('milliseconds', now()) + interval '1 hour 789 microseconds' where id = ${shown.id}`,
      );
      const ahead = (await read(shown.id)).updatedAt;

      const sentBack = await svc.requestRevision(shown.id, "user-1", "Quote the delivery date.", {
        expectedUpdatedAt: new Date(ahead.toISOString()),
      });

      expect(sentBack.updatedAt.getTime()).toBe(ahead.getTime() + 1);
      await expect(
        svc.approve(shown.id, "user-1", "late", { expectedUpdatedAt: new Date(ahead.toISOString()) }),
      ).rejects.toMatchObject(VERSION_CONFLICT);
    });
  });

  describe("the change request kept as a comment", () => {
    const commentsOf = (id: string) =>
      db.select().from(approvalComments).where(eq(approvalComments.approvalId, id));

    it("keeps the board's change request in the discussion after the final decision", async () => {
      const svc = approvalService(db);
      const shown = await createPending();

      await svc.requestRevision(shown.id, "board-user-1", "1. Quote the delivery date.\n2. Name the price.");
      await svc.resubmit(shown.id, { title: "Second version" });
      const { approval } = await svc.approve(shown.id, "board-user-2", "Good now");

      // The decision overwrote the note on the approval; the comment still holds it.
      expect(approval.decisionNote).toBe("Good now");
      const comments = await svc.listComments(shown.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        companyId,
        approvalId: shown.id,
        authorAgentId: null,
        authorUserId: "board-user-1",
        body: "Changes requested:\n\n1. Quote the delivery date.\n2. Name the price.",
      });
    });

    it("keeps one comment per send-back, in order", async () => {
      const svc = approvalService(db);
      const shown = await createPending();

      await svc.requestRevision(shown.id, "board-user-1", "First change");
      await svc.resubmit(shown.id, { title: "Second version" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await svc.requestRevision(shown.id, "board-user-2", "Second change");

      const comments = await svc.listComments(shown.id);
      expect(comments.map((comment) => [comment.authorUserId, comment.body])).toEqual([
        ["board-user-1", "Changes requested:\n\nFirst change"],
        ["board-user-2", "Changes requested:\n\nSecond change"],
      ]);
    });

    it("writes no second comment when the same request is sent again or refused for its version", async () => {
      const svc = approvalService(db);
      const shown = await createPending();

      await svc.requestRevision(shown.id, "board-user-1", "Quote the delivery date.", {
        expectedUpdatedAt: shown.updatedAt,
      });
      // The retry of the same send, with and without the version it named.
      await expect(
        svc.requestRevision(shown.id, "board-user-1", "Quote the delivery date.", { expectedUpdatedAt: shown.updatedAt }),
      ).rejects.toMatchObject(VERSION_CONFLICT);
      await expect(svc.requestRevision(shown.id, "board-user-1", "Quote the delivery date."))
        .rejects.toMatchObject({ status: 422 });

      expect(await commentsOf(shown.id)).toHaveLength(1);
    });

    it("writes no comment when the write is held back because the request changed after the read", async () => {
      const shown = await createPending();
      const racing = racingDb(() => approvalService(db).approve(shown.id, "other-board-user", "Fine by me"));

      await expect(approvalService(racing).requestRevision(shown.id, "user-1", "late")).rejects.toMatchObject({
        status: 422,
      });

      expect(await commentsOf(shown.id)).toHaveLength(0);
    });

    it("writes no comment without a note", async () => {
      const svc = approvalService(db);
      const shown = await createPending();

      await svc.requestRevision(shown.id, "board-user-1", null);

      expect(await commentsOf(shown.id)).toHaveLength(0);
    });

    it("does not send the request back when the comment cannot be written", async () => {
      const shown = await createPending();
      const failing = Object.create(db) as typeof db;
      failing.transaction = ((run: Parameters<typeof db.transaction>[0]) =>
        db.transaction(async (tx) => {
          const guarded = Object.create(tx) as typeof tx;
          guarded.insert = (() => {
            throw new Error("comment insert failed");
          }) as typeof tx.insert;
          return run(guarded);
        })) as typeof db.transaction;

      await expect(approvalService(failing).requestRevision(shown.id, "user-1", "Quote the date."))
        .rejects.toThrow("comment insert failed");

      const stored = await read(shown.id);
      expect(stored.status).toBe("pending");
      expect(stored.decisionNote).toBeNull();
    });
  });

  it("does not let request-revision overwrite a request that is no longer pending", async () => {
    const svc = approvalService(db);
    const shown = await createPending();
    await svc.approve(shown.id, "other-board-user", "Fine by me");

    await expect(svc.requestRevision(shown.id, "user-1", "late")).rejects.toMatchObject({ status: 422 });
    expect((await read(shown.id)).status).toBe("approved");
  });
});
