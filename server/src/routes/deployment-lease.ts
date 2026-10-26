import { Router, type Request } from "express";
import { companies, type Db } from "@paperclipai/db";
import { deploymentLeaseService, type DeploymentLeaseAudit } from "../services/deployment-lease.js";
import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";

export async function createDeploymentLeaseRouteAudit(db: Db, req: Request,
  options: { namespace?: string; details?: Record<string, unknown> } = {}) {
  const actor = getActorInfo(req);
  const companyRows = await db.select({ id: companies.id }).from(companies);
  const publications: ActivityPublication[] = [];
  const audit: DeploymentLeaseAudit = async (tx, event, status) => {
    for (const company of companyRows) await logActivity(tx as unknown as Db, {
      companyId: company.id, actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: `${options.namespace ?? "instance.deployment_lease"}.${event}`,
      entityType: "instance_settings", entityId: "deployment-drain/v1",
      details: { ...status, ...options.details },
    }, publications);
  };
  return { audit, publish() {
    for (const publication of publications) {
      try { publishActivity(publication); }
      catch { logger.error({ action: "instance.deployment_lease.publication_failed" }, "Deployment lease audit publication failed after commit"); }
    }
  } };
}

/** Operator controls only; the owner capability is never part of public status or audit. */
export function deploymentLeaseRoutes(db: Db, options: { bootId?: string } = {}) {
  const router = Router(); const leases = deploymentLeaseService(db, options);
  router.get("/instance/deployment-lease", async (req, res) => {
    assertInstanceAdmin(req); res.setHeader("Cache-Control", "no-store");
    res.json(await leases.get());
  });
  const mutation = (operation: typeof leases.acquire | typeof leases.adopt | typeof leases.renew | typeof leases.release) => async (req: import("express").Request, res: import("express").Response) => {
      assertInstanceAdmin(req); res.setHeader("Cache-Control", "no-store");
      const history = await createDeploymentLeaseRouteAudit(db, req);
      const result = await operation(req.body, history.audit);
      history.publish();
      res.json(result);
  };
  router.post("/instance/deployment-lease", mutation(leases.acquire));
  router.post("/instance/deployment-lease/adopt", mutation(leases.adopt));
  router.post("/instance/deployment-lease/renew", mutation(leases.renew));
  router.delete("/instance/deployment-lease", mutation(leases.release));
  return router;
}
