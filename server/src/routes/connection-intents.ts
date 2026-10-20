import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { Router, type Request } from "express";
import type { ZodError } from "zod";
import type { Db } from "@paperclipai/db";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
  completeConnectionIntentSchema,
  connectionRequestInputSchema,
  connectionsSearchInputSchema,
  declineConnectionIntentSchema,
} from "@paperclipai/shared";
import { HttpError, forbidden, unauthorized } from "../errors.js";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { typeSafeJudgeInputSchema, typeSafeRuntimeToolService, typeSafeToolEnabled } from "../services/typesafe-runtime-tool.js";

function bearer(req: Request) {
  const value = req.header("authorization") ?? "";
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
}

function runtimeClaims(req: Request) {
  const claims = verifyRuntimeToolsToken(bearer(req));
  if (!claims) throw unauthorized("Runtime tools token is missing, invalid, or expired");
  return claims;
}

const TYPESAFE_JUDGE_INPUT_HINT = "criteria is JSON, never text. choice: {\"option_id\":\"meaning\",\"other_id\":\"meaning\"}. score: [\"lowest level\",\"next level\",\"highest level\"]. noul: leave criteria out, or {\"true\":\"what yes means\",\"false\":\"what no means\"}.";

const TYPESAFE_QUESTION_ID_RULE = "A question ID starts with a letter and holds only letters, digits, \"_\" or \"-\", 64 characters at most.";
const TYPESAFE_OPTION_ID_RULE = "A choice option ID holds 1 to 128 characters.";

/** What a caller must change, one entry per path, without any input value. */
function typeSafeInputIssues(error: ZodError) {
  const issues: Array<{ path: string; message: string }> = [];
  const seen = new Set<string>();
  for (const issue of error.issues) {
    const joined = issue.path.join(".");
    // The path repeats the caller's own keys. Bound it, so a huge key cannot
    // come back as a huge result.
    const path = joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
    // For a value of the wrong type Zod also reports the checks it could not
    // apply: prose where a Score needs an array comes back as "expected array"
    // and then "string too long", from the level limit. Only the first issue at
    // a path says what to change.
    if (seen.has(path)) continue;
    seen.add(path);
    // Zod reports a rejected record key as "Invalid key in record" for both
    // records in this input: `questions.<id>` and a Choice's
    // `questions.<id>.criteria.<option>`. State the rule that was broken.
    const message = issue.code !== "invalid_key"
      ? issue.message
      : issue.path.length === 2 ? TYPESAFE_QUESTION_ID_RULE : TYPESAFE_OPTION_ID_RULE;
    issues.push({ path, message });
    if (issues.length === 8) break;
  }
  return issues;
}

/**
 * An outcome of a tool call that the calling agent should read and act on:
 * malformed arguments, an unknown service, a request the user declined. Over
 * MCP these are tool results. An HTTP error status on `tools/call` reads as a
 * failed transport to a Streamable HTTP client, and the agent never sees why.
 * Authentication, authority and server faults are not for the agent to work
 * around, so they stay HTTP errors.
 */
function toolCallFailure(err: unknown) {
  const zodIssues = (err as { name?: unknown; issues?: unknown } | null)?.name === "ZodError"
    ? (err as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues
    : null;
  if (zodIssues) {
    return {
      error: "Invalid arguments",
      status: 400,
      issues: zodIssues.slice(0, 8).map((issue) => ({ path: issue.path.join(".").slice(0, 200), message: issue.message })),
    };
  }
  if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403) {
    return { error: err.message, status: err.status };
  }
  return null;
}

function resultContent(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../services/connection-tool-definitions.js";
import { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../services/connection-tool-definitions.js";

/** Public, token-authenticated routes mounted before the general actor middleware. */
export function runtimeConnectionIntentRoutes(db: Db) {
  const router = Router();
  const service = connectionIntentService(db);
  const typeSafe = typeSafeRuntimeToolService(db);

  async function searchConnections(claims: ReturnType<typeof runtimeClaims>, args: unknown) {
    const input = connectionsSearchInputSchema.parse(args ?? {});
    return service.search(claims, input.query, { retryProviderChoice: input.retryProviderChoice });
  }

  async function requestConnection(claims: ReturnType<typeof runtimeClaims>, args: unknown) {
    const input = connectionRequestInputSchema.parse(args ?? {});
    return service.request(claims, input.service, {
      selectionInteractionId: input.selectionInteractionId,
      targetService: input.targetService,
    });
  }

  router.post("/runtime-tools/github/credentials", async (req, res) => {
    // This capability is never accepted as board/session authentication.
    // Node fetch sends Sec-Fetch-Mode too; browsers additionally send Origin or Sec-Fetch-Site.
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"]) throw forbidden("GitHub credentials require runtime authentication");
    const claims = verifyRuntimeToolsToken(typeof req.headers["x-paperclip-github-capability"] === "string"
      ? req.headers["x-paperclip-github-capability"] : bearer(req), "github_credentials");
    if (!claims) throw unauthorized("Invalid GitHub runtime capability");
    res.setHeader("Cache-Control", "no-store");
    res.json(await resolveGitHubOperationCredentials(db, {
      companyId: claims.company_id, agentId: claims.sub, runId: claims.run_id,
    }));
  });

  router.get("/mcp/runtime-tools", async (req, res) => {
    await service.validate(runtimeClaims(req));
    // A Streamable HTTP client issues GET to open the server-to-client SSE
    // stream. This endpoint is POST only, and the protocol's answer for that is
    // 405. A 200 body reads as a stream that ended at once, and a client that
    // reconnects (Kimi's does, about once a second) then polls for the whole run.
    res.set("Allow", "POST").status(405).end();
  });

  router.post("/mcp/runtime-tools", async (req, res) => {
    const claims = runtimeClaims(req);
    // Streamable HTTP lifecycle calls are token uses too. Revalidate the bound
    // run before initialize/list as well as before an actual tool call so an
    // ended heartbeat cannot keep probing the endpoint with a once-valid token.
    await service.validate(claims);
    // One JSON-RPC message per POST. A missing body, a non-JSON body or a batch
    // array is the caller's mistake, not a server fault.
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC request object" } });
      return;
    }
    const request = req.body as { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
    // The id comes back in every response. Echo only what JSON-RPC allows.
    const id = typeof request.id === "number" || (typeof request.id === "string" && request.id.length <= 128)
      ? request.id
      : null;
    if (typeof request.method !== "string") {
      res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32600, message: "method must be a string" } });
      return;
    }
    if (request.method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "paperclip-runtime-tools", version: "1" },
        },
      });
      return;
    }
    // A notification carries no id and gets no JSON-RPC response. Answering one
    // with 404 would tell a Streamable HTTP client its session is gone.
    if (request.method.startsWith("notifications/")) {
      res.status(202).end();
      return;
    }
    if (request.method === "ping") {
      res.json({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (request.method === "tools/list") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: RUNTIME_CONNECTION_TOOL_DEFINITIONS,
        },
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params && typeof request.params === "object"
        ? request.params as { name?: unknown; arguments?: unknown }
        : {};
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "connections_search" || name === "connection_request") {
        try {
          const result = name === "connections_search"
            ? await searchConnections(claims, params.arguments)
            : await requestConnection(claims, params.arguments);
          res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
        } catch (err) {
          const failure = toolCallFailure(err);
          if (!failure) throw err;
          // The service reloads the run and its task. If the task was
          // reassigned or closed after the check above, its 404 or 409 is lost
          // authority, not an outcome to hand the agent: validating again
          // throws it as the HTTP error it is.
          await service.validate(claims);
          res.json({ jsonrpc: "2.0", id, result: { ...resultContent(failure), isError: true } });
        }
        return;
      }
      if (name === "typesafe_judge") {
        const parsed = typeSafeJudgeInputSchema.safeParse(params.arguments ?? {});
        // With the tool switched off there is nothing to correct: say so
        // first, rather than walk the agent through fixing a call that cannot
        // run. The service returns `disabled` before it reads the input.
        if (!parsed.success && typeSafeToolEnabled()) {
          // Malformed arguments are the caller's to correct, so they come back
          // as a tool result it can read. An HTTP 400 here reads as a broken
          // transport to an MCP client and hides the reason from the agent.
          const rejected = {
            ok: false,
            error: {
              code: "invalid_input",
              retryable: false,
              issues: typeSafeInputIssues(parsed.error),
              hint: TYPESAFE_JUDGE_INPUT_HINT,
            },
          };
          res.json({ jsonrpc: "2.0", id, result: { ...resultContent(rejected), isError: true } });
          return;
        }
        const result = await typeSafe.judge(claims, parsed.success ? parsed.data : params.arguments ?? {});
        res.json({ jsonrpc: "2.0", id, result: { ...resultContent(result), ...(result.ok === false ? { isError: true } : {}) } });
        return;
      }
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name || "missing"}` },
      });
      return;
    }
    res.status(404).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${request.method.slice(0, 80)}` },
    });
  });

  router.post("/runtime-tools/connections/search", async (req, res) => {
    const input = connectionsSearchInputSchema.parse(req.body ?? {});
    res.json(await service.search(runtimeClaims(req), input.query, { retryProviderChoice: input.retryProviderChoice }));
  });
  router.post("/runtime-tools/connections/request", async (req, res) => {
    const input = connectionRequestInputSchema.parse(req.body ?? {});
    res.json(await service.request(runtimeClaims(req), input.service, { selectionInteractionId: input.selectionInteractionId, targetService: input.targetService }));
  });
  router.post("/runtime-tools/typesafe/judge", async (req, res) => {
    res.json(await typeSafe.judge(runtimeClaims(req), typeSafeJudgeInputSchema.parse(req.body ?? {})));
  });
  return router;
}

type Heartbeat = ReturnType<typeof heartbeatService>;

export { wakeConnectionIntentAfterResolution } from "../services/connection-intent-delivery.js";
export function connectionIntentBoardRoutes(db: Db, heartbeat: Heartbeat) {
  const router = Router();
  const service = connectionIntentService(db);
  const access = accessService(db);

  function bypassCurrentMembershipCheck(req: Request) {
    return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
  }

  async function canManageCompanyConnections(req: Request, companyId: string) {
    if (bypassCurrentMembershipCheck(req)) return true;
    return Boolean(req.actor.userId && await access.hasPermission(
      companyId,
      "user",
      req.actor.userId,
      "tools:manage_connections",
    ));
  }

  async function addressedIntent(req: Request) {
    assertBoard(req);
    const loaded = await service.loadIntent(req.params.interactionId as string);
    assertCompanyAccess(req, loaded.issue.companyId);
    const userId = req.actor.userId ?? "local-board";
    if (loaded.interaction.addresseeUserId !== userId) {
      throw forbidden("Only the addressed user can act on this connection request");
    }
    return { loaded, userId };
  }

  async function wakeAfterResolution(input: {
    loaded: Awaited<ReturnType<typeof service.loadIntent>>;
    status: string;
    actorId: string;
  }) {
    await connectionIntentDeliveryService(db, heartbeat).tryDeliver(input.loaded.interaction.id);
  }

  router.get("/connection-intents/:interactionId/setup-options", async (req, res) => {
    const { loaded } = await addressedIntent(req);
    res.json(await service.setupOptions(req.params.interactionId as string, {
      canManageOrganizationGrant: await canManageCompanyConnections(req, loaded.issue.companyId),
    }));
  });

  router.post("/connection-intents/:interactionId/phase", async (req, res) => {
    const { userId } = await addressedIntent(req);
    const phase = req.body?.phase;
    if (phase !== "requested" && phase !== "authorizing" && phase !== "needs_retry") {
      res.status(422).json({ error: "phase must be requested, authorizing, or needs_retry" });
      return;
    }
    res.json(await service.updatePhase(req.params.interactionId as string, phase, userId, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    }));
  });

  router.post("/connection-intents/:interactionId/complete", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = completeConnectionIntentSchema.parse(req.body);
    const interaction = await service.complete(loaded.interaction.id, input.connectionId, userId, {
      canManageOrganizationGrant: await canManageCompanyConnections(req, loaded.issue.companyId),
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_connected",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: {
        interactionId: interaction.id,
        connectionId: interaction.result?.connectionId ?? null,
        requestingAgentId: interaction.payload.requestingAgentId,
      },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  router.post("/connection-intents/:interactionId/decline", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = declineConnectionIntentSchema.parse(req.body ?? {});
    const interaction = await service.decline(loaded.interaction.id, userId, input.reason, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_declined",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: { interactionId: interaction.id, reason: input.reason ?? null },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  return router;
}
