import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { assertBoardOrgAccess, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { cloudUpstreamService, instanceSettingsService, logActivity } from "../services/index.js";

export function cloudUpstreamRoutes(db: Db, options: { instanceId?: string } = {}) {
  const router = Router();
  const service = cloudUpstreamService(db, options);
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableCloudSync !== true) {
      throw notFound("Cloud sync is not enabled");
    }
  }

  async function logCloudUpstreamActivity(
    req: Request,
    input: { companyId: string; action: string; entityType: string; entityId: string; details: Record<string, unknown> },
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details,
    });
  }

  router.get("/cloud-upstreams", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringQuery(req.query.companyId, "companyId");
    assertCompanyAccess(req, companyId);
    res.json(await service.list(companyId));
  });

  router.post("/cloud-upstreams/connect/start", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringBody(req.body, "companyId");
    assertCompanyAccess(req, companyId);
    const remoteUrl = stringBody(req.body, "remoteUrl");
    const redirectUri = stringBody(req.body, "redirectUri");
    const started = await service.startConnect({ companyId, remoteUrl, redirectUri });
    await logCloudUpstreamActivity(req, {
      companyId,
      action: "cloud_upstream.connect_started",
      entityType: "cloud_upstream_connection",
      entityId: started.connection.id,
      details: {
        remoteUrl: started.connection.remoteUrl,
        targetOrigin: started.connection.target.origin,
        targetStackId: started.connection.target.stackId,
      },
    });
    res.json(started);
  });

  router.post("/cloud-upstreams/connect/finish", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const connection = await service.finishConnect({
      pendingConnectionId: stringBody(req.body, "pendingConnectionId"),
      code: stringBody(req.body, "code"),
      state: stringBody(req.body, "state"),
      authorizeCompany: (companyId) => {
        // Same 404 as a missing id, so the response does not reveal whether a
        // connection exists in another company.
        if (!hasCompanyAccess(req, companyId)) throw notFound("Cloud upstream connection was not found");
        assertCompanyAccess(req, companyId);
      },
    });
    await logCloudUpstreamActivity(req, {
      companyId: connection.companyId,
      action: "cloud_upstream.connected",
      entityType: "cloud_upstream_connection",
      entityId: connection.id,
      details: {
        remoteUrl: connection.remoteUrl,
        targetOrigin: connection.target.origin,
        targetStackId: connection.target.stackId,
      },
    });
    res.json(connection);
  });

  router.post("/cloud-upstreams/:connectionId/push-runs/preview", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringBody(req.body, "companyId");
    assertCompanyAccess(req, companyId);
    res.json(await service.preview(req.params.connectionId, companyId));
  });

  router.post("/cloud-upstreams/:connectionId/push-runs", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringBody(req.body, "companyId");
    assertCompanyAccess(req, companyId);
    const run = await service.createRun({
      connectionId: req.params.connectionId,
      companyId,
      retryOfRunId: optionalString(req.body?.retryOfRunId),
    });
    await logCloudUpstreamActivity(req, {
      companyId,
      action: "cloud_upstream.push_run_created",
      entityType: "cloud_upstream_run",
      entityId: run.id,
      details: {
        connectionId: run.connectionId,
        status: run.status,
        targetUrl: run.targetUrl,
        retryOfRunId: run.retryOfRunId,
      },
    });
    res.json(run);
  });

  router.get("/cloud-upstreams/:connectionId/push-runs/:runId", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringQuery(req.query.companyId, "companyId");
    assertCompanyAccess(req, companyId);
    res.json(await service.readRun(req.params.connectionId, req.params.runId, companyId));
  });

  router.post("/cloud-upstreams/:connectionId/push-runs/:runId/cancel", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringBody(req.body, "companyId");
    assertCompanyAccess(req, companyId);
    const before = await service.readRun(req.params.connectionId, req.params.runId, companyId);
    const run = await service.cancelRun(req.params.connectionId, req.params.runId, companyId);
    // cancelRun returns finished runs unchanged; only log an actual cancellation.
    if (before.status === "running" && run.status === "cancelled") {
      await logCloudUpstreamActivity(req, {
        companyId,
        action: "cloud_upstream.push_run_cancelled",
        entityType: "cloud_upstream_run",
        entityId: run.id,
        details: { connectionId: run.connectionId },
      });
    }
    res.json(run);
  });

  router.post("/cloud-upstreams/:connectionId/push-runs/:runId/activation", async (req, res) => {
    assertBoardOrgAccess(req);
    await assertEnabled();
    const companyId = stringBody(req.body, "companyId");
    assertCompanyAccess(req, companyId);
    const entityType = activationEntityTypeBody(req.body);
    const run = await service.activateRunEntities({
      connectionId: req.params.connectionId,
      runId: req.params.runId,
      companyId,
      entityType,
    });
    await logCloudUpstreamActivity(req, {
      companyId,
      action: "cloud_upstream.push_run_entities_activated",
      entityType: "cloud_upstream_run",
      entityId: run.id,
      details: { connectionId: run.connectionId, activatedEntityType: entityType },
    });
    res.json(run);
  });

  return router;
}

function stringQuery(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${label} is required`);
  }
  return value;
}

function stringBody(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(`${key} is required`);
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${key} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function activationEntityTypeBody(body: unknown): "agents" | "routines" | "monitors" {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("entityType is required");
  }
  const value = (body as Record<string, unknown>).entityType;
  if (value !== "agents" && value !== "routines" && value !== "monitors") {
    throw badRequest("entityType must be agents, routines, or monitors");
  }
  return value;
}
