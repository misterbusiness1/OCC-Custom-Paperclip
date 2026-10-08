import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { approvalChangeRequestCommentBody, isUuidLike } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { nextApprovalUpdatedAt } from "./approval-version.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };
  /**
   * `expectedUpdatedAt` is the `updatedAt` of the approval the caller decided on.
   * When given, the decision is refused with 409 if the approval has changed since.
   * Every write to an approval moves `updatedAt` to a later millisecond
   * (`nextApprovalUpdatedAt`), so it works as a version.
   */
  type DecisionOptions = { expectedUpdatedAt?: Date };

  function versionConflict(current: ApprovalRecord, expected: Date) {
    return conflict("This request changed after you opened it. Reload it and decide again.", {
      code: "approval_version_conflict",
      currentStatus: current.status,
      currentUpdatedAt: current.updatedAt.toISOString(),
      expectedUpdatedAt: expected.toISOString(),
    });
  }

  function assertExpectedVersion(current: ApprovalRecord, expected: Date | undefined) {
    if (expected && current.updatedAt.getTime() !== expected.getTime()) {
      throw versionConflict(current, expected);
    }
  }

  // The API returns milliseconds; a row written by now() holds microseconds.
  // Compare at millisecond precision, or such a row could never match.
  function versionIs(expected: Date) {
    return sql`date_trunc('milliseconds', ${approvals.updatedAt}) = ${expected.toISOString()}::timestamptz`;
  }

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function reconcileApprovedBuiltInAgent(companyId: string, payload: Record<string, unknown>) {
    const sourceBuiltInAgentKey = typeof payload.sourceBuiltInAgentKey === "string" ? payload.sourceBuiltInAgentKey : null;
    if (!sourceBuiltInAgentKey) return;
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(db).ensure(companyId, sourceBuiltInAgentKey);
  }

  async function getExistingApproval(id: string) {
    if (!isUuidLike(id)) throw notFound("Approval not found");
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
    options?: DecisionOptions,
  ): Promise<ResolutionResult> {
    const expected = options?.expectedUpdatedAt;
    const existing = await getExistingApproval(id);
    // Checked first: a caller that names a version is not told "already approved"
    // for an approval that someone else decided.
    assertExpectedVersion(existing, expected);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: nextApprovalUpdatedAt(now),
      })
      .where(
        and(
          eq(approvals.id, id),
          inArray(approvals.status, resolvableStatuses),
          // The version is checked again in the write, so a change between the read and the write is caught.
          ...(expected ? [versionIs(expected)] : []),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    assertExpectedVersion(latest, expected);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      isUuidLike(id)
        ? db
          .select()
          .from(approvals)
          .where(eq(approvals.id, id))
          .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    // Cancel an open (pending/revision_requested) approval without a board
    // decision — e.g. when its paired agent is terminated during duplicate
    // cleanup. Idempotent: a no-op on already-resolved approvals.
    cancel: async (id: string, reason?: string | null) => {
      if (!isUuidLike(id)) return null;
      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "cancelled",
          decisionNote: reason ?? null,
          decidedAt: now,
          updatedAt: nextApprovalUpdatedAt(now),
        })
        .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated;
    },

    approve: async (
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      options?: DecisionOptions,
    ) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
        options,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId, payload);
          await reconcileApprovedBuiltInAgent(updated.companyId, payload);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      return { approval: updated, applied };
    },

    reject: async (
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      options?: DecisionOptions,
    ) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
        options,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      options?: DecisionOptions,
    ) => {
      const expected = options?.expectedUpdatedAt;
      const existing = await getExistingApproval(id);
      assertExpectedVersion(existing, expected);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      // The change request is also kept as a comment: `decisionNote` is
      // overwritten by the next decision, the discussion is not. The body is
      // redacted like any other approval comment.
      const note = typeof decisionNote === "string" && decisionNote.trim().length > 0 ? decisionNote : null;
      const commentBody = note
        ? redactCurrentUserText(approvalChangeRequestCommentBody(note), {
            enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
          })
        : null;

      const now = new Date();
      // One transaction: the comment exists only when this call sent the request
      // back. A refused call (409, 422) and a retry of a stored one write nothing.
      const updated = await db.transaction(async (tx) => {
        const row = await tx
          .update(approvals)
          .set({
            status: "revision_requested",
            decidedByUserId,
            decisionNote: decisionNote ?? null,
            decidedAt: now,
            updatedAt: nextApprovalUpdatedAt(now),
          })
          // The status, and the version when one is given, are checked again in the
          // write: a request decided or resubmitted since the read is not overwritten.
          .where(
            and(
              eq(approvals.id, id),
              eq(approvals.status, "pending"),
              ...(expected ? [versionIs(expected)] : []),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (row && commentBody) {
          await tx.insert(approvalComments).values({
            companyId: row.companyId,
            approvalId: row.id,
            authorAgentId: null,
            authorUserId: decidedByUserId,
            body: commentBody,
            createdAt: now,
            updatedAt: now,
          });
        }
        return row;
      });
      if (updated) return updated;

      const latest = await getExistingApproval(id);
      assertExpectedVersion(latest, expected);
      throw unprocessable("Only pending approvals can request revision");
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      // decisionNote is left as it is: it holds the board's change request, so the
      // revision can be read against it. The next decision overwrites it; the
      // comment requestRevision wrote keeps it.
      const updated = await db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: nextApprovalUpdatedAt(now),
        })
        // The status is checked again in the write: a request decided or
        // resubmitted since the read above is not set back to pending.
        .where(and(eq(approvals.id, id), eq(approvals.status, "revision_requested")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }
      return updated;
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
