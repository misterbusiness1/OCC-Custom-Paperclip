import { describe, expect, it, vi } from "vitest";
import { companySecretBindings, companySecrets } from "@paperclipai/db";
import { secretService } from "../services/secrets.js";

vi.mock("../adapters/index.js", () => ({ findActiveServerAdapter: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  assertAccountHomeCacheDirStillValid: vi.fn(async () => {}),
  withAccountHomeSecretMutationLock: vi.fn(async (_root, _company, action) => action()),
}));

// A legacy agent config carries env.ONECLI_SECRET_API as an ordinary secret_ref that
// predates the managed identity path. Ordinary saves re-send it unchanged.
function fixture(existing: Array<{ secretId: string; configPath: string }>) {
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
});
