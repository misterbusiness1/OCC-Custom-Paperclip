import { describe, expect, it, vi } from "vitest";
import {
  applyTrustedEnvProjection,
  assertOrdinaryOnecliBinding,
  hasOnecliIdentity,
  ONECLI_IDENTITY_METADATA,
  ONECLI_IDENTITY_PATH,
  parseOnecliIdentity,
  resolveManagedOnecliProjection,
  projectManagedOnecliToRealizedWorker,
  scrubOnecliEnv,
  type ManagedOnecliProjectionDependencies,
  type ManagedOnecliProjectionInput,
} from "../services/managed-onecli-identity.js";

function fixture() {
  const identity = {
    version: 1 as const,
    companyId: "company",
    agentId: "agent",
    environmentId: "environment",
    id: "onecli-agent",
    identifier: "support",
    projectId: "project",
    organizationId: "org",
  };
  const input: ManagedOnecliProjectionInput = {
    companyId: "company",
    agentId: "agent",
    runId: "run",
    environmentId: "environment",
    driver: "sandbox",
    executionTarget: {
      kind: "remote",
      transport: "sandbox",
      providerKey: "kubernetes",
      environmentId: "environment",
      leaseId: "lease",
    },
    trustedApiBase: "https://onecli.internal",
  };
  const assignment = {
    companyId: "company",
    targetType: "agent",
    targetId: "agent",
    configPath: ONECLI_IDENTITY_PATH,
    secretId: "secret",
    required: true,
    versionSelector: "latest",
    secret: {
      companyId: "company",
      scope: "company",
      provider: "local_encrypted",
      latestVersion: 1,
      status: "active",
      deletedAt: null as unknown,
      providerMetadata: { [ONECLI_IDENTITY_METADATA]: identity },
    },
  };
  const run = {
    id: "run",
    companyId: "company",
    agentId: "agent",
    status: "running",
  };
  const self = {
    id: identity.id,
    identifier: identity.identifier,
    projectId: identity.projectId,
    organizationId: identity.organizationId,
  };
  const lease = {
    id: "lease",
    companyId: "company",
    environmentId: "environment",
    heartbeatRunId: "run",
    status: "active",
    provider: "kubernetes",
    providerLeaseId: "owned-job",
    releasedAt: null as unknown,
    metadata: {
      agentId: "agent",
      onecliBootstrapPolicy: "run-bindings-only-v1",
    },
  };
  const deps: ManagedOnecliProjectionDependencies = {
    loadRun: vi.fn(async () => run),
    loadLease: vi.fn(async () => lease),
    loadAssignment: vi.fn(async () => assignment),
    resolveSecret: vi.fn(async () => "aoc_synthetic_test_only"),
    registerForRedaction: vi.fn(),
    fetch: vi.fn(
      async () => new Response(JSON.stringify(self), { status: 200 }),
    ) as unknown as typeof fetch,
  };
  return { input, deps, assignment, run, identity, self, lease };
}
describe("managed OneCLI projection", () => {
  it("reads the immutable secret version from the verified assignment snapshot", async () => {
    const f = fixture();
    await resolveManagedOnecliProjection(f.input, f.deps);
    expect(f.deps.resolveSecret).toHaveBeenCalledWith("secret", 1);
  });
  it("refuses rotation while HTTP verification is pending without installing any credential", async () => {
    const f = fixture();
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.deps.fetch = vi.fn(async () => {
      started();
      await pending;
      return new Response(JSON.stringify(f.self));
    }) as unknown as typeof fetch;
    const config: Record<string, unknown> = { env: { WORK: "unchanged" } };
    const keys = new Set<string>();
    const work = projectManagedOnecliToRealizedWorker(
      f.input,
      f.deps,
      config,
      keys,
    );
    await entered;
    f.assignment.secret.latestVersion = 2;
    finish();
    await expect(work).rejects.toThrow("could not be verified");
    expect(config.env).toEqual({ WORK: "unchanged" });
    expect(keys.size).toBe(0);
    expect(f.deps.resolveSecret).toHaveBeenCalledWith("secret", 1);
  });

  for (const field of [
    "id",
    "companyId",
    "environmentId",
    "heartbeatRunId",
    "status",
    "provider",
    "providerLeaseId",
  ] as const) {
    it(`refuses invalid durable worker lease ${field} before reading a credential`, async () => {
      const f = fixture();
      f.lease[field] = field === "providerLeaseId" ? "" : "foreign";
      await expect(
        resolveManagedOnecliProjection(f.input, f.deps),
      ).rejects.toThrow();
      expect(f.deps.resolveSecret).not.toHaveBeenCalled();
    });
  }
  it("refuses a foreign lease agent or missing bootstrap isolation marker", async () => {
    const f = fixture();
    f.lease.metadata.agentId = "foreign";
    await expect(
      resolveManagedOnecliProjection(f.input, f.deps),
    ).rejects.toThrow();
    f.lease.metadata.agentId = "agent";
    f.lease.metadata.onecliBootstrapPolicy = "legacy";
    await expect(
      resolveManagedOnecliProjection(f.input, f.deps),
    ).rejects.toThrow();
    expect(f.deps.resolveSecret).not.toHaveBeenCalled();
  });

  it("uses only the pinned endpoint, redacts before HTTP, and projects through the native env seam", async () => {
    const f = fixture();
    f.deps.fetch = vi.fn(async (url, options) => {
      expect(String(url)).toBe("https://onecli.internal/v1/agent-identity");
      expect(f.deps.registerForRedaction).toHaveBeenCalledWith(
        "aoc_synthetic_test_only",
      );
      expect(options?.redirect).toBe("error");
      expect(options?.headers).toEqual({
        Authorization: "Bearer aoc_synthetic_test_only",
        Accept: "application/json",
      });
      return new Response(JSON.stringify(f.self));
    }) as typeof fetch;
    const projection = await resolveManagedOnecliProjection(f.input, f.deps);
    const config = {
      env: {
        CODEX_HOME: "/worker/codex",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      },
    };
    const keys = new Set<string>();
    applyTrustedEnvProjection(
      config,
      projection.env,
      keys,
      projection.secretKeys,
    );
    expect(config.env).toMatchObject({
      CODEX_HOME: "/worker/codex",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      ONECLI_AGENT_TOKEN: "aoc_synthetic_test_only",
    });
    expect([...keys]).toEqual(["ONECLI_AGENT_TOKEN"]);
  });
  for (const [label, mutate] of [
    [
      "local process",
      (f: ReturnType<typeof fixture>) => {
        f.input.executionTarget.kind = "local";
      },
    ],
    [
      "SSH",
      (f: ReturnType<typeof fixture>) => {
        f.input.executionTarget.transport = "ssh";
      },
    ],
    [
      "foreign provider",
      (f: ReturnType<typeof fixture>) => {
        f.input.executionTarget.providerKey = "other";
      },
    ],
    [
      "foreign target environment",
      (f: ReturnType<typeof fixture>) => {
        f.input.executionTarget.environmentId = "foreign";
      },
    ],
    [
      "missing lease",
      (f: ReturnType<typeof fixture>) => {
        f.input.executionTarget.leaseId = null;
      },
    ],
    [
      "non sandbox environment",
      (f: ReturnType<typeof fixture>) => {
        f.input.driver = "local";
      },
    ],
    [
      "foreign run",
      (f: ReturnType<typeof fixture>) => {
        f.run.id = "foreign";
      },
    ],
    [
      "foreign run company",
      (f: ReturnType<typeof fixture>) => {
        f.run.companyId = "foreign";
      },
    ],
    [
      "foreign run agent",
      (f: ReturnType<typeof fixture>) => {
        f.run.agentId = "foreign";
      },
    ],
    [
      "stopped run",
      (f: ReturnType<typeof fixture>) => {
        f.run.status = "cancelled";
      },
    ],
    [
      "foreign binding company",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.companyId = "foreign";
      },
    ],
    [
      "foreign binding target",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.targetId = "foreign";
      },
    ],
    [
      "project binding",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.targetType = "project";
      },
    ],
    [
      "ordinary env binding",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.configPath = "env.ONECLI_AGENT_TOKEN";
      },
    ],
    [
      "optional binding",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.required = false;
      },
    ],
    [
      "pinned historical version",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.versionSelector = "1";
      },
    ],
    [
      "foreign secret company",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.secret.companyId = "foreign";
      },
    ],
    [
      "user secret",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.secret.scope = "user";
      },
    ],
    [
      "remote vault",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.secret.provider = "vault";
      },
    ],
    [
      "disabled secret",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.secret.status = "disabled";
      },
    ],
    [
      "deleted secret",
      (f: ReturnType<typeof fixture>) => {
        f.assignment.secret.deletedAt = new Date();
      },
    ],
    [
      "foreign identity company",
      (f: ReturnType<typeof fixture>) => {
        f.identity.companyId = "foreign";
      },
    ],
    [
      "foreign identity agent",
      (f: ReturnType<typeof fixture>) => {
        f.identity.agentId = "foreign";
      },
    ],
    [
      "foreign identity environment",
      (f: ReturnType<typeof fixture>) => {
        f.identity.environmentId = "foreign";
      },
    ],
    [
      "HTTP API",
      (f: ReturnType<typeof fixture>) => {
        f.input.trustedApiBase = "http://onecli.internal";
      },
    ],
    [
      "URL credential",
      (f: ReturnType<typeof fixture>) => {
        f.input.trustedApiBase = "https://owner:secret@onecli.internal";
      },
    ],
    [
      "URL endpoint override",
      (f: ReturnType<typeof fixture>) => {
        f.input.trustedApiBase = "https://onecli.internal/foreign";
      },
    ],
  ] as const)
    it(`refuses ${label} before any credential read`, async () => {
      const f = fixture();
      mutate(f);
      await expect(
        resolveManagedOnecliProjection(f.input, f.deps),
      ).rejects.toThrow();
      expect(f.deps.resolveSecret).not.toHaveBeenCalled();
      expect(f.deps.fetch).not.toHaveBeenCalled();
    });
  for (const key of [
    "id",
    "identifier",
    "projectId",
    "organizationId",
  ] as const)
    it(`refuses a foreign self-identity ${key}`, async () => {
      const f = fixture();
      f.self[key] = "foreign";
      await expect(
        resolveManagedOnecliProjection(f.input, f.deps),
      ).rejects.toThrow("could not be verified");
      expect(f.deps.registerForRedaction).toHaveBeenCalledOnce();
    });
  for (const [label, response] of [
    [
      "unauthorized",
      () => new Response("synthetic-token-must-not-appear", { status: 401 }),
    ],
    [
      "redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://foreign" },
        }),
    ],
    ["invalid JSON", () => new Response("not JSON")],
    ["oversized metadata", () => new Response("x".repeat(4097))],
    ["empty response", () => new Response(null)],
    [
      "extra identity fields",
      () =>
        new Response(
          JSON.stringify({ ...fixture().self, accessToken: "synthetic" }),
        ),
    ],
  ] as const)
    it(`refuses ${label} without exposing response data`, async () => {
      const f = fixture();
      f.deps.fetch = vi.fn(async () => response()) as unknown as typeof fetch;
      await expect(
        resolveManagedOnecliProjection(f.input, f.deps),
      ).rejects.toThrow(/^Managed OneCLI assignment could not be verified$/);
    });
  it("refuses a transport error without leaking its token-bearing error", async () => {
    const f = fixture();
    f.deps.fetch = vi.fn(async () => {
      throw new Error("aoc_synthetic_test_only");
    }) as typeof fetch;
    await expect(
      resolveManagedOnecliProjection(f.input, f.deps),
    ).rejects.toThrow(/^Managed OneCLI assignment could not be verified$/);
  });

  for (const kind of ["cancel", "reassign", "disable"])
    it(`refuses ${kind} during self-identity verification`, async () => {
      const f = fixture();
      f.deps.fetch = vi.fn(async () => {
        if (kind === "cancel") f.run.status = "cancelled";
        if (kind === "reassign") f.identity.agentId = "foreign";
        if (kind === "disable") f.assignment.secret.status = "disabled";
        return new Response(JSON.stringify(f.self));
      }) as unknown as typeof fetch;
      await expect(
        resolveManagedOnecliProjection(f.input, f.deps),
      ).rejects.toThrow();
    });
  it("refuses owner/admin API credentials", async () => {
    const f = fixture();
    f.deps.resolveSecret = vi.fn(async () => "owner_api_key");
    await expect(
      resolveManagedOnecliProjection(f.input, f.deps),
    ).rejects.toThrow();
    expect(f.deps.fetch).not.toHaveBeenCalled();
  });
});
describe("reserved identity authority", () => {
  it("rejects generic bindings to canonical secrets through any alias", () => {
    const f = fixture();
    expect(() =>
      assertOrdinaryOnecliBinding(
        f.assignment.secret.providerMetadata,
        "env.INNOCENT_ALIAS",
      ),
    ).toThrow();
    expect(() =>
      assertOrdinaryOnecliBinding(null, ONECLI_IDENTITY_PATH),
    ).toThrow();
    expect(() =>
      assertOrdinaryOnecliBinding(null, "env.ONECLI_AGENT_TOKEN"),
    ).toThrow();
    expect(() =>
      assertOrdinaryOnecliBinding({}, "env.OPENAI_API_KEY"),
    ).not.toThrow();
  });
  it("reserves even malformed or removed-to-null metadata", () => {
    expect(hasOnecliIdentity({ [ONECLI_IDENTITY_METADATA]: null })).toBe(true);
    expect(() =>
      parseOnecliIdentity({ [ONECLI_IDENTITY_METADATA]: null }),
    ).toThrow();
    expect(() =>
      parseOnecliIdentity({
        [ONECLI_IDENTITY_METADATA]: {
          ...fixture().identity,
          apiBase: "https://foreign",
        },
      }),
    ).toThrow();
  });
  it("scrubs all identity selectors while retaining worker home and subscription auth", () => {
    expect(
      scrubOnecliEnv({
        ONECLI_AGENT: "cto",
        ONECLI_AGENT_TOKEN: "foreign",
        ONECLI_API_KEY: "admin",
        ONECLI_API_BASE_URL: "https://foreign",
        ONECLI_HOME: "/admin",
        HOME: "/worker",
        CODEX_HOME: "/worker/codex",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      }),
    ).toEqual({
      HOME: "/worker",
      CODEX_HOME: "/worker/codex",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
    });
  });
});
