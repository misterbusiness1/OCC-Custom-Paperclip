import { describe, expect, it } from "vitest";
import manifest from "../../../packages/plugins/plugin-typesafe-skill-suggestion/src/manifest.js";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

const secretId = "77777777-7777-4777-8777-777777777777";
const binding = { type: "secret_ref", secretId, version: 2 };
const field = { type: "string", format: "secret-ref" };

describe("plugin managed secret configuration validation", () => {
  it("accepts the actual TypeSafe manifest without changing the binding or manifest", () => {
    const config = { enabled: true, activeEnabled: true, apiKeyRef: binding };
    const before = structuredClone({ config, manifest });
    expect(validateInstanceConfig(config, manifest.instanceConfigSchema!)).toEqual({ valid: true });
    expect({ config, manifest }).toEqual(before);
  });

  it.each([
    "plaintext-credential", secretId, { type: "plain", value: "credential" },
    { type: "secret_ref", secretId: "typesafe-test" },
    { type: "secret_ref", secretId, version: 0 },
    { type: "secret_ref", secretId, version: 1.5 },
    { type: "secret_ref", secretId, version: "2" },
    { type: "secret_ref", secretId, value: "credential" },
    null, [],
  ])("rejects malformed or legacy binding %j", (apiKeyRef) => {
    const result = validateInstanceConfig({ apiKeyRef }, manifest.instanceConfigSchema!);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("preserves surrounding additionalProperties and ordinary scalar validation", () => {
    expect(validateInstanceConfig({ apiKeyRef: binding, unexpected: true }, manifest.instanceConfigSchema!).valid).toBe(false);
    expect(validateInstanceConfig({ apiKeyRef: binding, timeoutMs: "5000" }, manifest.instanceConfigSchema!).valid).toBe(false);
    expect(validateInstanceConfig({ apiKeyRef: binding, timeoutMs: 999 }, manifest.instanceConfigSchema!).valid).toBe(false);
  });

  it("handles nested objects, arrays, references and combinators without changing literal data", () => {
    const schema = {
      type: "object", additionalProperties: false, required: ["connections"],
      definitions: { credential: field },
      properties: {
        connections: { type: "array", minItems: 1, items: {
          type: "object", additionalProperties: false, required: ["token", "name"],
          properties: { token: { $ref: "#/definitions/credential" }, name: { type: "string", minLength: 2 } },
        } },
        literal: { const: { type: "string", format: "secret-ref" } },
      },
      allOf: [{ properties: { connections: { maxItems: 2, type: "array" } } }],
    };
    const value = { connections: [{ token: binding, name: "ok" }], literal: field };
    expect(validateInstanceConfig(value, schema).valid).toBe(true);
    expect(validateInstanceConfig({ ...value, connections: [{ token: secretId, name: "ok" }] }, schema).valid).toBe(false);
    expect(validateInstanceConfig({ ...value, connections: [{ token: binding, name: "x" }] }, schema).valid).toBe(false);
    expect(validateInstanceConfig({ ...value, connections: [{ token: binding, name: "ok", extra: true }] }, schema).valid).toBe(false);
    expect(validateInstanceConfig({ ...value, connections: [] }, schema).valid).toBe(false);
  });

  it("retains constraints on secret-field schemas and supports latest version", () => {
    const schema = { type: "object", properties: { token: { ...field, minLength: 1, enum: [binding] } } };
    expect(validateInstanceConfig({ token: binding }, schema).valid).toBe(true);
    expect(validateInstanceConfig({ token: { ...binding, version: 3 } }, schema).valid).toBe(false);
    expect(validateInstanceConfig({ apiKeyRef: { ...binding, version: "latest" } }, manifest.instanceConfigSchema!).valid).toBe(true);
  });
});
