import { describe, expect, it } from "vitest";
import type { AdapterConfigSchema, ConfigFieldSchema, CreateConfigValues } from "@paperclipai/adapter-utils";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { buildSchemaAdapterConfig, fieldMatchesVisibleWhen } from "./schema-config-fields";

const sourceField: ConfigFieldSchema = {
  key: "provider",
  label: "Provider",
  type: "select",
  options: [
    { label: "Claude", value: "claude" },
    { label: "Codex", value: "codex" },
  ],
};

const schema: AdapterConfigSchema = {
  fields: [sourceField],
};

function targetWithVisibleWhen(visibleWhen: Record<string, unknown>): ConfigFieldSchema {
  return {
    key: "model",
    label: "Model",
    type: "text",
    meta: { visibleWhen },
  };
}

describe("fieldMatchesVisibleWhen", () => {
  it("treats an empty values array as no match", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: [] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(false);
  });

  it("treats all non-string values as no match", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: [null, 42] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(false);
  });

  it("matches non-empty string values", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: ["claude"] });

    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(true);
    expect(fieldMatchesVisibleWhen(field, () => "codex", schema)).toBe(false);
  });
});

describe("buildSchemaAdapterConfig env bindings", () => {
  function values(overrides: Partial<CreateConfigValues>): CreateConfigValues {
    return { ...defaultCreateValues, adapterType: "minimax_local", ...overrides };
  }

  it("persists plain values and company secret references into adapterConfig.env", () => {
    const config = buildSchemaAdapterConfig(values({
      envBindings: {
        MINIMAX_API_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
        PINNED: { type: "secret_ref", secretId: "secret-2", version: 3 },
        LOG_LEVEL: { type: "plain", value: "debug" },
        LEGACY_STRING: "plain-string",
      },
      adapterSchemaValues: { toolsEnabled: true },
    }));

    expect(config.env).toEqual({
      MINIMAX_API_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      PINNED: { type: "secret_ref", secretId: "secret-2", version: 3 },
      LOG_LEVEL: { type: "plain", value: "debug" },
      LEGACY_STRING: { type: "plain", value: "plain-string" },
    });
    expect(config.toolsEnabled).toBe(true);
  });

  it("drops redacted placeholders, invalid keys and malformed bindings", () => {
    const config = buildSchemaAdapterConfig(values({
      envBindings: {
        REDACTED_PLAIN: { type: "plain", value: "***REDACTED***" },
        REDACTED_STRING: "***REDACTED***",
        "bad-key": { type: "plain", value: "x" },
        NO_SECRET_ID: { type: "secret_ref" },
        NUMBER: 5,
        KEEP: { type: "secret_ref", secretId: "secret-3", version: "bogus" },
      },
    }));

    expect(config.env).toEqual({ KEEP: { type: "secret_ref", secretId: "secret-3" } });
  });

  it("omits env entirely when there are no bindings", () => {
    expect(buildSchemaAdapterConfig(values({ envBindings: {} }))).not.toHaveProperty("env");
  });
});
