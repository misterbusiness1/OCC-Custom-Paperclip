import { describe, expect, it, vi } from "vitest";
import {
  agents,
  companyMemberships,
  companySecrets,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { secretService } from "../services/secrets.js";
import {
  ONECLI_IDENTITY_METADATA,
  ONECLI_IDENTITY_PATH,
} from "../services/managed-onecli-identity.js";

// No provider, filesystem home preparation, or database is used in these seam tests.
vi.mock("../adapters/index.js", () => ({ findActiveServerAdapter: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  assertAccountHomeCacheDirStillValid: vi.fn(async () => {}),
  withAccountHomeSecretMutationLock: vi.fn(async (_root, _company, action) =>
    action(),
  ),
}));
function fixture(owner = false) {
  const identity = {
    version: 1,
    companyId: "company",
    agentId: "agent",
    environmentId: "environment",
    id: "onecli-agent",
    identifier: "support",
    projectId: "project",
    organizationId: "org",
  };
  const secret = {
    id: "secret",
    companyId: "company",
    scope: "company",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: { [ONECLI_IDENTITY_METADATA]: identity },
  };
  const values = vi.fn(() => ({
    onConflictDoUpdate: vi.fn(() => ({
      returning: vi.fn(async () => [{ id: "binding", targetId: "agent" }]),
    })),
  }));
  const insert = vi.fn(() => ({ values }));
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () =>
        Promise.resolve(
          table === companyMemberships
            ? owner
              ? [{ id: "owner-membership" }]
              : []
            : table === companySecrets
              ? [secret]
              : table === agents
                ? [{ id: "agent", reportsTo: null }]
                : table === heartbeatRuns
                  ? [{ id: "run", agentId: "agent", companyId: "company" }]
                  : table === issues
                    ? [{ id: "issue" }]
                    : [],
        ),
    }),
  }));
  const db = {
    select,
    insert,
    delete: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  return { svc: secretService(db as never), db, identity, secret, values };
}
describe("native secret service reserved assignment authority", () => {
  it("refuses an agent designating identity metadata before writes or provider access", async () => {
    const f = fixture();
    await expect(
      f.svc.create(
        "company",
        {
          name: "identity",
          provider: "local_encrypted",
          value: "synthetic-only",
          providerMetadata: f.secret.providerMetadata,
        },
        { agentId: "agent", userId: "owner" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.select).not.toHaveBeenCalled();
    expect(f.db.insert).not.toHaveBeenCalled();
  });
  it("does not treat a board user or company admin as the company owner", async () => {
    const f = fixture();
    await expect(
      f.svc.create(
        "company",
        {
          name: "identity",
          provider: "local_encrypted",
          value: "synthetic-only",
          providerMetadata: f.secret.providerMetadata,
        },
        { userId: "admin" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.insert).not.toHaveBeenCalled();
  });
  it("refuses owner metadata pointing to a foreign company before provider access", async () => {
    const f = fixture(true);
    f.identity.companyId = "foreign";
    await expect(
      f.svc.create(
        "company",
        {
          name: "identity",
          provider: "local_encrypted",
          value: "synthetic-only",
          providerMetadata: f.secret.providerMetadata,
        },
        { userId: "owner" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.insert).not.toHaveBeenCalled();
  });
  for (const operation of ["update", "rotate", "remove", "assign"] as const)
    it(`requires native owner membership for ${operation}`, async () => {
      const f = fixture();
      const work =
        operation === "update"
          ? f.svc.update(
              "secret",
              { providerMetadata: null },
              { userId: "admin" },
            )
          : operation === "rotate"
            ? f.svc.rotate(
                "secret",
                { value: "synthetic-only" },
                { userId: "admin" },
              )
            : operation === "remove"
              ? f.svc.remove("secret", { userId: "admin" })
              : f.svc.assignOnecliIdentity("company", "secret", {
                  userId: "admin",
                });
      await expect(work).rejects.toMatchObject({ status: 403 });
      expect(f.db.insert).not.toHaveBeenCalled();
      expect(f.db.update).not.toHaveBeenCalled();
      expect(f.db.delete).not.toHaveBeenCalled();
    });
  it("permits only the explicit owner assignment method to create the canonical native binding", async () => {
    const f = fixture(true);
    await expect(
      f.svc.assignOnecliIdentity("company", "secret", { userId: "owner" }),
    ).resolves.toMatchObject({ id: "binding" });
    expect(f.values).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company",
        secretId: "secret",
        targetType: "agent",
        targetId: "agent",
        configPath: ONECLI_IDENTITY_PATH,
        required: true,
        versionSelector: "latest",
      }),
    );
  });
  for (const configPath of [
    ONECLI_IDENTITY_PATH,
    "env.ONECLI_AGENT_TOKEN",
    "env.INNOCENT_ALIAS",
  ])
    it(`refuses generic binding path ${configPath}`, async () => {
      const f = fixture();
      await expect(
        f.svc.createBinding({
          companyId: "company",
          secretId: "secret",
          targetType: "agent",
          targetId: "agent",
          configPath,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.db.insert).not.toHaveBeenCalled();
    });
  it("refuses config-derived reserved writes before deleting existing bindings", async () => {
    const f = fixture();
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        { targetType: "agent", targetId: "agent" },
        [{ secretId: "secret", configPath: "env.INNOCENT_ALIAS" }],
        { replaceAll: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.db.delete).not.toHaveBeenCalled();
  });
  it("refuses raw canonical credential reads outside internal managed worker resolution", async () => {
    const f = fixture();
    await expect(
      f.svc.resolveSecretValue("company", "secret", "latest"),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.select).toHaveBeenCalledOnce();
  });
  it("refuses connection/grant synchronization aliases before destructive binding replacement", async () => {
    const f = fixture();
    await expect(
      syncConnectionCredentialBindings(
        f.db as never,
        {
          id: "connection",
          companyId: "company",
          credentialRefs: [],
          credentialSecretRefs: [
            { secretId: "secret", configPath: "env.INNOCENT_ALIAS" },
          ],
        } as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.delete).not.toHaveBeenCalled();
    expect(f.db.insert).not.toHaveBeenCalled();
  });
  it("refuses agent proposals for reserved paths before loading their run or mutating proposals", async () => {
    const f = fixture();
    await expect(
      createSecretProposalsService(f.db as never).createBinding(
        { companyId: "company", heartbeatRunId: "run" },
        {
          secretId: "secret",
          configPath: ONECLI_IDENTITY_PATH,
          justification: "synthetic",
          bindingTargetPolicy: "self_and_reports",
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.select).not.toHaveBeenCalled();
    expect(f.db.insert).not.toHaveBeenCalled();
  });
  it("refuses agent proposals disguising canonical credentials under an ordinary alias", async () => {
    const f = fixture();
    await expect(
      createSecretProposalsService(f.db as never).createBinding(
        { companyId: "company", heartbeatRunId: "run" },
        {
          secretId: "secret",
          configPath: "env.INNOCENT_ALIAS",
          justification: "synthetic",
          bindingTargetPolicy: "self_and_reports",
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.insert).not.toHaveBeenCalled();
  });
});
