import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Imported statically: a cold dynamic import of the service inside a test body
// took longer than the default 5s test timeout on a loaded machine.
import { assertDiscoveryUrl, assertTargetOrigin } from "../services/cloud-upstreams.js";

const mockCloudUpstreamService = vi.hoisted(() => ({
  list: vi.fn(),
  startConnect: vi.fn(),
  finishConnect: vi.fn(),
  preview: vi.fn(),
  createRun: vi.fn(),
  readRun: vi.fn(),
  cancelRun: vi.fn(),
  activateRunEntities: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    cloudUpstreamService: () => mockCloudUpstreamService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
}

const memberOfCompanyA = {
  type: "board",
  userId: "user-a",
  companyIds: ["company-a"],
  memberships: [{ companyId: "company-a", status: "active", membershipRole: "owner" }],
  source: "session",
  isInstanceAdmin: false,
};

async function createApp(actor: Record<string, unknown> = memberOfCompanyA) {
  const [{ errorHandler }, { cloudUpstreamRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/cloud-upstreams.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", cloudUpstreamRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("cloud upstream routes company scoping", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/cloud-upstreams.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableCloudSync: true });
    for (const fn of Object.values(mockCloudUpstreamService)) {
      fn.mockResolvedValue({ ok: true });
    }
    mockLogActivity.mockResolvedValue(undefined);
  });

  const foreignCompanyRequests: Array<[string, (app: express.Express) => request.Test]> = [
    ["list", (app) => request(app).get("/api/cloud-upstreams?companyId=company-b")],
    [
      "connect/start",
      (app) =>
        request(app)
          .post("/api/cloud-upstreams/connect/start")
          .send({ companyId: "company-b", remoteUrl: "https://example.test", redirectUri: "https://ui.test/cb" }),
    ],
    [
      "push-runs/preview",
      (app) => request(app).post("/api/cloud-upstreams/conn-1/push-runs/preview").send({ companyId: "company-b" }),
    ],
    ["push-runs", (app) => request(app).post("/api/cloud-upstreams/conn-1/push-runs").send({ companyId: "company-b" })],
    ["read run", (app) => request(app).get("/api/cloud-upstreams/conn-1/push-runs/run-1?companyId=company-b")],
    [
      "cancel run",
      (app) => request(app).post("/api/cloud-upstreams/conn-1/push-runs/run-1/cancel").send({ companyId: "company-b" }),
    ],
    [
      "activation",
      (app) =>
        request(app)
          .post("/api/cloud-upstreams/conn-1/push-runs/run-1/activation")
          .send({ companyId: "company-b", entityType: "agents" }),
    ],
  ];

  it.each(foreignCompanyRequests)("rejects %s for a company the caller is not a member of", async (_name, send) => {
    const res = await send(await createApp());

    expect(res.status).toBe(403);
    for (const fn of Object.values(mockCloudUpstreamService)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("allows a member to list their own company's connections", async () => {
    const res = await request(await createApp()).get("/api/cloud-upstreams?companyId=company-a");

    expect(res.status).toBe(200);
    expect(mockCloudUpstreamService.list).toHaveBeenCalledWith("company-a");
  });

  it("rejects push runs from a viewer of the company", async () => {
    const viewer = {
      ...memberOfCompanyA,
      memberships: [{ companyId: "company-a", status: "active", membershipRole: "viewer" }],
    };
    const res = await request(await createApp(viewer))
      .post("/api/cloud-upstreams/conn-1/push-runs")
      .send({ companyId: "company-a" });

    expect(res.status).toBe(403);
    expect(mockCloudUpstreamService.createRun).not.toHaveBeenCalled();
  });

  it("answers connect/finish for another company's pending connection with the same 404 as a missing id", async () => {
    mockCloudUpstreamService.finishConnect.mockImplementation(
      async (input: { authorizeCompany?: (companyId: string) => void }) => {
        input.authorizeCompany?.("company-b");
        return { ok: true };
      },
    );

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/connect/finish")
      .send({ pendingConnectionId: "conn-1", code: "code", state: "state" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Cloud upstream connection was not found" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("still rejects connect/finish from a viewer of the pending connection's company", async () => {
    mockCloudUpstreamService.finishConnect.mockImplementation(
      async (input: { authorizeCompany?: (companyId: string) => void }) => {
        input.authorizeCompany?.("company-a");
        return { ok: true };
      },
    );
    const viewer = {
      ...memberOfCompanyA,
      memberships: [{ companyId: "company-a", status: "active", membershipRole: "viewer" }],
    };

    const res = await request(await createApp(viewer))
      .post("/api/cloud-upstreams/connect/finish")
      .send({ pendingConnectionId: "conn-1", code: "code", state: "state" });

    expect(res.status).toBe(403);
  });
});

describe("cloud upstream routes activity logging", () => {
  const connection = {
    id: "conn-1",
    companyId: "company-a",
    remoteUrl: "https://cloud.example.test/PC1/dashboard",
    target: { origin: "https://cloud.example.test", stackId: "stack-1" },
  };
  const run = (status: string) => ({
    id: "run-1",
    connectionId: "conn-1",
    companyId: "company-a",
    status,
    targetUrl: "https://cloud.example.test",
    retryOfRunId: null,
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/cloud-upstreams.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableCloudSync: true });
    mockLogActivity.mockResolvedValue(undefined);
  });

  function expectLogged(action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-a",
      actorType: "user",
      actorId: "user-a",
      agentId: null,
      action,
      entityType,
      entityId,
      details,
    });
  }

  it("logs connect start", async () => {
    mockCloudUpstreamService.startConnect.mockResolvedValue({
      pendingConnectionId: "conn-1",
      authorizationUrl: "https://cloud.example.test/oauth/authorize",
      connection,
    });

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/connect/start")
      .send({ companyId: "company-a", remoteUrl: connection.remoteUrl, redirectUri: "https://ui.test/cb" });

    expect(res.status).toBe(200);
    expectLogged("cloud_upstream.connect_started", "cloud_upstream_connection", "conn-1", {
      remoteUrl: connection.remoteUrl,
      targetOrigin: "https://cloud.example.test",
      targetStackId: "stack-1",
    });
  });

  it("logs connect finish against the pending connection's company", async () => {
    mockCloudUpstreamService.finishConnect.mockImplementation(
      async (input: { authorizeCompany?: (companyId: string) => void }) => {
        input.authorizeCompany?.("company-a");
        return connection;
      },
    );

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/connect/finish")
      .send({ pendingConnectionId: "conn-1", code: "code", state: "state" });

    expect(res.status).toBe(200);
    expectLogged("cloud_upstream.connected", "cloud_upstream_connection", "conn-1", {
      remoteUrl: connection.remoteUrl,
      targetOrigin: "https://cloud.example.test",
      targetStackId: "stack-1",
    });
  });

  it("logs push run creation", async () => {
    mockCloudUpstreamService.createRun.mockResolvedValue(run("succeeded"));

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/conn-1/push-runs")
      .send({ companyId: "company-a" });

    expect(res.status).toBe(200);
    expectLogged("cloud_upstream.push_run_created", "cloud_upstream_run", "run-1", {
      connectionId: "conn-1",
      status: "succeeded",
      targetUrl: "https://cloud.example.test",
      retryOfRunId: null,
    });
  });

  it("logs a push run cancellation", async () => {
    mockCloudUpstreamService.readRun.mockResolvedValue(run("running"));
    mockCloudUpstreamService.cancelRun.mockResolvedValue(run("cancelled"));

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/conn-1/push-runs/run-1/cancel")
      .send({ companyId: "company-a" });

    expect(res.status).toBe(200);
    expectLogged("cloud_upstream.push_run_cancelled", "cloud_upstream_run", "run-1", { connectionId: "conn-1" });
  });

  it("does not log a cancel request for a run that had already finished", async () => {
    mockCloudUpstreamService.readRun.mockResolvedValue(run("cancelled"));
    mockCloudUpstreamService.cancelRun.mockResolvedValue(run("cancelled"));

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/conn-1/push-runs/run-1/cancel")
      .send({ companyId: "company-a" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs entity activation", async () => {
    mockCloudUpstreamService.activateRunEntities.mockResolvedValue(run("succeeded"));

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/conn-1/push-runs/run-1/activation")
      .send({ companyId: "company-a", entityType: "agents" });

    expect(res.status).toBe(200);
    expectLogged("cloud_upstream.push_run_entities_activated", "cloud_upstream_run", "run-1", {
      connectionId: "conn-1",
      activatedEntityType: "agents",
    });
  });
});

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("cloud upstream discovery URL validation", () => {
  it("accepts public HTTPS discovery URLs and localhost development URLs", async () => {
    await expect(
      assertDiscoveryUrl("https://auth.example.test/token", "https://example.test", "tokenUrl", { lookup: publicLookup }),
    ).resolves.toBe("https://auth.example.test/token");
    await expect(assertDiscoveryUrl("http://localhost:4000/token", "http://localhost:4000", "tokenUrl")).resolves.toBe(
      "http://localhost:4000/token",
    );
    await expect(assertDiscoveryUrl("http://127.0.0.1:4000/token", "http://127.0.0.1:4000", "tokenUrl")).resolves.toBe(
      "http://127.0.0.1:4000/token",
    );
    await expect(assertDiscoveryUrl("http://[::1]:4000/token", "http://[::1]:4000", "tokenUrl")).resolves.toBe(
      "http://[::1]:4000/token",
    );
  });

  it("rejects non-HTTPS discovery URLs from a non-local remote", async () => {
    const guard = { lookup: publicLookup };
    await expect(assertDiscoveryUrl("http://169.254.169.254/latest", "https://example.test", "tokenUrl", guard)).rejects.toThrow(
      /must use HTTPS/,
    );
    await expect(assertDiscoveryUrl("http://localhost:5432/", "https://example.test", "tokenUrl", guard)).rejects.toThrow(
      /must use HTTPS/,
    );
    await expect(assertDiscoveryUrl("http://public.example.test/token", "https://example.test", "tokenUrl", guard)).rejects.toThrow(
      /must use HTTPS/,
    );
    await expect(assertDiscoveryUrl("javascript:alert(1)", "https://example.test", "consentUrl", guard)).rejects.toThrow(
      /must use HTTPS/,
    );
    await expect(assertDiscoveryUrl("not a url", "https://example.test", "consentUrl", guard)).rejects.toThrow(
      /not a valid URL/,
    );
  });

  it.each([
    "https://localhost:5432/",
    "https://127.0.0.1/token",
    "https://[::1]/token",
    "https://10.0.0.5/token",
    "https://192.168.1.10/token",
    "https://169.254.169.254/latest",
    "https://[::ffff:a9fe:a9fe]/token",
  ])("rejects HTTPS discovery URL %s on a private address from a public remote", async (url) => {
    await expect(assertDiscoveryUrl(url, "https://example.test", "tokenUrl", { lookup: publicLookup })).rejects.toMatchObject({
      status: 400,
      message: "Cloud upstream discovery tokenUrl cannot target private or reserved network addresses",
    });
  });

  it("rejects a discovery hostname that resolves to a private address", async () => {
    await expect(
      assertDiscoveryUrl("https://token.example.test/token", "https://example.test", "tokenUrl", {
        lookup: async () => [{ address: "10.0.0.12", family: 4 }],
      }),
    ).rejects.toMatchObject({ status: 400, details: { code: "remote_http_private_endpoint" } });
  });
});

describe("cloud upstream stack origin binding", () => {
  it("accepts the remote URL's own origin and normalizes it", async () => {
    await expect(
      assertTargetOrigin("https://cloud.example.test/", "https://cloud.example.test/PC1/dashboard", { lookup: publicLookup }),
    ).resolves.toBe("https://cloud.example.test");
    await expect(assertTargetOrigin("http://localhost:3200", "http://localhost:3200/PC1")).resolves.toBe(
      "http://localhost:3200",
    );
  });

  it.each([
    ["http://10.0.0.5", "https://cloud.example.test"],
    ["https://10.0.0.5", "https://cloud.example.test"],
    ["https://attacker.example.test", "https://cloud.example.test"],
    ["http://cloud.example.test", "https://cloud.example.test"],
    ["https://cloud.example.test:8443", "https://cloud.example.test"],
    ["http://localhost:5432", "http://localhost:3200"],
  ])("rejects stack origin %s for remote %s", async (origin, remoteUrl) => {
    await expect(assertTargetOrigin(origin, remoteUrl, { lookup: publicLookup })).rejects.toThrow(
      "Cloud upstream stack origin must match the remote URL origin",
    );
  });

  it("rejects a stack origin on a private address even when it matches the remote", async () => {
    await expect(assertTargetOrigin("https://10.0.0.5", "https://10.0.0.5/PC1")).rejects.toThrow(
      /cannot target private or reserved network addresses/,
    );
  });
});
