import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { ZOD_BASELINE_UPDATE_ENV, readZodVersion } from "@paperclipai/shared/testing/zod-baseline-golden";

/**
 * Validation-error response goldens captured on zod 3.25.76 before the zod 4
 * migration.
 *
 * Every 4xx body that carries zod issues is recorded in full. After the
 * migration the contract is:
 * - same status and same envelope (every non-issue field, e.g. `error`,
 *   `code`, flatten() output, mapped messages, is identical);
 * - every zod issue keeps `code`, `path`, `message`, and `expected`/`received`
 *   where the zod 3 issue had them (first-party clients, the CLI and docs rely
 *   on these). Other zod-version-specific issue fields are not part of the
 *   contract.
 *
 * Covered paths: the global `validate()` middleware + `errorHandler` (through
 * real routers and through a harness built from the real route schemas), and
 * each place that serializes zod issues directly: issues.ts `details:
 * ...error.issues`, company-skill-policy (422 `issues`), decision-training
 * `flatten()`, plugin-manifest-validator mapped messages, and the
 * badRequest/unprocessable/flatten sites in assets, cases, tool-gateway,
 * approvals, secrets, execution workspaces, environment config, tool policy
 * conditions, summary slots, documents, pipelines, search and file resources.
 *
 * The harness entries for those sites repeat the site's own parse and
 * serialization (`zod3IssueParams` + `toZod3Issues` / `flattenZod3Issues`
 * since the zod 4 migration); keep them in step with the site when it
 * changes. On zod 4 the full bodies still equal the zod 3 goldens; the
 * contract view is what the test requires.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const GOLDEN_FILE = path.join(here, "fixtures", "zod3-validation-error-goldens.json");

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

type CaseResult = { status: number; body: unknown };
const results: Record<string, CaseResult> = {};

// ─── contract view ───────────────────────────────────────────────────────────

const CONTRACT_ISSUE_FIELDS = ["code", "path", "message", "expected", "received"] as const;

function looksLikeZodIssue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && Array.isArray(record.path) && typeof record.message === "string";
}

/** Projects every zod issue in a response body onto the contract fields. */
function contractView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => contractView(entry));
  if (looksLikeZodIssue(value)) {
    const projected: Record<string, unknown> = {};
    for (const field of CONTRACT_ISSUE_FIELDS) {
      if (field in value) projected[field] = value[field];
    }
    return projected;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, contractView(entry)]),
    );
  }
  return value;
}

// ─── harnesses ───────────────────────────────────────────────────────────────

const boardActor = {
  type: "board",
  userId: "board-user",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: true,
};

async function loadErrorHandler() {
  const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
  return errorHandler;
}

async function loadValidate() {
  const { validate } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
  return validate;
}

function withActor(app: express.Express, actor: Record<string, unknown> = boardActor) {
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
}

/** Mounts `handler` at POST /probe with the real errorHandler behind it. */
async function probeApp(handler: RequestHandler) {
  const app = express();
  withActor(app);
  app.post("/probe", handler);
  app.use(await loadErrorHandler());
  return app;
}

async function record(name: string, response: request.Response) {
  results[name] = { status: response.status, body: response.body };
}

/** A non-HTTP result (status 0), e.g. a validator's safe-parse result object. */
function recordValue(name: string, value: unknown) {
  results[name] = { status: 0, body: JSON.parse(JSON.stringify(value)) };
}

/** The global validate() + errorHandler path for one schema. */
async function recordValidate(name: string, schema: z.ZodType, body: unknown) {
  const validate = await loadValidate();
  const app = await probeApp((req, res, next) => {
    validate(schema)(req, res, (error?: unknown) => {
      if (error) return next(error);
      res.status(200).json({ ok: true, body: req.body });
    });
  });
  await record(name, await request(app).post("/probe").send(body as object));
}

/** A handler that throws (or calls next with) whatever `fn` throws. */
async function recordThrown(name: string, fn: (req: Request, res: Response) => unknown, body: unknown = {}) {
  const app = await probeApp(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.status(200).json({ ok: true, out });
    } catch (error) {
      next(error);
    }
  });
  await record(name, await request(app).post("/probe").send(body as object));
}

// ─── issue routes (real router) ──────────────────────────────────────────────

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

function registerIssueRouteMocks() {
  vi.doMock("../services/index.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_test",
        explanation: "Allowed by test mock.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({ getById: vi.fn(), list: vi.fn(async () => []) }),
    companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
    companyService: () => ({ getById: vi.fn(async () => ({ id: companyId, attachmentMaxBytes: 10_000_000 })) }),
    documentAnnotationService: () => ({}),
    documentService: () => ({ getIssueDocumentByKey: vi.fn(async () => null) }),
    environmentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({ wakeup: vi.fn(async () => undefined), reportRunActivity: vi.fn(async () => undefined) }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({ id: "settings", general: {} })),
      getExperimental: vi.fn(async () => ({})),
      getGeneral: vi.fn(async () => ({})),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueReferenceService: () => ({
      emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
      listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({}),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

async function issueRoutesApp() {
  const [{ issueRoutes }, errorHandler] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    loadErrorHandler(),
  ]);
  const app = express();
  withActor(app);
  app.use("/api", issueRoutes({} as never, {} as never));
  app.use(errorHandler);
  return app;
}

// ─── capture ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  vi.resetModules();
  registerIssueRouteMocks();
  mockIssueService.getById.mockResolvedValue({
    id: issueId,
    companyId,
    title: "Golden",
    status: "in_progress",
    assigneeAgentId: null,
  });
  mockIssueService.assertCheckoutOwner.mockResolvedValue({});

  const shared = await import("@paperclipai/shared");

  // Real issue router: validate() + errorHandler, and the direct document-key site.
  const issuesApp = await issueRoutesApp();
  await record(
    "route POST /api/companies/:companyId/issues {} (validate createIssueSchema)",
    await request(issuesApp).post(`/api/companies/${companyId}/issues`).send({}),
  );
  await record(
    "route POST /api/companies/:companyId/issues mixed invalid fields",
    await request(issuesApp).post(`/api/companies/${companyId}/issues`).send({
      title: 7,
      status: "nope",
      priority: "urgent",
      projectId: "not-a-uuid",
      blockedByIssueIds: ["also-not-a-uuid"],
    }),
  );
  await record(
    "route PATCH /api/issues/:id invalid fields (validate updateIssueRouteSchema)",
    await request(issuesApp).patch(`/api/issues/${issueId}`).send({ title: "", assigneeAgentId: 5, priority: null }),
  );
  await record(
    "route PUT /api/issues/:id/documents/:key {} (validate upsertIssueDocumentSchema)",
    await request(issuesApp).put(`/api/issues/${issueId}/documents/plan`).send({}),
  );
  await record(
    "route GET /api/issues/:id/documents/:key invalid key (issues.ts details: error.issues)",
    await request(issuesApp).get(`/api/issues/${issueId}/documents/${encodeURIComponent("bad key!")}`),
  );
  await record(
    "route POST /api/issues/:id/inbox-archive unknown key (validate strict inboxArchiveBodySchema)",
    await request(issuesApp).post(`/api/issues/${issueId}/inbox-archive`).send({ bogus: true }),
  );

  // Real company skill policy router: 422 { issues: error.issues }.
  {
    const [{ companySkillPolicyRoutes }, errorHandler] = await Promise.all([
      vi.importActual<typeof import("../routes/company-skill-policy.js")>("../routes/company-skill-policy.js"),
      loadErrorHandler(),
    ]);
    const app = express();
    withActor(app);
    app.use("/api", companySkillPolicyRoutes({} as never));
    app.use(errorHandler);
    await record(
      "route PUT /api/companies/:companyId/skill-policy {} (422 issues)",
      await request(app).put(`/api/companies/${companyId}/skill-policy`).send({}),
    );
    await record(
      "route PUT /api/companies/:companyId/skill-policy invalid rules (422 issues)",
      await request(app).put(`/api/companies/${companyId}/skill-policy`).send({ rules: [{ effect: "maybe" }], extra: 1 }),
    );
  }

  // Real decision training router: validate() on POST, flatten() on GET.
  {
    const [{ decisionTrainingRoutes }, errorHandler] = await Promise.all([
      vi.importActual<typeof import("../routes/decision-training.js")>("../routes/decision-training.js"),
      loadErrorHandler(),
    ]);
    const app = express();
    withActor(app);
    app.use("/api", decisionTrainingRoutes({} as never));
    app.use(errorHandler);
    await record(
      "route GET /api/companies/:companyId/decision-training invalid query (flatten)",
      await request(app).get(`/api/companies/${companyId}/decision-training`).query({ project: "nope", kind: "bogus" }),
    );
    await record(
      "route POST /api/companies/:companyId/decision-training {} (validate createSchema)",
      await request(app).post(`/api/companies/${companyId}/decision-training`).send({}),
    );
  }

  // Global validate() + errorHandler with the real route schemas.
  await recordValidate("validate createApprovalSchema unknown discriminator", shared.createApprovalSchema, { type: "nope" });
  await recordValidate("validate createApprovalSchema {}", shared.createApprovalSchema, {});
  await recordValidate("validate createRoutineTriggerSchema schedule missing cron", shared.createRoutineTriggerSchema, {
    kind: "schedule",
  });
  await recordValidate("validate createCostEventSchema bad datetime and types", shared.createCostEventSchema, {
    agentId: "nope",
    provider: "",
    model: "m",
    inputTokens: 1.5,
    costCents: -1,
    occurredAt: "yesterday",
  });
  await recordValidate("validate updateCompanySchema int and min", shared.updateCompanySchema, {
    budgetMonthlyCents: 1.5,
    name: "",
  });
  await recordValidate("validate updateCompanySchema negative budget", shared.updateCompanySchema, { budgetMonthlyCents: -5 });
  await recordValidate("validate patchInstanceExperimentalSettingsSchema unknown key and wrong type", shared.patchInstanceExperimentalSettingsSchema, {
    bogusFlag: true,
    enableApps: "yes",
  });
  await recordValidate("validate updateCurrentUserProfileSchema union miss", shared.updateCurrentUserProfileSchema, {
    image: 5,
  });
  await recordValidate("validate createIssueSchema too long title and null description", shared.createIssueSchema, {
    title: "x".repeat(5000),
    status: "todo",
    description: 5,
  });
  await recordValidate("validate createToolMcpGatewaySchema nested invalid", shared.createToolMcpGatewaySchema, {
    name: "",
    authConfig: { bearer: { enabled: "yes" } },
  });
  await recordValidate("validate requestBoardApprovalPayloadSchema gate_b email", shared.requestBoardApprovalPayloadSchema, {
    gate: "gate_b",
    ccRecipient: "not-an-email",
  });
  await recordValidate("validate createIssueThreadInteractionSchema unknown kind", shared.createIssueThreadInteractionSchema, {
    kind: "nope",
  });
  await recordValidate("validate createIssueThreadInteractionSchema bad payload", shared.createIssueThreadInteractionSchema, {
    kind: "request_confirmation",
    payload: { version: 2, prompt: "", resultHref: "not a url" },
  });
  await recordValidate("validate pluginManifestV1Schema {}", shared.pluginManifestV1Schema, {});

  // Direct serialization sites (same schema and same serialization as the site).
  const errors = await vi.importActual<typeof import("../errors.js")>("../errors.js");

  // routes/assets.ts:136 res.status(400).json({ error: "Invalid image metadata", details: issues })
  await recordThrown("site assets.ts invalid image metadata", (req, res) => {
    const parsedMeta = shared.createAssetImageMetadataSchema.safeParse(req.body ?? {}, shared.zod3IssueParams);
    if (!parsedMeta.success) res.status(400).json({ error: "Invalid image metadata", details: shared.toZod3Issues(parsedMeta.error.issues) });
  }, { namespace: "bad space!" });

  // routes/cases.ts:141/725/1347 badRequest(message, issues)
  const cases = await vi.importActual<typeof import("../routes/cases.js")>("../routes/cases.js");
  await recordThrown("site cases.ts invalid document key", () => {
    const parsed = cases.documentKeySchema.safeParse("bad key!", shared.zod3IssueParams);
    if (!parsed.success) throw errors.badRequest("Invalid document key", shared.toZod3Issues(parsed.error.issues));
  });
  await recordThrown("site cases.ts invalid case list query", () => {
    const parsed = cases.listCasesQuerySchema.safeParse({ limit: "0" }, shared.zod3IssueParams);
    if (!parsed.success) throw errors.badRequest("Invalid case list query", shared.toZod3Issues(parsed.error.issues));
  });
  await recordThrown("site cases.ts invalid case events query", () => {
    const parsed = cases.listEventsQuerySchema.safeParse({ limit: "abc" }, shared.zod3IssueParams);
    if (!parsed.success) throw errors.badRequest("Invalid case events query", shared.toZod3Issues(parsed.error.issues));
  });

  // routes/tool-gateway.ts:298/324/345 res.status(422).json({ error, issues })
  for (const [label, schema, body] of [
    ["createToolMcpGatewaySchema", shared.createToolMcpGatewaySchema, {}],
    ["updateToolMcpGatewaySchema", shared.updateToolMcpGatewaySchema, {}],
    ["createToolMcpGatewayTokenSchema", shared.createToolMcpGatewayTokenSchema, {}],
  ] as const) {
    await recordThrown(`site tool-gateway.ts ${label} {}`, (req, res) => {
      const parsed = (schema as z.ZodType).safeParse(req.body ?? {}, shared.zod3IssueParams);
      if (!parsed.success) {
        const error = label === "createToolMcpGatewayTokenSchema" ? "Invalid gateway token payload" : "Invalid gateway payload";
        res.status(422).json({ error, issues: shared.toZod3Issues(parsed.error.issues) });
      }
    }, body);
  }

  // routes/approvals.ts:63-73 badRequest("Validation error", issues with payload path prefix)
  await recordThrown("site approvals.ts request_board_approval payload", () => {
    const result = shared.requestBoardApprovalPayloadSchema.safeParse({}, shared.zod3IssueParams);
    if (!result.success) {
      throw errors.badRequest(
        "Validation error",
        shared.toZod3Issues(result.error.issues).map((issue) => ({ ...issue, path: ["payload", ...issue.path] })),
      );
    }
  });

  // services/secrets.ts:989/2338 unprocessable(message, error.flatten())
  await recordThrown("site secrets.ts invalid provider vault config (flatten)", () => {
    const parsed = shared.secretProviderConfigPayloadSchema.safeParse(
      { provider: "aws_secrets_manager", config: { region: 5 } },
      shared.zod3IssueParams,
    );
    if (!parsed.success) throw errors.unprocessable("Invalid provider vault config", shared.flattenZod3Issues(parsed.error.issues));
  });
  await recordThrown("site secrets.ts invalid provider discovery config (flatten)", () => {
    const parsed = shared.secretProviderConfigDiscoveryPreviewSchema.safeParse({
      provider: "nope",
      config: {},
      query: 5,
      pageSize: 0,
    }, shared.zod3IssueParams);
    if (!parsed.success) {
      throw errors.unprocessable("Invalid provider vault discovery config", shared.flattenZod3Issues(parsed.error.issues));
    }
  });

  // services/issue-execution-policy.ts:343 (real function) unprocessable("Invalid execution policy", flatten())
  const executionPolicy = await vi.importActual<typeof import("../services/issue-execution-policy.js")>(
    "../services/issue-execution-policy.js",
  );
  await recordThrown("site issue-execution-policy.ts normalizeIssueExecutionPolicy (flatten)", () =>
    executionPolicy.normalizeIssueExecutionPolicy({ mode: "bogus", stages: "x" }),
  );

  // routes/execution-workspaces.ts:99 res.status(422).json({ error, details: flatten() })
  await recordThrown("site execution-workspaces.ts invalid overview query (flatten)", (_req, res) => {
    const parsed = shared.workspaceOverviewQuerySchema.safeParse({ limit: "abc", status: 5 }, shared.zod3IssueParams);
    if (!parsed.success) {
      res.status(422).json({ error: "Invalid workspace overview query", details: shared.flattenZod3Issues(parsed.error.issues) });
    }
  });

  // services/environment-config.ts:349+ (real function) unprocessable(first issue message, { issues })
  const environmentConfig = await vi.importActual<typeof import("../services/environment-config.js")>(
    "../services/environment-config.js",
  );
  await recordThrown("site environment-config.ts ssh config missing fields", () =>
    environmentConfig.normalizeEnvironmentConfig({ driver: "ssh", config: {} }),
  );
  await recordThrown("site environment-config.ts ssh config wrong types", () =>
    environmentConfig.normalizeEnvironmentConfig({
      driver: "ssh",
      config: { host: "h", username: "u", remoteWorkspacePath: "relative", port: "abc" },
    }),
  );

  // services/tool-access-policy.ts:589/1180 mapped { path: joined, message }
  await recordThrown("site tool-access-policy.ts unsupported policy conditions", () => {
    const parsed = shared.toolPolicyConditionsSchema.safeParse({ arguments: { fieldMatches: 5 }, bogus: true }, shared.zod3IssueParams);
    if (!parsed.success) {
      throw errors.unprocessable("Tool policy conditions include unsupported runtime semantics", {
        issues: shared.toZod3Issues(parsed.error.issues).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
  });

  // services/summary-slots.ts:146 unprocessable("Invalid summary slot selector", issues)
  await recordThrown("site summary-slots.ts invalid selector", () => {
    const parsed = shared.summarySlotScopeSelectorSchema.safeParse(
      { scopeKind: "nope", slotKey: "", scopeId: undefined },
      shared.zod3IssueParams,
    );
    if (!parsed.success) throw errors.unprocessable("Invalid summary slot selector", shared.toZod3Issues(parsed.error.issues));
  });

  // services/documents.ts:11 unprocessable / routes/pipelines.ts:557 badRequest ("Invalid document key", issues)
  await recordThrown("site documents.ts invalid document key", () => {
    const parsed = shared.issueDocumentKeySchema.safeParse("bad key!", shared.zod3IssueParams);
    if (!parsed.success) throw errors.unprocessable("Invalid document key", shared.toZod3Issues(parsed.error.issues));
  });
  await recordThrown("site pipelines.ts invalid document key", () => {
    const parsed = shared.issueDocumentKeySchema.safeParse(String(" Bad Key! ").trim().toLowerCase(), shared.zod3IssueParams);
    if (!parsed.success) throw errors.badRequest("Invalid document key", shared.toZod3Issues(parsed.error.issues));
  });

  // routes/issues.ts:3187 unprocessable(message, { code, details: issues })
  const issuesModule = await vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js");
  await recordThrown("site issues.ts invalid attachment artifact metadata", () => {
    const parsed = issuesModule.attachmentArtifactMetadataInputSchema.safeParse({ attachmentId: "nope" }, shared.zod3IssueParams);
    if (!parsed.success) {
      throw errors.unprocessable("Invalid attachment artifact metadata", {
        code: "invalid_attachment_artifact_metadata",
        details: shared.toZod3Issues(parsed.error.issues),
      });
    }
  });

  // routes/issues.ts:4629/4663 res.status(400).json({ error: issues[0].message })
  await recordThrown("site issues.ts invalid search query (first issue message)", (_req, res) => {
    const parsedQuery = shared.companySearchQuerySchema.safeParse({ q: "x", limit: "abc" }, shared.zod3IssueParams);
    if (!parsedQuery.success) {
      res.status(400).json({ error: shared.toZod3Issues(parsedQuery.error.issues)[0]?.message ?? "Invalid search query" });
    }
  });
  await recordThrown("site issues.ts invalid extract search query (first issue message)", (_req, res) => {
    const parsedQuery = shared.companySearchExtractQuerySchema.safeParse({ q: "", limit: "-1" }, shared.zod3IssueParams);
    if (!parsedQuery.success) {
      res.status(400).json({ error: shared.toZod3Issues(parsedQuery.error.issues)[0]?.message ?? "Invalid extract search query" });
    }
  });

  // routes/file-resources.ts:122-138 refinement issue with params.code -> unprocessable(message, { code })
  for (const [label, query] of [
    ["control character in path", { path: "docs/a\u0001b.md" }],
    ["half a target", { path: "docs/a.md", projectId: issueId }],
    ["missing path", {}],
  ] as const) {
    await recordThrown(`site file-resources.ts readQuery ${label}`, () => {
      const parsed = shared.workspaceFileResourceQuerySchema.safeParse(query, shared.zod3IssueParams);
      if (parsed.success) return parsed.data;
      const refinement = parsed.error.issues.find((issue) => {
        const code = (issue as { params?: { code?: string } }).params?.code;
        return code === "invalid_path" || code === "invalid_target";
      });
      const code = (refinement as { params?: { code?: string } } | undefined)?.params?.code;
      if (refinement) throw errors.unprocessable(refinement.message, { code: code ?? "invalid_path" });
      throw parsed.error;
    });
  }

  // services/plugin-manifest-validator.ts:131 mapped { path, message } + joined error string
  const { pluginManifestValidator } = await vi.importActual<typeof import("../services/plugin-manifest-validator.js")>(
    "../services/plugin-manifest-validator.js",
  );
  const validator = pluginManifestValidator();
  const baseManifest = {
    id: "test.golden",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Golden",
    description: "Golden plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "dist/worker.js" },
  };
  recordValue("site plugin-manifest-validator.ts parse({})", validator.parse({}));
  recordValue(
    "site plugin-manifest-validator.ts parse(invalid fields)",
    validator.parse({ ...baseManifest, id: "Bad Id", apiVersion: 9, categories: ["nope"], capabilities: ["nope"] }),
  );
  await recordThrown("site plugin-manifest-validator.ts parseOrThrow(invalid)", () =>
    validator.parseOrThrow({ ...baseManifest, version: "", entrypoints: {} }),
  );

  if (process.env[ZOD_BASELINE_UPDATE_ENV] === "1") {
    if (!zodVersion.startsWith("3.")) {
      throw new Error(`${ZOD_BASELINE_UPDATE_ENV}=1 refused: validation-error goldens are zod 3 baselines (running zod ${zodVersion}).`);
    }
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(
      GOLDEN_FILE,
      `${JSON.stringify(
        {
          capturedWith: `zod@${zodVersion}`,
          note:
            "Full 4xx bodies captured before the zod 4 migration. The contract compared after the migration is the " +
            "status, the envelope, and code/path/message/expected/received of every zod issue (see contractView).",
          data: results,
        },
        null,
        1,
      )}\n`,
    );
  }
}, 120_000);

type GoldenFile = { capturedWith: string; data: Record<string, CaseResult> };

function readGoldenFile(): GoldenFile {
  return JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8")) as GoldenFile;
}

describe("validation error goldens (zod 3 baseline)", () => {
  // Read at collection time to create one test per case; an update run that
  // creates the file only checks the case set, the next run checks each case.
  const golden: GoldenFile = fs.existsSync(GOLDEN_FILE) ? readGoldenFile() : { capturedWith: "", data: {} };

  it("captures the same set of cases", () => {
    expect(Object.keys(results).sort()).toEqual(Object.keys(readGoldenFile().data).sort());
  });

  for (const name of Object.keys(golden.data)) {
    it(`keeps the response contract: ${name}`, () => {
      const current = results[name];
      const expected = golden.data[name];
      expect(current?.status).toBe(expected.status);
      if (expected.status !== 0) {
        expect(expected.status).toBeGreaterThanOrEqual(400);
        expect(expected.status).toBeLessThan(500);
      }
      expect(contractView(current?.body)).toEqual(contractView(expected.body));
      if (zodVersion.startsWith("3.")) expect(current?.body).toEqual(expected.body);
    });
  }
});
