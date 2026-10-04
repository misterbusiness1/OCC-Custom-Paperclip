// Worker for the isolated PostgreSQL crash regression. The test harness passes
// its ephemeral connection over stdin instead of logging it in process arguments.
import { createDb, agentWakeupRequests } from "@paperclipai/db";
import { issueCommentRequestService } from "../../services/issue-comment-requests.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { connectionString, companyId, requestId, agentId } = JSON.parse(input);
const db = createDb(connectionString, { maxConnections: 1 });
const service = issueCommentRequestService(db, {
  controls: () => ({ admission: true, dispatch: true }),
  authorize: async () => true,
  handlers: {
    wake: { execute: async (request, effect) => {
      await db.insert(agentWakeupRequests).values({
        companyId: request.companyId, agentId, source: "automation", reason: "issue_commented",
        status: "queued", idempotencyKey: effect.idempotencyKey,
        requestedByActorType: "user", requestedByActorId: request.authorUserId,
        payload: { issueId: request.issueId, commentId: request.commentId },
      });
      // Deliberately die after durable admission and before recording receipt.
      process.kill(process.pid, "SIGKILL");
      return {};
    } },
  },
});
await service.dispatchOne(companyId, requestId);
process.exitCode = 99;
