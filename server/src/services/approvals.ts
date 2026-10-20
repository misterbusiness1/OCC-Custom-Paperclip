import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvalComments, approvals, issueApprovals, issues } from "@paperclipai/db";
import { approvalChangeRequestCommentBody, isUuidLike } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { approvalContentVersion, isSameRequestStatusMove, nextApprovalUpdatedAt } from "./approval-version.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

export function approvalService(db: Db) {
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
  type DecisionOptions = {
    expectedUpdatedAt?: Date;
    /**
     * The `contentVersion` and `status` of the approval the caller decided on. Optional. When both
     * are sent with `expectedUpdatedAt`, a newer version that still asks the same thing (the same
     * content, and only a resubmission between) is decided instead of refused with 409.
     */
    expectedContentVersion?: string;
    expectedStatus?: string;
  };

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

  /**
   * The version a decision's write is guarded with: the one the caller named, or, when the approval
   * has moved on but still asks the same thing (see `DecisionOptions`), the version just read.
   * Undefined when the caller named none. Throws 409 for any other newer version.
   */
  function admittedVersion(
    current: ApprovalRecord,
    options: DecisionOptions | undefined,
    decidableStatuses: ReadonlySet<string>,
  ): Date | undefined {
    const expected = options?.expectedUpdatedAt;
    if (!expected) return undefined;
    if (current.updatedAt.getTime() === expected.getTime()) return expected;
    if (
      options.expectedContentVersion
      && options.expectedStatus
      && decidableStatuses.has(current.status)
      && isSameRequestStatusMove(options.expectedStatus, current.status)
      && approvalContentVersion(current) === options.expectedContentVersion
    ) {
      return current.updatedAt;
    }
    throw versionConflict(current, expected);
  }

  // The API returns milliseconds; a row written by now() holds microseconds.
  // Compare at millisecond precision, or such a row could never match.
  function versionIs(expected: Date) {
    return sql`date_trunc('milliseconds', ${approvals.updatedAt}) = ${expected.toISOString()}::timestamptz`;
  }

  function hireTargetAgentId(payload: Record<string, unknown>) {
    if (payload.agentId == null) return null;
    if (typeof payload.agentId !== "string" || !isUuidLike(payload.agentId)) {
      throw conflict("Hire approval target must be a pending approval agent in this company");
    }
    return payload.agentId;
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
    applyDecision?: (approval: ApprovalRecord, txDb: Db) => Promise<void>,
  ): Promise<ResolutionResult> {
    const refused = () => unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
    let current = await getExistingApproval(id);
    // Two passes at most: a write that missed because the approval was resubmitted unchanged in
    // between is tried once more against the version read then.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Checked first: a caller that names a version is not told "already approved"
      // for an approval that someone else decided.
      const expected = admittedVersion(current, options, canResolveStatuses);
      if (!canResolveStatuses.has(current.status)) {
        if (current.status === targetStatus) {
          return { approval: current, applied: false };
        }
        throw refused();
      }

      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const row = await tx.update(approvals)
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
        // Use the payload returned by the guarded write: an unversioned decision
        // may race with resubmission, and must act on the payload it actually decided.
        // Target/config/budget failures roll back the approval as well.
        if (row && applyDecision) await applyDecision(row, tx as unknown as Db);
        return row;
      });

      if (updated) {
        return { approval: updated, applied: true };
      }

      current = await getExistingApproval(id);
      if (!expected || current.updatedAt.getTime() === expected.getTime()) break;
    }

    admittedVersion(current, options, canResolveStatuses);
    if (current.status === targetStatus) {
      return { approval: current, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    // A retirement is a board disposition of obsolete closed work, not an
    // instruction for the requester to act on a normal rejection.
    retire: async (
      id: string,
      companyId: string,
      decidedByUserId: string,
      decisionNote: string,
      options: { expectedUpdatedAt: Date },
    ): Promise<ResolutionResult> => {
      if (!isUuidLike(id)) throw notFound("Approval not found");
      if (!options?.expectedUpdatedAt || !Number.isFinite(options.expectedUpdatedAt.getTime()) || !decisionNote?.trim()) {
        throw unprocessable("Retirement requires the exact approval version and a reason");
      }
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        // FOR UPDATE (not the ordinary status UPDATE's NO KEY UPDATE) also
        // fences new issue_approvals inserts through their immediate parent FK.
        const [current] = await tx.select().from(approvals).where(and(
          eq(approvals.id, id), eq(approvals.companyId, companyId),
        )).for("update");
        if (!current) throw notFound("Approval not found");
        assertExpectedVersion(current, options.expectedUpdatedAt);
        if (current.type !== "request_board_approval") {
          throw unprocessable("Only closed-work board requests can be retired");
        }
        if (current.status === "rejected") {
          const [priorRetirement] = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
            eq(activityLog.companyId, companyId), eq(activityLog.entityType, "approval"),
            eq(activityLog.entityId, id), eq(activityLog.action, "approval.retired_closed_request"),
          )).limit(1);
          if (priorRetirement?.details?.approvalUpdatedAt === current.updatedAt.toISOString()
            && current.decisionNote === decisionNote) return { approval: current, applied: false };
          throw conflict("This approval was already decided outside this retirement");
        }
        if (!canResolveStatuses.has(current.status)) {
          throw unprocessable("Only pending or revision requested approvals can be retired");
        }
        // Lock existing links against unlink/reassignment, then the tasks in a
        // stable order. All eligibility checks use these locked rows, not the
        // route's earlier access check or a caller-provided list of task IDs.
        const links = await tx.select().from(issueApprovals).where(eq(issueApprovals.approvalId, id))
          .orderBy(asc(issueApprovals.issueId)).for("update");
        if (links.length === 0 || links.some((link) => link.companyId !== companyId)) {
          throw conflict("Retirement requires same-company closed linked tasks");
        }
        const linkedIssues = await tx.select().from(issues).where(inArray(issues.id, links.map((link) => link.issueId)))
          .orderBy(asc(issues.id)).for("update");
        if (linkedIssues.length !== links.length || linkedIssues.some((issue) =>
          issue.companyId !== companyId || !["done", "cancelled"].includes(issue.status)
          || issue.executionRunId !== null || issue.checkoutRunId !== null
          || issue.executionAgentNameKey !== null || issue.executionLockedAt !== null)) {
          throw conflict("Retirement requires same-company closed linked tasks without execution ownership");
        }
        const now = new Date();
        const [approval] = await tx.update(approvals).set({
          status: "rejected", decidedByUserId, decisionNote, decidedAt: now,
          updatedAt: nextApprovalUpdatedAt(now),
        }).where(and(eq(approvals.id, id), eq(approvals.companyId, companyId), versionIs(options.expectedUpdatedAt)))
          .returning();
        if (!approval) throw versionConflict(current, options.expectedUpdatedAt);
        const details = {
          type: approval.type, approvalStatus: "rejected", requestedByAgentId: approval.requestedByAgentId,
          // Approval cards read requestedByAgentId; wake audit consumers read requesterAgentId.
          requesterAgentId: approval.requestedByAgentId,
          linkedIssueIds: linkedIssues.map((issue) => issue.id),
          linkedIssueStatuses: linkedIssues.map((issue) => ({ id: issue.id, status: issue.status })),
          reason: "closed_request_retired", executionSuppressed: true,
          approvalUpdatedAt: approval.updatedAt.toISOString(),
        };
        // Neither action maps to approval.decided/plugin execution. Persist
        // both before commit; publish only the committed, non-executable audit.
        // The skipped wake record explicitly distinguishes this intentional
        // no-execution disposition from a missing or failed decision delivery.
        for (const action of ["approval.retired_closed_request", "approval.requester_wakeup_skipped"]) {
          await logActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: decidedByUserId,
            action, entityType: "approval", entityId: id, details }, publications);
        }
        return { approval, applied: true };
      });
      for (const publication of publications) publishActivity(publication);
      return result;
    },

    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    /**
     * The board's queue: every open approval (pending or sent back) and the `decidedLimit` most
     * recently decided ones, newest decision first. `decidedHasMore` says whether older decided
     * approvals exist beyond that window.
     */
    listQueue: async (companyId: string, decidedLimit: number) => {
      const openStatuses = ["pending", "revision_requested"];
      const open = await db.select().from(approvals)
        .where(and(eq(approvals.companyId, companyId), inArray(approvals.status, openStatuses)));
      const decided = decidedLimit > 0
        ? await db.select().from(approvals)
          .where(and(eq(approvals.companyId, companyId), sql`${approvals.status} not in ('pending', 'revision_requested')`))
          .orderBy(desc(sql`coalesce(${approvals.decidedAt}, ${approvals.updatedAt})`), desc(approvals.id))
          .limit(decidedLimit + 1)
        : [];
      return {
        approvals: [...open, ...decided.slice(0, decidedLimit)],
        decidedHasMore: decided.length > decidedLimit,
      };
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
      let hireApprovedAgentId: string | null = null;
      const postCommitPublications: ActivityPublication[] = [];
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
        options,
        async (updated, txDb) => {
          if (updated.type !== "hire_agent") return;
          const agentsSvc = agentService(txDb);
          const budgets = budgetService(txDb);
          const payload = updated.payload as Record<string, unknown>;
          const payloadAgentId = hireTargetAgentId(payload);
          if (payloadAgentId) {
            const activation = await agentsSvc.activatePendingApproval(
              updated.companyId, payloadAgentId, payload, postCommitPublications,
            );
            if (!activation?.activated) {
              throw conflict("Hire approval target must be a pending approval agent in this company");
            }
            hireApprovedAgentId = activation.agent.id;
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
            }, { postCommitPublications });
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
                postCommitPublications,
              );
            }
          }
        },
      );
      for (const publication of postCommitPublications) publishActivity(publication);
      if (applied && hireApprovedAgentId) {
        if (hireTargetAgentId(updated.payload)) {
          await reconcileApprovedBuiltInAgent(updated.companyId, updated.payload);
        }
        void notifyHireApproved(db, {
          companyId: updated.companyId,
          agentId: hireApprovedAgentId,
          source: "approval",
          sourceId: id,
          approvedAt: updated.decidedAt ?? new Date(),
        }).catch(() => {});
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
        async (updated, txDb) => {
          if (updated.type !== "hire_agent") return;
          const payload = updated.payload as Record<string, unknown>;
          const payloadAgentId = hireTargetAgentId(payload);
          if (payloadAgentId) {
            const rejected = await agentService(txDb).rejectPendingApproval(updated.companyId, payloadAgentId);
            if (!rejected) {
              throw conflict("Hire approval target must be a pending approval agent in this company");
            }
          }
        },
      );

      return { approval: updated, applied };
    },

    requestRevision: async (
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      options?: DecisionOptions,
    ) => {
      const revisableStatuses = new Set(["pending"]);
      let current = await getExistingApproval(id);
      admittedVersion(current, options, revisableStatuses);
      if (current.status !== "pending") {
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

      // Two passes at most, as for approve and reject.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const expected = admittedVersion(current, options, revisableStatuses);
        if (current.status !== "pending") break;
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

        current = await getExistingApproval(id);
        if (!expected || current.updatedAt.getTime() === expected.getTime()) break;
      }

      admittedVersion(current, options, revisableStatuses);
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
