import { Router } from "express";
import { sql } from "drizzle-orm";
import { issueCommentRequests, type Db } from "@paperclipai/db";
import { issueCommentRequestService } from "../services/issue-comment-requests.js";
import { authorizeBoardCommentRequest } from "../services/board-comment-request-authority.js";
import { issueService } from "../services/issues.js";
import { notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { boardCommentRequestOperationalSnapshot } from "../services/board-comment-request-operational.js";

/** Process-local evidence: operators must collect this from every serving writer. */
export function boardCommentRequestProtocolRoutes(db?: Db) {
  const router = Router();
  router.get("/board-comment-request-protocol", async (req, res) => {
    assertInstanceAdmin(req);
    res.setHeader("Cache-Control", "no-store");
    const snapshot = boardCommentRequestOperationalSnapshot();
    if (!db) { res.json(snapshot); return; }
    const [queue] = await db.select({
      pendingCount: sql<number>`count(*) filter (where ${issueCommentRequests.status} = 'pending')::int`,
      reconciliationRequiredCount: sql<number>`count(*) filter (where ${issueCommentRequests.status} = 'reconciliation_required')::int`,
      oldestPendingAgeSeconds: sql<number>`coalesce(extract(epoch from (now() - min(${issueCommentRequests.createdAt}) filter (where ${issueCommentRequests.status} = 'pending'))), 0)::float8`,
    }).from(issueCommentRequests);
    res.json({ ...snapshot, queue });
  });
  if (db) {
    const ledger = issueCommentRequestService(db, { authorize: authorizeBoardCommentRequest, handlers: {} });
    router.get("/issues/:id/comment-requests/:clientRequestId", async (req, res) => {
      assertBoard(req);
      const issue = await issueService(db).getById(String(req.params.id));
      if (!issue) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);
      const actor = getActorInfo(req);
      res.setHeader("Cache-Control", "no-store");
      res.json(await ledger.status({ companyId: issue.companyId, issueId: issue.id,
        authorUserId: actor.actorId, clientRequestId: String(req.params.clientRequestId) }));
    });
  }
  return router;
}
