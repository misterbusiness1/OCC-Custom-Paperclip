import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  buildHydratedApprovalDetail,
  buildHydratedApprovalDetailV3,
  createApprovalSchema,
  requestBoardApprovalPayloadSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { badRequest, forbidden, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// Mirrors KNOWN_INSTRUCTIONS_BUNDLE_KEYS in routes/agents.ts.
const HIRE_INSTRUCTIONS_CONFIG_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
] as const;

function readPayloadAgentId(payload: Record<string, unknown> | null | undefined): string | null {
  const value = payload?.agentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

function isStatusOnlyCheapRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.modelProfile === "cheap" &&
    context.recoveryIntent === "status_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === false &&
    context.resumeRequiresNormalModel === true;
}

function verifyGateBBodyHash(payload: Record<string, unknown>) {
  if (payload.gate !== "gate_b") return;
  if (payload.bodyHash === undefined) return;
  const body = typeof payload.body === "string" ? payload.body : "";
  const expectedHash = `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
  if (payload.bodyHash !== expectedHash) {
    throw badRequest("Validation error", [
      {
        code: "custom",
        message: "bodyHash must match sha256(body)",
        path: ["payload", "bodyHash"],
      },
    ]);
  }
}

function validateRequestBoardApprovalPayload(payload: unknown): Record<string, unknown> {
  const result = requestBoardApprovalPayloadSchema.safeParse(payload);
  if (!result.success) {
    throw badRequest(
      "Validation error",
      result.error.issues.map((issue) => ({
        ...issue,
        path: ["payload", ...issue.path],
      })),
    );
  }
  return result.data;
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval || !hasCompanyAccess(req, approval.companyId)) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(req: Request, res: any, companyId: string) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const redacted = redactApprovalPayload(approval);
    if (req.query.v === "3") {
      res.json(buildHydratedApprovalDetailV3(redacted));
      return;
    }
    if (req.query.v === "2") {
      res.json(buildHydratedApprovalDetail(redacted));
      return;
    }
    res.json(redacted);
  });

  // A hire_agent approval that names payload.agentId activates (and applies its
  // config to) that agent on approval and terminates it on rejection. Only the
  // agent-hires flow creates the pending agent and its approval together, so the
  // generic route never accepts one: a second approval for an agent that is
  // already awaiting its own would let the board approve a payload it never saw.
  function assertGenericHirePayloadHasNoAgentId(payload: Record<string, unknown>) {
    if (payload.agentId === undefined || payload.agentId === null) return;
    throw unprocessable(
      "hire_agent approvals created here cannot reference an existing agent (payload.agentId). " +
        "Use POST /api/companies/:companyId/agent-hires to create a pending hire approval.",
    );
  }

  // A hire_agent approval created through the generic approvals endpoint turns
  // into an agent when approved, so it gets the same guards as
  // POST /companies/:companyId/agent-hires: the caller needs agents:create, the
  // adapter type must be known (no silent "process" default), and agents
  // cannot set instructions paths or host-executed workspace commands.
  async function assertGenericHireApprovalAllowed(
    req: Request,
    companyId: string,
    payload: Record<string, unknown>,
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation ?? "Not allowed to request new agents for this company");
    }

    const adapterType = typeof payload.adapterType === "string" ? payload.adapterType.trim() : "";
    if (!adapterType && !readPayloadAgentId(payload)) {
      throw unprocessable("payload.adapterType is required for hire_agent approvals");
    }
    // Loaded lazily: the adapter registry pulls in every adapter package, and
    // only hire approvals need it.
    const { findServerAdapter } = await import("../adapters/registry.js");
    if (adapterType && !findServerAdapter(adapterType)) {
      throw unprocessable(`Unknown adapter type: ${adapterType}`);
    }

    if (req.actor.type !== "agent") return;
    const adapterConfig =
      payload.adapterConfig && typeof payload.adapterConfig === "object" && !Array.isArray(payload.adapterConfig)
        ? (payload.adapterConfig as Record<string, unknown>)
        : {};
    const instructionKeys = HIRE_INSTRUCTIONS_CONFIG_KEYS
      .filter((key) => adapterConfig[key] !== undefined)
      .map((key) => `payload.adapterConfig.${key}`);
    if (instructionKeys.length > 0) {
      throw forbidden(
        `Agent-authenticated callers cannot set instructions path or bundle configuration (${instructionKeys.join(", ")})`,
      );
    }
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectAgentAdapterWorkspaceCommandPaths(adapterConfig, "payload.adapterConfig"),
    );
  }

  // The requester is woken when an approval resolves, so it must be the calling
  // agent itself, or (for board users) an agent in the same company.
  async function resolveRequestedByAgentId(
    actor: ReturnType<typeof getActorInfo>,
    companyId: string,
    bodyRequestedByAgentId: string | null,
  ): Promise<string | null> {
    if (actor.actorType === "agent") {
      // UUIDs are case-insensitive; always store the caller's own id.
      if (bodyRequestedByAgentId && bodyRequestedByAgentId.toLowerCase() !== actor.actorId.toLowerCase()) {
        throw forbidden("Agents can only request approvals as themselves");
      }
      return actor.actorId;
    }
    if (!bodyRequestedByAgentId) return null;
    const requester = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, bodyRequestedByAgentId))
      .then((rows) => rows[0] ?? null);
    if (!requester || requester.companyId !== companyId) {
      throw unprocessable("requestedByAgentId must reference an agent in this company");
    }
    return bodyRequestedByAgentId;
  }

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds)).sort();
    const { issueIds: _issueIds, idempotencyKey: bodyIdempotencyKey, ...approvalInput } = req.body;
    const headerIdempotencyKey = req.header("idempotency-key")?.trim();
    const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey || null;

    const actor = getActorInfo(req);
    const requestedByAgentId = await resolveRequestedByAgentId(
      actor,
      companyId,
      approvalInput.requestedByAgentId ?? null,
    );
    const requestedByUserId = actor.actorType === "user" ? actor.actorId : null;

    let normalizedPayload: Record<string, unknown> = approvalInput.payload;
    if (approvalInput.type === "hire_agent") {
      assertGenericHirePayloadHasNoAgentId(approvalInput.payload);
      await assertGenericHireApprovalAllowed(req, companyId, approvalInput.payload);
      normalizedPayload = await secretsSvc.normalizeHireApprovalPayloadForPersistence(
        companyId,
        approvalInput.payload,
        { strictMode: strictSecretsMode },
      );
    } else if (approvalInput.type === "request_board_approval") {
      normalizedPayload = {
        ...approvalInput.payload,
        requestedByAgentId: requestedByAgentId ?? approvalInput.payload.requestedByAgentId,
      };
      verifyGateBBodyHash(normalizedPayload);
    }

    const approvalData = {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId,
      requestedByAgentId,
      status: "pending" as const,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    };

    const creation = idempotencyKey
      ? await svc.createWithIdempotency(companyId, approvalData, idempotencyKey, uniqueIssueIds)
      : { approval: await svc.create(companyId, approvalData), replayed: false };
    const { approval, replayed } = creation;

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    if (!replayed) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, issueIds: uniqueIssueIds },
      });
    }

    res.status(replayed ? 200 : 201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.approve(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId))) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    let normalizedPayload: Record<string, unknown> | undefined;
    if (req.body.payload) {
      if (existing.type === "hire_agent") {
        const previousAgentId = readPayloadAgentId(existing.payload as Record<string, unknown>);
        const nextAgentId = readPayloadAgentId(req.body.payload);
        if (nextAgentId !== previousAgentId) {
          throw unprocessable("Resubmitting a hire approval cannot change payload.agentId");
        }
        normalizedPayload = await secretsSvc.normalizeHireApprovalPayloadForPersistence(
          existing.companyId,
          req.body.payload,
          { strictMode: strictSecretsMode },
        );
      } else if (existing.type === "request_board_approval") {
        normalizedPayload = validateRequestBoardApprovalPayload(req.body.payload);
        verifyGateBBodyHash(normalizedPayload);
      } else {
        normalizedPayload = req.body.payload;
      }
    }
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId))) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
