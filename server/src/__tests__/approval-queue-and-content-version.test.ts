import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, approvals, companies, createDb } from "@paperclipai/db";
import { approvalCostSchema, createApprovalSchema } from "@paperclipai/shared";
import { approvalService } from "../services/approvals.js";
import { approvalContentVersion, isSameRequestStatusMove } from "../services/approval-version.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const VERSION_CONFLICT = { status: 409 };

describe("approval content version", () => {
  const base = { type: "request_board_approval", payload: { title: "A", pros: ["x"], nested: { b: 1, a: 2 } }, decisionNote: null };

  it("does not depend on the order of payload keys", () => {
    expect(approvalContentVersion(base)).toBe(
      approvalContentVersion({ ...base, payload: { nested: { a: 2, b: 1 }, pros: ["x"], title: "A" } }),
    );
    expect(approvalContentVersion(base)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes with the payload, the type and the change request", () => {
    const version = approvalContentVersion(base);
    expect(approvalContentVersion({ ...base, payload: { ...base.payload, title: "B" } })).not.toBe(version);
    expect(approvalContentVersion({ ...base, type: "hire_agent" })).not.toBe(version);
    expect(approvalContentVersion({ ...base, decisionNote: "Quote the date." })).not.toBe(version);
    expect(approvalContentVersion({ ...base, payload: { ...base.payload, pros: ["x", "y"] } })).not.toBe(version);
  });

  it("admits only the same status and a resubmission as moves that keep the request", () => {
    expect(isSameRequestStatusMove("pending", "pending")).toBe(true);
    expect(isSameRequestStatusMove("revision_requested", "pending")).toBe(true);
    expect(isSameRequestStatusMove("pending", "revision_requested")).toBe(false);
    expect(isSameRequestStatusMove("pending", "approved")).toBe(false);
    expect(isSameRequestStatusMove("revision_requested", "rejected")).toBe(false);
  });
});

describe("typed cost and deadline on a board request", () => {
  const decisionFields = {
    recommendedAction: "Approve provider X.",
    reasoning: "It meets the requirements.",
    pros: ["Bounded cost."],
    risks: ["Usage may grow."],
  };

  it("accepts the documented shapes and keeps them in the payload", () => {
    const parsed = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: {
        ...decisionFields,
        cost: { amount: 42.5, currency: "USD", period: "month" },
        decideBy: "2026-10-24T17:00:00+02:00",
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.payload).toMatchObject({ cost: { amount: 42.5, currency: "USD", period: "month" } });
    expect(createApprovalSchema.safeParse({ type: "request_board_approval", payload: { ...decisionFields, cost: { amount: 0, currency: "EUR" } } }).success).toBe(true);
  });

  it("keeps a cost written as text or a number, as agents wrote it before the field was typed", () => {
    for (const cost of ["$42/month", 42]) {
      const parsed = createApprovalSchema.safeParse({ type: "request_board_approval", payload: { ...decisionFields, cost } });
      expect(parsed.success, String(cost)).toBe(true);
      expect(parsed.data?.payload.cost).toBe(cost);
    }
  });

  it("accepts a currency in small letters and an empty period, and reads them as USD and none", () => {
    const cost = { amount: 5, currency: " usd ", period: null };
    const parsed = createApprovalSchema.safeParse({ type: "request_board_approval", payload: { ...decisionFields, cost } });
    expect(parsed.success).toBe(true);
    // The stored payload is kept as written; readers parse it with the same schema.
    expect(parsed.data?.payload.cost).toEqual(cost);
    expect(approvalCostSchema.parse(cost)).toEqual({ amount: 5, currency: "USD" });
  });

  it("does not check the fields on other approval types", () => {
    expect(createApprovalSchema.safeParse({ type: "hire_agent", payload: { name: "X", cost: "a lot", decideBy: "soon" } }).success).toBe(true);
  });
});

describeEmbeddedPostgres("approval queue and content-aware versions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-queue-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Paperclip",
      issuePrefix: `Q${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function createPending(companyId: string, payload: Record<string, unknown> = { title: "First version" }) {
    const now = new Date();
    const [row] = await db
      .insert(approvals)
      .values({ companyId, type: "request_board_approval", payload, createdAt: now, updatedAt: now })
      .returning();
    return row!;
  }

  const read = (id: string) => db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0]!);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

  /** What a page holds for an approval: its version, status and content version. */
  function seen(approval: typeof approvals.$inferSelect) {
    return {
      expectedUpdatedAt: new Date(approval.updatedAt.toISOString()),
      expectedStatus: approval.status,
      expectedContentVersion: approvalContentVersion(approval),
    };
  }

  describe("listQueue", () => {
    it("returns every open approval and only the newest decided ones, newest decision first", async () => {
      const companyId = await createCompany();
      const otherCompanyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId, { title: "Open" });
      const sentBack = await createPending(companyId, { title: "Sent back" });
      await svc.requestRevision(sentBack.id, "user-1", "Add the quote.");
      const decidedIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const row = await createPending(companyId, { title: `Decided ${index}` });
        await svc.approve(row.id, "user-1", null);
        decidedIds.push(row.id);
        await pause();
      }
      await createPending(otherCompanyId, { title: "Other company" });

      const first = await svc.listQueue(companyId, 2);
      const ids = first.approvals.map((approval) => approval.id);
      expect(ids).toEqual(expect.arrayContaining([pending.id, sentBack.id]));
      expect(ids.filter((id) => decidedIds.includes(id))).toEqual([decidedIds[4], decidedIds[3]]);
      expect(first.approvals).toHaveLength(4);
      expect(first.decidedHasMore).toBe(true);

      const all = await svc.listQueue(companyId, 5);
      expect(all.approvals).toHaveLength(7);
      expect(all.decidedHasMore).toBe(false);

      const openOnly = await svc.listQueue(companyId, 0);
      expect(openOnly.approvals.map((approval) => approval.id).sort()).toEqual([pending.id, sentBack.id].sort());
      expect(openOnly.decidedHasMore).toBe(false);
    });
  });

  describe("a decision made for an older version", () => {
    it("is stored when the request was only resubmitted unchanged since", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const sentBack = await svc.requestRevision(pending.id, "user-1", "Quote the delivery date.");
      await pause();
      // The page holds the sent-back version; the requester resubmits the same payload.
      const resubmitted = await svc.resubmit(sentBack.id, { title: "First version" });
      expect(resubmitted.updatedAt.getTime()).not.toBe(sentBack.updatedAt.getTime());

      const { approval, applied } = await svc.approve(sentBack.id, "user-1", "ok", seen(sentBack));

      expect(applied).toBe(true);
      expect(approval.status).toBe("approved");
    });

    it("is refused when the resubmission changed the payload", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const sentBack = await svc.requestRevision(pending.id, "user-1", "Quote the delivery date.");
      await pause();
      await svc.resubmit(sentBack.id, { title: "Second version" });

      await expect(svc.approve(sentBack.id, "user-1", "ok", seen(sentBack))).rejects.toMatchObject(VERSION_CONFLICT);
      expect((await read(sentBack.id)).status).toBe("pending");
    });

    it("is refused when someone else sent the request back since, even with the same payload", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const view = seen(pending);
      await svc.requestRevision(pending.id, "other-user", "Add the vendor.");

      await expect(svc.approve(pending.id, "user-1", "ok", view)).rejects.toMatchObject(VERSION_CONFLICT);
      await expect(svc.reject(pending.id, "user-1", "no", view)).rejects.toMatchObject(VERSION_CONFLICT);
      expect((await read(pending.id)).status).toBe("revision_requested");
    });

    it("is refused when a new change request was resubmitted unchanged (the note differs from the one seen)", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const view = seen(pending);
      await svc.requestRevision(pending.id, "other-user", "Add the vendor.");
      await pause();
      await svc.resubmit(pending.id, { title: "First version" });

      await expect(svc.approve(pending.id, "user-1", "ok", view)).rejects.toMatchObject(VERSION_CONFLICT);
      await expect(svc.requestRevision(pending.id, "user-1", "Shorter", view)).rejects.toMatchObject(VERSION_CONFLICT);
    });

    it("is refused when someone sent it back without a note and it was resubmitted unchanged since", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const view = seen(pending);
      await svc.requestRevision(pending.id, "other-user", null);
      // The route writes this entry for every send-back; a note-less one changes nothing else.
      await db.insert(activityLog).values({
        companyId, actorType: "user", actorId: "other-user", action: "approval.revision_requested",
        entityType: "approval", entityId: pending.id, details: {},
      });
      await pause();
      await svc.resubmit(pending.id, { title: "First version" });
      expect(approvalContentVersion(await read(pending.id))).toBe(view.expectedContentVersion);

      await expect(svc.approve(pending.id, "user-1", "ok", view)).rejects.toMatchObject(VERSION_CONFLICT);
    });

    it("is refused when it was already decided, as before", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const view = seen(pending);
      await svc.approve(pending.id, "other-user", null);

      await expect(svc.approve(pending.id, "user-1", "ok", view)).rejects.toMatchObject(VERSION_CONFLICT);
      await expect(svc.reject(pending.id, "user-1", "no", view)).rejects.toMatchObject(VERSION_CONFLICT);
    });

    it("without a content version keeps the old rule: any newer version is refused", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const sentBack = await svc.requestRevision(pending.id, "user-1", "Quote the delivery date.");
      await pause();
      await svc.resubmit(sentBack.id, { title: "First version" });

      await expect(
        svc.approve(sentBack.id, "user-1", "ok", { expectedUpdatedAt: new Date(sentBack.updatedAt.toISOString()) }),
      ).rejects.toMatchObject(VERSION_CONFLICT);
    });

    it("is refused for a forged content version", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const sentBack = await svc.requestRevision(pending.id, "user-1", "Quote the delivery date.");
      await pause();
      await svc.resubmit(sentBack.id, { title: "Changed" });

      await expect(
        svc.approve(sentBack.id, "user-1", "ok", { ...seen(sentBack), expectedContentVersion: "0".repeat(32) }),
      ).rejects.toMatchObject(VERSION_CONFLICT);
    });

    it("sends a request back that was resubmitted unchanged since the page read it", async () => {
      const companyId = await createCompany();
      const svc = approvalService(db);
      const pending = await createPending(companyId);
      const firstBack = await svc.requestRevision(pending.id, "user-1", "Quote the delivery date.");
      await pause();
      const resubmitted = await svc.resubmit(firstBack.id, { title: "First version" });
      const view = seen(resubmitted);
      // Another tab marks it sent back and resubmitted again with the same note and payload.
      await svc.requestRevision(pending.id, "user-1", "Quote the delivery date.");
      await pause();
      await svc.resubmit(pending.id, { title: "First version" });

      const updated = await svc.requestRevision(pending.id, "user-1", "Still missing the date.", view);
      expect(updated.status).toBe("revision_requested");
      expect(updated.decisionNote).toBe("Still missing the date.");
    });
  });
});
