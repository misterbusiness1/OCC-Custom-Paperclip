import { afterEach, describe, expect, it, vi } from "vitest";
import {
  companySecretBindings,
  environmentLeases,
  heartbeatRuns,
} from "@paperclipai/db";
const secret = vi.hoisted(() => ({
  resolve: vi.fn(async () => "aoc_" + "1".repeat(64)),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ resolveSecretValue: secret.resolve }),
}));
import { prepareManagedOnecliAssignment } from "../services/managed-onecli-assignment.js";
import {
  ONECLI_IDENTITY_METADATA,
  ONECLI_IDENTITY_PATH,
} from "../services/managed-onecli-identity.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("native assigned credential version resolution", () => {
  it("passes the verified immutable version through native secretService with exact run/binding scope", async () => {
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
    };
    const canonical = {
      companyId: "company",
      scope: "company",
      provider: "local_encrypted",
      latestVersion: 7,
      status: "active",
      deletedAt: null,
      providerMetadata: { [ONECLI_IDENTITY_METADATA]: identity },
    };
    const run = {
      id: "run",
      companyId: "company",
      agentId: "agent",
      status: "running",
    };
    const lease = {
      id: "lease",
      companyId: "company",
      environmentId: "environment",
      heartbeatRunId: "run",
      status: "active",
      provider: "kubernetes",
      providerLeaseId: "owned-pod",
      releasedAt: null,
      metadata: {
        agentId: "agent",
        onecliBootstrapPolicy: "run-bindings-only-v1",
      },
    };
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const query = {
            innerJoin: () => query,
            where: () =>
              Promise.resolve(
                table === heartbeatRuns
                  ? [run]
                  : table === environmentLeases
                    ? [lease]
                    : table === companySecretBindings
                      ? [{ binding: assignment, secret: canonical }]
                      : [],
              ),
          };
          return query;
        },
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "assigned",
              identifier: "support",
              projectId: "project",
              organizationId: "org",
            }),
          ),
      ),
    );
    const config: Record<string, unknown> = { env: {} };
    const keys = new Set<string>();
    const redaction = vi.fn();
    await prepareManagedOnecliAssignment(
      db as never,
      {
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
      },
      redaction,
      config,
      keys,
    );
    expect(secret.resolve).toHaveBeenCalledWith("company", "secret", 7, {
      bindingContext: {
        consumerType: "agent",
        consumerId: "agent",
        configPath: ONECLI_IDENTITY_PATH,
      },
      accessContext: {
        consumerType: "agent",
        consumerId: "agent",
        configPath: ONECLI_IDENTITY_PATH,
        actorType: "system",
        actorId: "managed-onecli-projection",
        heartbeatRunId: "run",
      },
    });
    expect(redaction).toHaveBeenCalledWith("aoc_" + "1".repeat(64));
    expect(keys.has("ONECLI_AGENT_TOKEN")).toBe(true);
  });
});
