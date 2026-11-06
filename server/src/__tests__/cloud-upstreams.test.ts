import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, cloudUpstreamConnections, cloudUpstreamRuns, companySkills, createDb } from "@paperclipai/db";

import { HttpError } from "../errors.js";
import {
  cloudUpstreamRemoteFailureReport,
  cloudUpstreamService,
  reconcileCloudUpstreamRunsOnStartup,
  sealCloudUpstreamCredential,
  unsealCloudUpstreamCredential,
} from "../services/cloud-upstreams.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cloud upstream tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("cloud upstream remote failures", () => {
  it("preserves the cloud response body and message on run reports", () => {
    const body = {
      error: "bad_request",
      message: "entities[42].body must be an object",
      errors: [{ path: "entities[42].body" }],
    };

    expect(cloudUpstreamRemoteFailureReport(new HttpError(400, "bad_request", body))).toEqual({
      error: "bad_request",
      errorMessage: "entities[42].body must be an object",
      details: body,
    });
  });

  it("falls back to the thrown error message for non-remote failures", () => {
    expect(cloudUpstreamRemoteFailureReport(new Error("network failed"))).toEqual({
      error: "network failed",
    });
  });
});

describe("cloud upstream credential storage", () => {
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  afterEach(() => {
    if (previousMasterKey === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
  });

  it("stores new credentials as encrypted envelopes and preserves legacy plaintext reads", async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const sealed = await sealCloudUpstreamCredential("cloud-access-token");

    expect(sealed).toMatch(/^paperclip-cloud-credential:/);
    expect(sealed).not.toContain("cloud-access-token");
    await expect(unsealCloudUpstreamCredential(sealed)).resolves.toBe("cloud-access-token");
    await expect(unsealCloudUpstreamCredential("legacy-plaintext-token")).resolves.toBe("legacy-plaintext-token");
  });
});

describeEmbeddedPostgres("cloud upstream persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cloud-upstreams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    await db.delete(cloudUpstreamRuns);
    await db.delete(cloudUpstreamConnections);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousMasterKey === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
    await tempDb?.cleanup();
  });

  it("encrypts stored upstream credentials while keeping connection flows usable", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const tokenUrl = "https://cloud.example.test/oauth/token";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://cloud.example.test/.well-known/paperclip-upstream")) {
        return jsonResponse({
          product: "Paperclip Cloud",
          stack: {
            id: "stack-1",
            companyId: "cloud-company-1",
            origin: "https://cloud.example.test",
            primaryHost: "cloud.example.test",
          },
          transfer: {
            supportedSchemaMajor: 1,
            maxChunkBytes: 8192,
          },
          auth: {
            scopes: ["upstream_import:write"],
            pkce: {
              authorizeUrl: "https://cloud.example.test/oauth/authorize",
              tokenUrl,
            },
          },
        });
      }
      if (url === tokenUrl && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        expect(payload.codeVerifier).toEqual(expect.any(String));
        expect(payload.codeVerifier).not.toContain("paperclip-cloud-credential:");
        return jsonResponse({
          accessToken: "cloud-access-token",
          token: {
            id: "token-1",
            expiresAt: "2026-05-22T13:00:00.000Z",
            globalUserId: "user-1",
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = cloudUpstreamService(db, { instanceId: "test", endpointLookup: publicLookup });
    const started = await service.startConnect({
      companyId,
      remoteUrl: "https://cloud.example.test",
      redirectUri: "http://localhost:3100/callback",
    });
    await service.finishConnect({
      pendingConnectionId: started.pendingConnectionId,
      code: "auth-code",
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
    });

    const [row] = await db.select().from(cloudUpstreamConnections);
    expect(row.privateKeyPem).toMatch(/^paperclip-cloud-credential:/);
    expect(row.privateKeyPem).not.toContain("BEGIN PRIVATE KEY");
    expect(row.accessToken).toMatch(/^paperclip-cloud-credential:/);
    expect(row.accessToken).not.toContain("cloud-access-token");
  });

  it("marks orphaned running runs failed during startup reconciliation", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    const runningRunId = randomUUID();
    const succeededRunId = randomUUID();
    const reconciledAt = new Date("2026-05-22T13:00:00.000Z");
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values({
      id: connectionId,
      companyId,
      remoteUrl: "https://cloud.example.test",
      sourceInstanceId: "source-1",
      sourceInstanceFingerprint: "sha256:test",
      sourcePublicKey: "public-key",
      privateKeyPem: "legacy-private-key",
      tokenStatus: "connected",
      scopes: ["upstream_import:write"],
      authorizedGlobalUserId: "user-1",
      accessToken: "legacy-token",
      tokenId: "token-1",
      targetStackId: "stack-1",
      targetCompanyId: "cloud-company-1",
      targetOrigin: "https://cloud.example.test",
      targetPrimaryHost: "cloud.example.test",
      targetProduct: "Paperclip Cloud",
      targetSchemaMajor: 1,
      targetMaxChunkBytes: 8192,
    });
    await db.insert(cloudUpstreamRuns).values([
      cloudRunRow({ id: runningRunId, connectionId, companyId, status: "running" }),
      cloudRunRow({ id: succeededRunId, connectionId, companyId, status: "succeeded", completedAt: reconciledAt }),
    ]);

    await expect(reconcileCloudUpstreamRunsOnStartup(db, reconciledAt)).resolves.toEqual({ reconciled: 1 });

    const rows = await db.select().from(cloudUpstreamRuns);
    const running = rows.find((row) => row.id === runningRunId);
    const succeeded = rows.find((row) => row.id === succeededRunId);
    expect(running?.status).toBe("failed");
    expect(running?.completedAt?.toISOString()).toBe(reconciledAt.toISOString());
    expect(running?.events.at(-1)?.message).toContain("server startup");
    expect(running?.report).toMatchObject({
      error: "orphaned_running_run",
      reconciledAt: reconciledAt.toISOString(),
    });
    expect(succeeded?.status).toBe("succeeded");
  });

  it("rejects a new run when the connection already has a running run", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    const runningRunId = randomUUID();
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values(cloudConnectionRow({ id: connectionId, companyId }));
    await db.insert(cloudUpstreamRuns).values(
      cloudRunRow({ id: runningRunId, connectionId, companyId, status: "running" }),
    );

    await expect(cloudUpstreamService(db).createRun({ connectionId, companyId })).rejects.toMatchObject({
      status: 409,
      details: { runId: runningRunId },
    });
  });

  it("preserves a cancelled run when an in-flight createRun tries to finish", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values(cloudConnectionRow({ id: connectionId, companyId }));

    const service = cloudUpstreamService(db, { endpointLookup: publicLookup });
    const remoteCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      remoteCalls.push(path);
      if (path.endsWith("/upstream-imports/runs")) {
        return jsonResponse({ run: { id: "remote-run-1" } });
      }
      if (path.endsWith("/chunks")) {
        const run = await db.select().from(cloudUpstreamRuns).then((rows) => rows[0]);
        expect(run?.status).toBe("running");
        await service.cancelRun(connectionId, run.id, companyId);
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/cancel")) {
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/apply")) {
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/events")) {
        return jsonResponse({ events: [] });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    const result = await service.createRun({ connectionId, companyId });

    expect(result.status).toBe("cancelled");
    expect(remoteCalls.some((path) => path.endsWith("/apply"))).toBe(false);
    const rows = await db.select().from(cloudUpstreamRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("connects and pushes only to the remote's own origin without following redirects", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const calls: Array<{ url: string; method: string; redirect: RequestRedirect | undefined }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
      const path = new URL(url).pathname;
      if (path === "/.well-known/paperclip-upstream") return jsonResponse(discoveryDocument());
      if (path === "/oauth/token") {
        return jsonResponse({ accessToken: "cloud-access-token", token: { id: "token-1", globalUserId: "user-1" } });
      }
      if (path.endsWith("/upstream-imports/runs")) return jsonResponse({ run: { id: "remote-run-1" } });
      if (path.endsWith("/chunks") || path.endsWith("/apply")) return jsonResponse({ ok: true });
      if (path.endsWith("/events")) return jsonResponse({ events: [] });
      return jsonResponse({ error: "not_found" }, 404);
    });

    const service = cloudUpstreamService(db, { instanceId: "test", endpointLookup: publicLookup });
    const started = await service.startConnect({
      companyId,
      remoteUrl: "https://cloud.example.test/PC1/dashboard",
      redirectUri: "http://localhost:3100/callback",
    });
    expect(started.connection.target.origin).toBe("https://cloud.example.test");
    const connection = await service.finishConnect({
      pendingConnectionId: started.pendingConnectionId,
      code: "auth-code",
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
    });
    expect(connection.tokenStatus).toBe("connected");

    const run = await service.createRun({ connectionId: connection.id, companyId });

    expect(run.status).toBe("succeeded");
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /.well-known/paperclip-upstream",
      "POST /oauth/token",
      "POST /api/companies/cloud-company-1/upstream-imports/runs",
      ...calls.filter((call) => call.url.endsWith("/chunks")).map(() => "POST /api/upstream-import-runs/remote-run-1/chunks"),
      "POST /api/upstream-import-runs/remote-run-1/apply",
      "GET /api/upstream-import-runs/remote-run-1/events",
    ]);
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe("https://cloud.example.test");
      expect(call.redirect).toBe("error");
    }
  }, 20_000);

  it.each([
    ["a private plain-HTTP stack origin", { origin: "http://10.0.0.5" }, /stack origin must match the remote URL origin/],
    ["a stack origin on another host", { origin: "https://attacker.example.test" }, /stack origin must match the remote URL origin/],
    ["a token URL on a private address", { tokenUrl: "https://10.0.0.5/oauth/token" }, /tokenUrl cannot target private/],
    ["a token URL on localhost", { tokenUrl: "https://localhost:5432/" }, /tokenUrl cannot target private/],
    ["a consent URL on a link-local address", { authorizeUrl: "https://[::ffff:a9fe:a9fe]/authorize" }, /consentUrl cannot target private/],
  ])("refuses to start a connection whose discovery document has %s", async (_name, overrides, message) => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (new URL(String(input)).pathname === "/.well-known/paperclip-upstream") {
        return jsonResponse(discoveryDocument(overrides));
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    await expect(cloudUpstreamService(db, { endpointLookup: publicLookup }).startConnect({
      companyId,
      remoteUrl: "https://cloud.example.test",
      redirectUri: "http://localhost:3100/callback",
    })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(db.select().from(cloudUpstreamConnections)).resolves.toHaveLength(0);
  });

  it("refuses a remote URL that resolves to a private address before fetching discovery", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));

    await expect(cloudUpstreamService(db, {
      endpointLookup: async () => [{ address: "10.0.0.12", family: 4 }],
    }).startConnect({
      companyId,
      remoteUrl: "https://cloud.example.test",
      redirectUri: "http://localhost:3100/callback",
    })).rejects.toMatchObject({ status: 400, details: { code: "remote_http_private_endpoint" } });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables the localhost development exception in authenticated + public deployments", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const server = await startLocalServer((req, res, origin) => {
      if (req.url?.startsWith("/.well-known/paperclip-upstream")) {
        writeJson(res, discoveryDocument({
          origin,
          tokenUrl: `${origin}/oauth/token`,
          authorizeUrl: `${origin}/oauth/authorize`,
        }));
        return;
      }
      writeJson(res, { error: "not_found" }, 404);
    });
    try {
      const publicAuthenticated = cloudUpstreamService(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      });
      await expect(publicAuthenticated.startConnect({
        companyId,
        remoteUrl: `${server.origin}/PC1`,
        redirectUri: "http://localhost:3100/callback",
      })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/remote URL must use HTTPS/) });
      await expect(publicAuthenticated.startConnect({
        companyId,
        remoteUrl: server.origin.replace("http://", "https://"),
        redirectUri: "http://localhost:3100/callback",
      })).rejects.toMatchObject({ status: 400, details: { code: "remote_http_private_endpoint" } });
      expect(server.requests).toEqual([]);
      await expect(db.select().from(cloudUpstreamConnections)).resolves.toHaveLength(0);

      // The exception still applies to authenticated + private deployments.
      const started = await cloudUpstreamService(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      }).startConnect({
        companyId,
        remoteUrl: server.origin,
        redirectUri: "http://localhost:3100/callback",
      });
      expect(started.connection.target.origin).toBe(server.origin);
      expect(server.requests.map((request) => request.path.split("?")[0])).toEqual(["/.well-known/paperclip-upstream"]);
    } finally {
      await server.close();
    }
  });

  it("does not follow a redirect from the discovery endpoint", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const server = await startLocalServer((req, res, origin) => {
      if (req.url?.startsWith("/.well-known/paperclip-upstream")) {
        res.writeHead(302, { Location: `${origin}/redirected-discovery` }).end();
        return;
      }
      if (req.url === "/redirected-discovery") {
        writeJson(res, discoveryDocument({
          origin,
          tokenUrl: `${origin}/oauth/token`,
          authorizeUrl: `${origin}/oauth/authorize`,
        }));
        return;
      }
      writeJson(res, { error: "not_found" }, 404);
    });
    try {
      await expect(cloudUpstreamService(db).startConnect({
        companyId,
        remoteUrl: server.origin,
        redirectUri: "http://localhost:3100/callback",
      })).rejects.toThrow();

      expect(server.requests.map((request) => request.path)).not.toContain("/redirected-discovery");
      await expect(db.select().from(cloudUpstreamConnections)).resolves.toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("does not re-send the company export when the stack answers a push with a redirect", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    await seedCompany(companyId);
    const server = await startLocalServer((req, res) => {
      if (req.url?.endsWith("/upstream-imports/runs")) {
        res.writeHead(307, { Location: "/collect-export" }).end();
        return;
      }
      writeJson(res, { run: { id: "remote-run-1" }, events: [] });
    });
    try {
      await db.insert(cloudUpstreamConnections).values({
        ...cloudConnectionRow({ id: connectionId, companyId }),
        remoteUrl: server.origin,
        targetOrigin: server.origin,
      });

      const run = await cloudUpstreamService(db).createRun({ connectionId, companyId });

      expect(run.status).toBe("failed");
      expect(server.requests.map((request) => request.path)).toEqual([
        "/api/companies/cloud-company-1/upstream-imports/runs",
      ]);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("re-validates a stored pending token URL before the token exchange", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values({
      ...cloudConnectionRow({ id: connectionId, companyId }),
      tokenStatus: "pending",
      accessToken: null,
      tokenId: null,
      pendingState: "state-1",
      pendingCodeVerifier: "verifier-1",
      pendingRedirectUri: "http://localhost:3100/callback",
      pendingTokenUrl: "http://169.254.169.254/latest/meta-data",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));

    await expect(cloudUpstreamService(db, { endpointLookup: publicLookup }).finishConnect({
      pendingConnectionId: connectionId,
      code: "auth-code",
      state: "state-1",
    })).rejects.toMatchObject({ status: 400, message: "Cloud upstream discovery tokenUrl must use HTTPS" });

    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(cloudUpstreamConnections);
    expect(row?.tokenStatus).toBe("pending");
  });

  it("re-validates a stored stack origin before sending the token or the company export", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values({
      ...cloudConnectionRow({ id: connectionId, companyId }),
      targetOrigin: "http://10.0.0.5",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    const service = cloudUpstreamService(db, { endpointLookup: publicLookup });

    await expect(service.preview(connectionId, companyId)).rejects.toMatchObject({
      status: 400,
      message: "Cloud upstream stack origin must match the remote URL origin",
    });
    const run = await service.createRun({ connectionId, companyId });

    expect(run.status).toBe("failed");
    expect(run.report).toMatchObject({ error: "Cloud upstream stack origin must match the remote URL origin" });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 20_000);

  async function seedCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function discoveryDocument(overrides: { origin?: string; tokenUrl?: string; authorizeUrl?: string } = {}) {
  return {
    product: "Paperclip Cloud",
    stack: {
      id: "stack-1",
      companyId: "cloud-company-1",
      origin: overrides.origin ?? "https://cloud.example.test",
      primaryHost: "cloud.example.test",
    },
    transfer: {
      supportedSchemaMajor: 1,
      maxChunkBytes: 8192,
    },
    auth: {
      scopes: ["upstream_import:write"],
      pkce: {
        authorizeUrl: overrides.authorizeUrl ?? "https://cloud.example.test/oauth/authorize",
        tokenUrl: overrides.tokenUrl ?? "https://cloud.example.test/oauth/token",
      },
    },
  };
}

function writeJson(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function startLocalServer(handler: (req: IncomingMessage, res: ServerResponse, origin: string) => void) {
  const requests: Array<{ method: string; path: string }> = [];
  let origin = "";
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", path: req.url ?? "/" });
    req.resume();
    req.on("end", () => handler(req, res, origin));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function cloudConnectionRow(input: { id: string; companyId: string }) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    id: input.id,
    companyId: input.companyId,
    remoteUrl: "https://cloud.example.test",
    sourceInstanceId: "source-1",
    sourceInstanceFingerprint: "sha256:test",
    sourcePublicKey: "public-key",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    tokenStatus: "connected",
    scopes: ["upstream_import:write"],
    authorizedGlobalUserId: "user-1",
    accessToken: "legacy-token",
    tokenId: "token-1",
    targetStackId: "stack-1",
    targetCompanyId: "cloud-company-1",
    targetOrigin: "https://cloud.example.test",
    targetPrimaryHost: "cloud.example.test",
    targetProduct: "Paperclip Cloud",
    targetSchemaMajor: 1,
    targetMaxChunkBytes: 8192,
  };
}

function cloudRunRow(input: {
  id: string;
  connectionId: string;
  companyId: string;
  status: string;
  completedAt?: Date;
}) {
  return {
    id: input.id,
    connectionId: input.connectionId,
    companyId: input.companyId,
    status: input.status,
    activeStep: "push",
    progressPercent: input.status === "running" ? 45 : 100,
    dryRun: false,
    summary: [],
    warnings: [],
    conflicts: [],
    events: [],
    report: {},
    idempotencyKey: `key-${input.id}`,
    manifestHash: `sha256:${input.id.replace(/-/g, "")}`,
    targetUrl: "https://cloud.example.test",
    completedAt: input.completedAt,
  };
}
