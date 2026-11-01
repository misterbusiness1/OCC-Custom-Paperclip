import { describe, it, expect } from "vitest";
import plugin from "../../src/plugin.js";

describe("plugin", () => {
  it("exports the kubernetes driver", () => {
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentValidateConfig).toBeTypeOf("function");
  });

  it("validateConfig accepts inCluster=true config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true },
    });
    expect(result.ok).toBe(true);
  });

  it("validateConfig rejects missing auth", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/requires one of `inCluster`/);
  });

  it("validateConfig normalizes defaults", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toEqual(
      expect.objectContaining({
        namespacePrefix: "paperclip-",
        egressMode: "standard",
        jobTtlSecondsAfterFinished: 900,
        podActivityDeadlineSec: 3600,
        adapterType: "claude_local",
        backend: "sandbox-cr", // new default
      }),
    );
  });

  it("validateConfig accepts backend=sandbox-cr explicitly", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "sandbox-cr" },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig?.backend).toBe("sandbox-cr");
  });

  it("validateConfig accepts backend=job (stable fallback)", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "job" },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig?.backend).toBe("job");
  });

  it("validateConfig rejects unknown backend value", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "kata-fc" },
    });
    expect(result.ok).toBe(false);
  });

  it("onHealth returns ok", async () => {
    const result = await plugin.definition.onHealth!();
    expect(result.status).toBe("ok");
  });

  it("validateConfig warns about FQDN limitation in standard mode", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, adapterType: "claude_local" },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("api.anthropic.com"))).toBe(true);
  });

  it("validateConfig rejects cursor without an adapters registry entry, with an actionable error", async () => {
    for (const adapterType of ["cursor", "cursor_local"]) {
      const result = await plugin.definition.onEnvironmentValidateConfig!({
        driverKey: "kubernetes",
        config: { inCluster: true, adapterType },
      });
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]).toMatch(
        /Cursor has no built-in Kubernetes runtime image; add an adapters registry entry for "cursor"/,
      );
      expect(result.errors?.[0]).toMatch(/CURSOR_API_KEY/);
    }
  });

  it("validateConfig accepts legacy cursor_local with a registry entry keyed \"cursor\" and normalises it", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "cursor_local",
        adapters: [
          {
            adapterType: "cursor",
            runtimeImage: "registry.example/cursor:v1",
            envKeys: ["CURSOR_API_KEY"],
            allowFqdns: ["api2.cursor.sh"],
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig?.adapterType).toBe("cursor");
    expect(result.warnings?.some((w) => w.includes("api2.cursor.sh"))).toBe(true);
  });

  it("validateConfig rejects duplicate cursor / cursor_local registry entries", async () => {
    const entry = { adapterType: "cursor", runtimeImage: "registry.example/cursor:v1" };
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "cursor",
        adapters: [entry, { ...entry, adapterType: "cursor_local" }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/Adapter "cursor" has 2 entries .*keep exactly one/);
  });

  it("validateConfig rejects duplicate entries for an adapter other than the environment default", async () => {
    const cursor = { adapterType: "cursor", runtimeImage: "registry.example/cursor:v1" };
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "claude_local",
        egressMode: "cilium",
        adapters: [
          { adapterType: "claude_local", runtimeImage: "registry.example/claude:v1" },
          cursor,
          { ...cursor, adapterType: "cursor_local" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'Adapter "cursor" has 2 entries in the configured adapter registry ("cursor", "cursor_local"); keep exactly one',
    ]);
  });

  it("validateConfig reports a duplicate default adapter once", async () => {
    const entry = { adapterType: "cursor", runtimeImage: "registry.example/cursor:v1" };
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "cursor",
        adapters: [entry, { ...entry, adapterType: "cursor_local" }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("validateConfig warns about a non-default registry entry without runtimeImage", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "claude_local",
        egressMode: "cilium",
        adapters: [
          { adapterType: "claude_local", runtimeImage: "registry.example/claude:v1" },
          { adapterType: "cursor", envKeys: ["CURSOR_API_KEY"] },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      'Adapter "cursor" has no runtimeImage in the configured adapter registry; runs of it in this environment will be refused',
    ]);
  });

  it("validateConfig rejects an environment whose default adapter entry is disabled", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "cursor",
        adapters: [
          { adapterType: "cursor", enabled: false, runtimeImage: "registry.example/cursor:v1" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['Adapter "cursor" is disabled in the configured adapter registry']);
  });

  it("validateConfig does NOT warn when egressMode is cilium", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, adapterType: "claude_local", egressMode: "cilium" },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
