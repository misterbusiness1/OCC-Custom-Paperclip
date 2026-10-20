import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProviderCooldownKey, declaredCodexProviderAccountKey, resolveProviderCooldownSecretVersions } from "../services/provider-cooldown-scope.js";

const base = {
  adapterType: "codex_local",
  adapterConfig: {},
  aiConnection: null,
  responsibleUserId: "user-a",
  environment: null,
  projectEnv: {},
  routineEnv: {},
};

describe("provider cooldown scope", () => {
  it.each(["codex_local", "claude_local"])("distinguishes scoped account changes for %s", (adapterType) => {
    for (const scope of ["projectEnv", "routineEnv"] as const) {
      const before = createProviderCooldownKey({ ...base, adapterType, [scope]: { OPENAI_API_KEY: "synthetic-account-a" } });
      const after = createProviderCooldownKey({ ...base, adapterType, [scope]: { OPENAI_API_KEY: "synthetic-account-b" } });
      expect(after).not.toBe(before);
      expect(after).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    }
  });

  it("recognizes latest secret rotations while ignoring unrelated runtime secret metadata", () => {
    const input = { ...base, projectEnv: { OPENAI_API_KEY: { type: "secret_ref", secretId: "provider-secret", version: "latest" } } };
    const before = createProviderCooldownKey({ ...input, secretVersions: [{ secretId: "provider-secret", version: 1 }] });
    const rotated = createProviderCooldownKey({ ...input, secretVersions: [{ secretId: "provider-secret", version: 2 }] });
    expect(rotated).not.toBe(before);
    expect(createProviderCooldownKey({ ...input, secretVersions: [
      { secretId: "unrelated-runtime-secret", version: 9 },
      { secretId: "provider-secret", version: 2 },
      { secretId: "provider-secret", version: 2 },
    ] })).toBe(rotated);
  });

  it("keeps user-secret versions associated with declared env bindings", () => {
    const input = { ...base, adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "user_secret_ref", key: "anthropic-account" } } } };
    const before = createProviderCooldownKey({ ...input, secretVersions: [{ secretId: "user-secret", version: 1, envKey: "ANTHROPIC_API_KEY" }] });
    const after = createProviderCooldownKey({ ...input, secretVersions: [{ secretId: "user-secret", version: 2, envKey: "ANTHROPIC_API_KEY" }] });
    expect(after).not.toBe(before);
    expect(createProviderCooldownKey({ ...input, secretVersions: [
      { secretId: "user-secret", version: 2, envKey: "ANTHROPIC_API_KEY" },
      { secretId: "unrelated", version: 3, envKey: "OTHER_ENV" },
    ] })).toBe(after);
  });

  it("retains a managed account's wait across token refresh and recognizes explicit account changes", () => {
    const metadata = { attribution: { connectionId: "connection-a", grantId: "grant-a" }, accountGeneration: "generation-a", credential: { secretId: "secret-a", version: 1 } };
    const before = createProviderCooldownKey({ ...base, credentialMetadata: metadata });
    expect(createProviderCooldownKey({ ...base, credentialMetadata: { ...metadata, credential: { ...metadata.credential, version: 2 } } })).toBe(before);
    expect(createProviderCooldownKey({ ...base, credentialMetadata: { ...metadata, accountGeneration: "generation-b" } })).not.toBe(before);
    expect(createProviderCooldownKey({ ...base, credentialMetadata: { ...metadata, attribution: { connectionId: "connection-b", grantId: "grant-b" } } })).not.toBe(before);
  });

  it("uses the exact consumer scope when resolving a company secret version", async () => {
    const secrets = {
      collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue({ id: "secret-a", companyId: "company-a", scope: "company" }),
      resolveSecretVersion: vi.fn().mockResolvedValue(3),
      listCurrentUserSecretValues: vi.fn(),
    };
    const result = await resolveProviderCooldownSecretVersions(secrets as never, "company-a", [{
      consumerType: "project", consumerId: "project-a", responsibleUserId: "user-a",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" } },
    }]);
    expect(result).toEqual([{ secretId: "11111111-1111-4111-8111-111111111111", version: 3, envKey: "OPENAI_API_KEY" }]);
    expect(secrets.resolveSecretVersion).toHaveBeenCalledWith("company-a", "11111111-1111-4111-8111-111111111111", "latest", {
      consumerType: "project", consumerId: "project-a", responsibleUserId: "user-a", configPath: "env.OPENAI_API_KEY",
    });
  });

  it("rejects cross-company metadata before resolving a secret version", async () => {
    const secrets = {
      collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue({ companyId: "other-company", scope: "company" }),
      resolveSecretVersion: vi.fn(),
      listCurrentUserSecretValues: vi.fn(),
    };
    await expect(resolveProviderCooldownSecretVersions(secrets as never, "company-a", [{
      consumerType: "agent", consumerId: "agent-a",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" } },
    }])).rejects.toThrow("must belong to this company");
    expect(secrets.resolveSecretVersion).not.toHaveBeenCalled();
  });

  it("selects user-secret metadata for the responsible user after checking declarations", async () => {
    const secrets = {
      collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      resolveSecretVersion: vi.fn().mockResolvedValue(4),
      listCurrentUserSecretValues: vi.fn().mockResolvedValue([{
        definition: { key: "anthropic-account" },
        secret: { id: "user-secret", companyId: "company-a", ownerUserId: "user-a", scope: "user" },
      }]),
    };
    expect(await resolveProviderCooldownSecretVersions(secrets as never, "company-a", [{
      consumerType: "agent", consumerId: "agent-a", responsibleUserId: "user-a",
      env: { ANTHROPIC_API_KEY: { type: "user_secret_ref", key: "anthropic-account" } },
    }])).toEqual([{ secretId: "user-secret", version: 4, envKey: "ANTHROPIC_API_KEY" }]);
    expect(secrets.listCurrentUserSecretValues).toHaveBeenCalledWith("company-a", "user-a");
    expect(secrets.collectMissingRuntimeBindings).toHaveBeenCalledWith("company-a", expect.any(Object), {
      consumerType: "agent", consumerId: "agent-a", responsibleUserId: "user-a",
    });
    expect(secrets.resolveSecretVersion).toHaveBeenCalledWith("company-a", "user-secret", "latest");
  });

  it.each([{ required: false }, { allowMissingOverride: true }])("omits optional absent user refs while retaining valid quota scope (%j)", async (optional) => {
    const providerSecretId = "11111111-1111-4111-8111-111111111111";
    const secrets = {
      collectMissingRuntimeBindings: vi.fn().mockImplementation(async (_companyId, env) =>
        env.OPTIONAL_KEY.required === true && env.OPTIONAL_KEY.allowMissingOverride === false
          ? [{ envKey: "OPTIONAL_KEY", errorCode: "user_secret_missing" }]
          : []),
      getById: vi.fn().mockResolvedValue({ companyId: "company-a", scope: "company" }),
      resolveSecretVersion: vi.fn().mockResolvedValue(2),
      listCurrentUserSecretValues: vi.fn(),
    };
    const env = {
      OPENAI_API_KEY: { type: "secret_ref", secretId: providerSecretId },
      OPTIONAL_KEY: { type: "user_secret_ref", key: "optional-account", ...optional },
    };
    const original = structuredClone(env);
    expect(await resolveProviderCooldownSecretVersions(secrets as never, "company-a", [{
      consumerType: "agent", consumerId: "agent-a", responsibleUserId: "user-a",
      env,
    }])).toEqual([{ secretId: providerSecretId, version: 2, envKey: "OPENAI_API_KEY" }]);
    expect(secrets.collectMissingRuntimeBindings).toHaveBeenCalledWith("company-a", {
      ...env,
      OPTIONAL_KEY: { ...env.OPTIONAL_KEY, required: true, allowMissingOverride: false },
    }, { consumerType: "agent", consumerId: "agent-a", responsibleUserId: "user-a" });
    expect(env).toEqual(original);
    expect(secrets.collectMissingRuntimeBindings.mock.calls[0][1]).not.toBe(env);
    expect(secrets.collectMissingRuntimeBindings.mock.calls[0][1].OPTIONAL_KEY).not.toBe(env.OPTIONAL_KEY);
    expect(secrets.listCurrentUserSecretValues).not.toHaveBeenCalled();
  });

  it("does not suppress revocation for an optional user ref", async () => {
    const secrets = {
      collectMissingRuntimeBindings: vi.fn().mockResolvedValue([{ envKey: "OPTIONAL_KEY", errorCode: "secret_inactive" }]),
      getById: vi.fn(), resolveSecretVersion: vi.fn(), listCurrentUserSecretValues: vi.fn(),
    };
    await expect(resolveProviderCooldownSecretVersions(secrets as never, "company-a", [{
      consumerType: "agent", consumerId: "agent-a", responsibleUserId: "user-a",
      env: { OPTIONAL_KEY: { type: "user_secret_ref", key: "optional-account", required: false } },
    }])).rejects.toThrow("metadata is unavailable");
    expect(secrets.resolveSecretVersion).not.toHaveBeenCalled();
  });
});

it("keeps declared CODEX_API_KEY secret routes unknown before credential resolution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-declared-account-"));
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("CODEX_API_KEY", "");
  try {
    await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ tokens: {
      account_id: "synthetic-subscription", access_token: "synthetic-token",
    } }), { mode: 0o600 });
    const input = {
      companyId: "company", adapterType: "codex_local", adapterConfig: { env: { CODEX_HOME: root } },
      environmentDriver: "local", environmentEnv: {}, projectEnv: {}, routineEnv: {}, managed: false,
    };
    expect(await declaredCodexProviderAccountKey(input)).toMatch(/^[a-f0-9]{64}$/);
    for (const scope of ["environmentEnv", "projectEnv", "routineEnv"] as const) {
      expect(await declaredCodexProviderAccountKey({ ...input, [scope]: {
        CODEX_API_KEY: { type: "secret_ref", secretId: "synthetic-api-secret", version: "latest" },
      } })).toBeNull();
    }
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
