import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecutionRunAdapterConfig } from "../services/heartbeat.js";
import {
  managedOnecliBootstrapHint,
  ONECLI_IDENTITY_METADATA,
  ONECLI_IDENTITY_PATH,
  projectManagedOnecliToRealizedWorker,
} from "../services/managed-onecli-identity.js";
import { runAdapterExecutionTargetProcess } from "../../../packages/adapter-utils/src/execution-target.js";

afterEach(() => vi.unstubAllEnvs());
describe("native heartbeat managed identity seams", () => {
  it("derives the bootstrap hint only from the control-plane environment selection", () => {
    vi.stubEnv("PAPERCLIP_ONECLI_MANAGED_ENVIRONMENT_ID", "owned-environment");
    expect(managedOnecliBootstrapHint("owned-environment")).toEqual({
      onecliBootstrapPolicy: "run-bindings-only-v1",
    });
    expect(managedOnecliBootstrapHint("foreign-environment")).toEqual({});
    vi.stubEnv("PAPERCLIP_ONECLI_MANAGED_ENVIRONMENT_ID", "");
    expect(managedOnecliBootstrapHint("owned-environment")).toEqual({});
    expect(managedOnecliBootstrapHint("")).toEqual({});
  });

  for (const managed of [true, false])
    it(`keeps secret resolution ${managed ? "scrubbed for managed" : "unchanged for nonmanaged"} configs`, async () => {
      const resolveAdapterConfigForRuntime = vi.fn(
        async (_company, config) => ({
          config: structuredClone(config),
          secretKeys: new Set<string>(),
          manifest: [],
        }),
      );
      const resolveEnvBindings = vi.fn(async (_company, env) => ({
        env,
        secretKeys: new Set<string>(),
        manifest: [],
      }));
      const original = {
        env: {
          ONECLI_AGENT: "cto",
          ONECLI_API_KEY: "synthetic-foreign",
          WORK: "agent",
        },
      };
      const result = await resolveExecutionRunAdapterConfig({
        companyId: "company",
        agentId: "agent",
        environmentDriver: "sandbox",
        managedOnecliIdentity: managed,
        executionRunConfig: original,
        environmentEnv: {
          ONECLI_API_HOST: "https://foreign",
          ENV: "environment",
        },
        projectEnv: {
          ONECLI_AGENT_TOKEN: { type: "secret_ref", secretId: "foreign" },
          PROJECT: "project",
        },
        routineEnv: { ONECLI_HOME: "/operator", ROUTINE: "routine" },
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings,
        } as never,
      });
      expect(resolveAdapterConfigForRuntime.mock.calls[0][1].env).toEqual(
        managed ? { WORK: "agent" } : original.env,
      );
      expect(result.resolvedConfig.env).toMatchObject({
        WORK: "agent",
        ENV: "environment",
        PROJECT: "project",
        ROUTINE: "routine",
      });
      if (managed) {
        expect(
          Object.keys(result.resolvedConfig.env as object).some((key) =>
            key.startsWith("ONECLI_"),
          ),
        ).toBe(false);
        for (const call of resolveEnvBindings.mock.calls)
          expect(
            Object.keys(call[1]).some((key) => key.startsWith("ONECLI_")),
          ).toBe(false);
      } else
        expect(result.resolvedConfig.env).toHaveProperty("ONECLI_AGENT", "cto");
      expect(original.env.ONECLI_AGENT).toBe("cto");
    });
  it("requires native realization before secret access, then forwards only verified identity through native provider params.env", async () => {
    vi.stubEnv("ONECLI_API_KEY", "synthetic-parent-admin");
    vi.stubEnv("HOME", "/host/operator");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-assigned-subscription");
    const order: string[] = [];
    const identity = {
      version: 1,
      companyId: "company",
      agentId: "agent",
      environmentId: "environment",
      id: "assigned",
      identifier: "support",
      projectId: "project",
      organizationId: "org",
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
        deletedAt: null,
        providerMetadata: { [ONECLI_IDENTITY_METADATA]: identity },
      },
    };
    const deps = {
      loadRun: vi.fn(async () => {
        order.push("run");
        return {
          id: "run",
          companyId: "company",
          agentId: "agent",
          status: "running",
        };
      }),
      loadLease: vi.fn(async () => {
        order.push("lease");
        return {
          id: "lease",
          companyId: "company",
          environmentId: "environment",
          heartbeatRunId: "run",
          status: "active",
          provider: "kubernetes",
          providerLeaseId: "owned-job",
          releasedAt: null,
          metadata: {
            agentId: "agent",
            onecliBootstrapPolicy: "run-bindings-only-v1",
          },
        };
      }),
      loadAssignment: vi.fn(async () => {
        order.push("assignment");
        return assignment;
      }),
      resolveSecret: vi.fn(async () => {
        order.push("secret");
        return "aoc_synthetic_assigned";
      }),
      registerForRedaction: vi.fn(() => {
        order.push("redaction");
      }),
      fetch: vi.fn(async () => {
        order.push("selfIdentity");
        return new Response(
          JSON.stringify({
            id: "assigned",
            identifier: "support",
            projectId: "project",
            organizationId: "org",
          }),
        );
      }) as unknown as typeof fetch,
    };
    const input = {
      companyId: "company",
      agentId: "agent",
      runId: "run",
      environmentId: "environment",
      driver: "sandbox",
      executionTarget: null,
      trustedApiBase: "https://onecli.internal",
    };
    const config: Record<string, unknown> = {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-assigned-subscription",
        ONECLI_AGENT: "cto",
      },
    };
    const keys = new Set<string>();
    await expect(
      projectManagedOnecliToRealizedWorker(input, deps, config, keys),
    ).rejects.toThrow();
    expect(deps.resolveSecret).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    const execute = vi.fn(async (params) => {
      order.push("provider");
      expect(params.env).toMatchObject({
        ONECLI_AGENT_TOKEN: "aoc_synthetic_assigned",
        ONECLI_API_HOST: "https://onecli.internal",
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-assigned-subscription",
      });
      expect(params.env).not.toHaveProperty("ONECLI_API_KEY");
      expect(params.env).not.toHaveProperty("ONECLI_AGENT");
      expect(params.env).not.toHaveProperty("HOME");
      return {
        exitCode: 0,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: "fixture",
      };
    });
    const target = {
      kind: "remote" as const,
      transport: "sandbox" as const,
      providerKey: "kubernetes",
      environmentId: "environment",
      leaseId: "lease",
      remoteCwd: "/worker",
      runner: { execute },
    };
    await projectManagedOnecliToRealizedWorker(
      { ...input, executionTarget: target },
      deps,
      config,
      keys,
    );
    expect(keys.has("ONECLI_AGENT_TOKEN")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(target, "trustedRuntimeEnvKeys"),
    ).toMatchObject({ writable: false, configurable: false });
    await runAdapterExecutionTargetProcess(
      "run",
      target as never,
      "codex",
      ["--version"],
      {
        cwd: "/worker",
        env: {
          ONECLI_API_KEY: "synthetic-parent-admin",
          HOME: "/host/operator",
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic-assigned-subscription",
          ...(config.env as Record<string, string>),
        },
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
      },
    );
    expect(order).toEqual([
      "run",
      "lease",
      "assignment",
      "secret",
      "redaction",
      "selfIdentity",
      "run",
      "lease",
      "assignment",
      "provider",
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });
});
