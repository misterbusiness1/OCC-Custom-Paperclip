import { describe, expect, it, vi } from "vitest";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "../adapters/index.js";

// Production registers an external adapter plugin whose type is `kimi_local`
// (adapter-plugins.json). Upstream v2026.831 added a built-in adapter with the
// same type (233c12f02). This pins how the init-time external load pass
// resolves the clash: the external plugin wins, and the built-in stays as a
// fallback that is only served while the override is paused.

const kimiPluginExecute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));

const kimiPlugin: ServerAdapterModule = {
  type: "kimi_local",
  execute: kimiPluginExecute,
  testEnvironment: async () => ({
    adapterType: "kimi_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  models: [{ id: "kimi-plugin-model", label: "Kimi Plugin Model" }],
  supportsLocalAgentJwt: true,
};

vi.mock("../adapters/plugin-loader.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildExternalAdapters: vi.fn(async () => [kimiPlugin]) };
});

const {
  findActiveServerAdapter,
  isOverridePaused,
  listServerAdapters,
  setOverridePaused,
  waitForExternalAdapters,
} = await import("../adapters/registry.js");
const { BUILTIN_ADAPTER_TYPES } = await import("../adapters/builtin-adapter-types.js");

describe("kimi_local external plugin vs built-in adapter", () => {
  it("serves the external plugin over the built-in after the load pass", async () => {
    await waitForExternalAdapters();
    expect(BUILTIN_ADAPTER_TYPES.has("kimi_local")).toBe(true);

    const active = findActiveServerAdapter("kimi_local");
    expect(active?.execute).toBe(kimiPluginExecute);
    expect(active?.models).toEqual(kimiPlugin.models);
    // The plugin declares no sessionManagement, so it inherits the built-in
    // kimi_local policy by type.
    expect(active?.sessionManagement).toEqual(getAdapterSessionManagement("kimi_local") ?? undefined);
    // Only one registration per type is listed.
    expect(listServerAdapters().filter((adapter) => adapter.type === "kimi_local")).toHaveLength(1);
  });

  it("falls back to the built-in only while the override is paused", async () => {
    await waitForExternalAdapters();
    expect(isOverridePaused("kimi_local")).toBe(false);

    expect(setOverridePaused("kimi_local", true)).toBe(true);
    const builtin = findActiveServerAdapter("kimi_local");
    expect(builtin).not.toBeNull();
    expect(builtin?.execute).not.toBe(kimiPluginExecute);
    expect(builtin?.type).toBe("kimi_local");

    expect(setOverridePaused("kimi_local", false)).toBe(true);
    expect(findActiveServerAdapter("kimi_local")?.execute).toBe(kimiPluginExecute);
  });
});
