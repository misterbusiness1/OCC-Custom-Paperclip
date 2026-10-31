import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    cloudUpstreamService: () => mockCloudUpstreamService,
    instanceSettingsService: () => mockInstanceSettingsService,
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

  it("authorizes connect/finish against the pending connection's company", async () => {
    mockCloudUpstreamService.finishConnect.mockImplementation(
      async (input: { authorizeCompany?: (companyId: string) => void }) => {
        input.authorizeCompany?.("company-b");
        return { ok: true };
      },
    );

    const res = await request(await createApp())
      .post("/api/cloud-upstreams/connect/finish")
      .send({ pendingConnectionId: "conn-1", code: "code", state: "state" });

    expect(res.status).toBe(403);
  });
});

describe("cloud upstream discovery URL validation", () => {
  it("accepts HTTPS discovery URLs and localhost development URLs", async () => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    const { assertDiscoveryUrl } = await import("../services/cloud-upstreams.js");

    expect(assertDiscoveryUrl("https://auth.example.test/token", "https://example.test", "tokenUrl")).toBe(
      "https://auth.example.test/token",
    );
    expect(assertDiscoveryUrl("http://localhost:4000/token", "http://localhost:4000", "tokenUrl")).toBe(
      "http://localhost:4000/token",
    );
  });

  it("rejects non-HTTPS discovery URLs from a non-local remote", async () => {
    vi.resetModules();
    const { assertDiscoveryUrl } = await import("../services/cloud-upstreams.js");

    expect(() => assertDiscoveryUrl("http://169.254.169.254/latest", "https://example.test", "tokenUrl")).toThrow(
      /must use HTTPS/,
    );
    expect(() => assertDiscoveryUrl("http://localhost:5432/", "https://example.test", "tokenUrl")).toThrow(
      /must use HTTPS/,
    );
    expect(() => assertDiscoveryUrl("javascript:alert(1)", "https://example.test", "consentUrl")).toThrow(
      /must use HTTPS/,
    );
    expect(() => assertDiscoveryUrl("not a url", "https://example.test", "consentUrl")).toThrow(/not a valid URL/);
  });
});
