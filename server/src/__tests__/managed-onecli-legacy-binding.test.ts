import { describe, expect, it, vi } from "vitest";
import { companySecretBindings, companySecrets } from "@paperclipai/db";
import { secretService } from "../services/secrets.js";
import { ONECLI_IDENTITY_PATH } from "../services/managed-onecli-identity.js";

vi.mock("../adapters/index.js", () => ({ findActiveServerAdapter: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  assertAccountHomeCacheDirStillValid: vi.fn(async () => {}),
  withAccountHomeSecretMutationLock: vi.fn(async (_root, _company, action) => action()),
}));

// A legacy agent config carries env.ONECLI_SECRET_API as an ordinary secret_ref that
// predates the managed identity path. Ordinary saves re-send it unchanged.
type Held = { secretId: string; configPath: string; versionSelector?: string; required?: boolean; projectionClass?: string; projectionAllowlistKey?: string | null };
function fixture(held: Held[]) {
  const existing = held.map((row) => ({
    versionSelector: "latest",
    required: true,
    projectionClass: "unclassified",
    projectionAllowlistKey: null,
    ...row,
  }));
  const plainSecret = {
    id: "legacy-secret",
    companyId: "company",
    scope: "company",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
  };
  const otherSecret = { ...plainSecret, id: "other-secret" };
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () =>
        Promise.resolve(
          table === companySecretBindings
            ? existing
            : table === companySecrets
              ? [plainSecret, otherSecret]
              : [],
        ),
    }),
  }));
  const transaction = vi.fn(async () => undefined);
  const db = { select, insert: vi.fn(), delete: vi.fn(), update: vi.fn(), transaction };
  return { svc: secretService(db as never), db };
}

const target = { targetType: "agent" as const, targetId: "agent" };

describe("legacy OneCLI env bindings on ordinary config saves", () => {
  it("accepts an unchanged binding the agent already holds", async () => {
    const f = fixture([{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API" }]);
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        target,
        [{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API" }],
        { replaceAll: true },
      ),
    ).resolves.not.toThrow();
    expect(f.db.transaction).toHaveBeenCalledOnce();
  });

  it("refuses pointing a held reserved path at a different secret", async () => {
    const f = fixture([{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API" }]);
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        target,
        [{ secretId: "other-secret", configPath: "env.ONECLI_SECRET_API" }],
        { replaceAll: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a reserved path the agent does not already hold", async () => {
    const f = fixture([{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API" }]);
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        target,
        [{ secretId: "legacy-secret", configPath: "env.ONECLI_AGENT_TOKEN" }],
        { replaceAll: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a reserved path when nothing is held", async () => {
    const f = fixture([]);
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        target,
        [{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API" }],
        { replaceAll: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a held reserved path when the version selector changes", async () => {
    const f = fixture([{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API" }]);
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        target,
        [{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API", versionSelector: 3 as never }],
        { replaceAll: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a held reserved path when the projection class changes", async () => {
    const f = fixture([{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API" }]);
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        target,
        [{ secretId: "legacy-secret", configPath: "env.ONECLI_SECRET_API", projectionClass: "class3" as never }],
        { replaceAll: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("never grandfathers the canonical identity path, even when held", async () => {
    const f = fixture([{ secretId: "legacy-secret", configPath: ONECLI_IDENTITY_PATH }]);
    await expect(
      f.svc.syncSecretRefsForTarget(
        "company",
        target,
        [{ secretId: "legacy-secret", configPath: ONECLI_IDENTITY_PATH }],
        { replaceAll: true },
      ),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("company owner assignment path") });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });
});
