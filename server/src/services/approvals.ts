import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

const APPROVAL_IDEMPOTENCY_CONSTRAINT = "approvals_company_idempotency_key_uq";

function isApprovalIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = err.constraint ?? err.constraint_name;
  return err.code === "23505" && constraint === APPROVAL_IDEMPOTENCY_CONSTRAINT;
}

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };
  type CreationResult = { approval: ApprovalRecord; replayed: boolean };

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
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJson(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function hashApprovalCreateRequest(
    companyId: string,
    data: Omit<typeof approvals.$inferInsert, "companyId">,
    issueIds: string[],
  ): string {
    const request = {
      companyId,
      type: data.type,
      requestedByAgentId: data.requestedByAgentId ?? null,
      requestedByUserId: data.requestedByUserId ?? null,
      payload: data.payload,
      status: data.status ?? "pending",
      issueIds,
    };
    return createHash("sha256").update(stableJson(request)).digest("hex");
  }

  async function findByIdempotencyKey(companyId: string, idempotencyKey: string) {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.idempotencyKey, idempotencyKey)))
      .then((rows) => rows[0] ?? null);
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
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
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
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
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

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

    createWithIdempotency: async (
      companyId: string,
      data: Omit<typeof approvals.$inferInsert, "companyId" | "idempotencyKey" | "idempotencyRequestHash">,
      idempotencyKey: string,
      issueIds: string[] = [],
    ): Promise<CreationResult> => {
      const canonicalIssueIds = Array.from(new Set(issueIds)).sort();
      const requestHash = hashApprovalCreateRequest(companyId, data, canonicalIssueIds);
      const existing = await findByIdempotencyKey(companyId, idempotencyKey);
      if (existing) {
        if (existing.idempotencyRequestHash !== requestHash) {
          throw conflict("Approval idempotency key already exists for a different request", {
            idempotencyKey,
          });
        }
        return { approval: existing, replayed: true };
      }

      let inserted: ApprovalRecord;
      try {
        inserted = await db
          .insert(approvals)
          .values({ ...data, companyId, idempotencyKey, idempotencyRequestHash: requestHash })
          .returning()
          .then((rows) => rows[0]);
      } catch (error) {
        if (!isApprovalIdempotencyConflict(error)) throw error;

        const winner = await findByIdempotencyKey(companyId, idempotencyKey);
        if (!winner) throw error;
        if (winner.idempotencyRequestHash !== requestHash) {
          throw conflict("Approval idempotency key already exists for a different request", {
            idempotencyKey,
          });
        }
        return { approval: winner, replayed: true };
      }

      return { approval: inserted, replayed: false };
    },

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
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

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
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

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
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
      const redactedBody = redactSensitiveText(redactCurrentUserText(body, currentUserRedactionOptions));
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
