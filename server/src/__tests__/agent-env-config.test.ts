import { describe, expect, it } from "vitest";
import {
  assertValidEnvRemovalRequest,
  envBindingKind,
  findSilentSecretBindingRemovals,
  isFixedClaudeOAuthEnvBinding,
  mergeAgentEnvBindings,
  withoutAgentEnvPatch,
} from "../services/agent-env-config.js";

describe("mergeAgentEnvBindings", () => {
  it("keeps a stored binding the request does not mention", () => {
    const result = mergeAgentEnvBindings({
      existingEnv: {
        PLAIN_KEY: { type: "plain", value: "plain-value" },
        SECRET_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      requestedEnv: {
        PLAIN_KEY: { type: "plain", value: "plain-value" },
      },
    });

    expect(result.env).toEqual({
      PLAIN_KEY: { type: "plain", value: "plain-value" },
      SECRET_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
    });
    expect(result.preservedKeys).toEqual(["SECRET_KEY"]);
    expect(result.addedKeys).toEqual([]);
    expect(result.updatedKeys).toEqual([]);
    expect(result.removedKeys).toEqual([]);
  });

  it("keeps every stored binding when the request carries no env map", () => {
    const result = mergeAgentEnvBindings({
      existingEnv: {
        PLAIN_KEY: { type: "plain", value: "plain-value" },
      },
      requestedEnv: null,
    });

    expect(result.env).toEqual({
      PLAIN_KEY: { type: "plain", value: "plain-value" },
    });
    expect(result.preservedKeys).toEqual(["PLAIN_KEY"]);
  });

  it("applies an explicit removal and reports it", () => {
    const result = mergeAgentEnvBindings({
      existingEnv: {
        PLAIN_KEY: { type: "plain", value: "plain-value" },
        SECRET_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      requestedEnv: {
        PLAIN_KEY: { type: "plain", value: "plain-value" },
      },
      removedKeys: ["SECRET_KEY"],
    });

    expect(result.env).toEqual({
      PLAIN_KEY: { type: "plain", value: "plain-value" },
    });
    expect(result.removedKeys).toEqual(["SECRET_KEY"]);
  });

  it("reports added and updated keys", () => {
    const result = mergeAgentEnvBindings({
      existingEnv: {
        PLAIN_KEY: { type: "plain", value: "plain-value" },
      },
      requestedEnv: {
        PLAIN_KEY: { type: "plain", value: "new-value" },
        NEW_KEY: { type: "plain", value: "new" },
      },
    });

    expect(result.addedKeys).toEqual(["NEW_KEY"]);
    expect(result.updatedKeys).toEqual(["PLAIN_KEY"]);
  });
});

describe("findSilentSecretBindingRemovals", () => {
  it("reports a secret binding that disappears without an explicit removal", () => {
    expect(
      findSilentSecretBindingRemovals({
        existingEnv: {
          PLAIN_KEY: { type: "plain", value: "plain-value" },
          SECRET_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
        },
        nextEnv: {
          PLAIN_KEY: { type: "plain", value: "plain-value" },
        },
      }),
    ).toEqual(["SECRET_KEY"]);
  });

  it("accepts a removal the caller authorized", () => {
    expect(
      findSilentSecretBindingRemovals({
        existingEnv: {
          SECRET_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
        },
        nextEnv: {},
        authorizedRemovals: ["SECRET_KEY"],
      }),
    ).toEqual([]);
  });

  it("does not report a dropped plain binding", () => {
    expect(
      findSilentSecretBindingRemovals({
        existingEnv: {
          PLAIN_KEY: { type: "plain", value: "plain-value" },
        },
        nextEnv: {},
      }),
    ).toEqual([]);
  });
});

describe("assertValidEnvRemovalRequest", () => {
  const errors = {
    invalidNameError: (key: string) => new Error(`invalid name: ${key}`),
    unknownKeyError: (key: string) => new Error(`unknown key: ${key}`),
    conflictingKeyError: (key: string) => new Error(`conflicting key: ${key}`),
  };

  it("accepts a removal of a stored binding", () => {
    expect(
      assertValidEnvRemovalRequest({
        existingEnv: { SECRET_KEY: { type: "plain", value: "v" } },
        requestedEnv: {},
        removedKeys: ["SECRET_KEY"],
        ...errors,
      }),
    ).toEqual(["SECRET_KEY"]);
  });

  it("rejects an invalid env name", () => {
    expect(() =>
      assertValidEnvRemovalRequest({
        existingEnv: { SECRET_KEY: { type: "plain", value: "v" } },
        requestedEnv: {},
        removedKeys: ["not a name"],
        ...errors,
      }),
    ).toThrow(/invalid name/);
  });

  it("rejects a key that is not bound", () => {
    expect(() =>
      assertValidEnvRemovalRequest({
        existingEnv: { SECRET_KEY: { type: "plain", value: "v" } },
        requestedEnv: {},
        removedKeys: ["OTHER_KEY"],
        ...errors,
      }),
    ).toThrow(/unknown key/);
  });

  it("rejects a key that the same request also sets", () => {
    expect(() =>
      assertValidEnvRemovalRequest({
        existingEnv: { SECRET_KEY: { type: "plain", value: "v" } },
        requestedEnv: { SECRET_KEY: { type: "plain", value: "v" } },
        removedKeys: ["SECRET_KEY"],
        ...errors,
      }),
    ).toThrow(/conflicting key/);
  });
});

describe("envBindingKind", () => {
  it("classifies a binding without reading its value", () => {
    expect(envBindingKind({ type: "plain", value: "v" })).toBe("plain");
    expect(envBindingKind({ type: "secret_ref", secretId: "s" })).toBe("secret_ref");
    expect(envBindingKind({ type: "user_secret_ref", key: "k" })).toBe("user_secret_ref");
    expect(envBindingKind("v")).toBe("plain");
    expect(envBindingKind({})).toBe("unknown");
  });
});

describe("isFixedClaudeOAuthEnvBinding", () => {
  it("matches only the fixed user-secret reference", () => {
    expect(isFixedClaudeOAuthEnvBinding({ type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" })).toBe(true);
    expect(isFixedClaudeOAuthEnvBinding({ type: "user_secret_ref", key: "OTHER" })).toBe(false);
    expect(isFixedClaudeOAuthEnvBinding({ type: "plain", value: "v" })).toBe(false);
    expect(isFixedClaudeOAuthEnvBinding(undefined)).toBe(false);
  });
});

describe("withoutAgentEnvPatch", () => {
  it("omits copied environment intent without mutating the source or other fields", () => {
    const env = { KEEP: { type: "secret_ref", secretId: "synthetic" } };
    const original = Object.freeze({ env, model: "model", promptTemplate: undefined });
    const patch = withoutAgentEnvPatch(original);
    expect(patch).toEqual({ model: "model", promptTemplate: undefined });
    expect(Object.hasOwn(patch, "env")).toBe(false);
    expect(original.env).toBe(env);
    expect(patch).not.toBe(original);
  });
});
