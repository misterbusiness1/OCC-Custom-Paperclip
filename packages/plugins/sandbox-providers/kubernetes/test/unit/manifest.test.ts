import { describe, it, expect } from "vitest";
import manifest from "../../src/manifest.js";
import { adapterRegistryEntrySchema } from "../../src/adapter-registry.js";

type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
};

function kubernetesConfigSchema(): SchemaNode {
  const driver = manifest.environmentDrivers?.find((d) => d.driverKey === "kubernetes");
  expect(driver).toBeDefined();
  return driver!.configSchema as SchemaNode;
}

describe("manifest configSchema", () => {
  // The UI renders only declared properties, and `cursor` needs an `adapters`
  // entry, so the registry must be editable from the environment form.
  it("declares the adapters registry with every adapterRegistryEntrySchema field", () => {
    const adapters = kubernetesConfigSchema().properties?.adapters;
    expect(adapters?.type).toBe("array");
    expect(adapters?.items?.type).toBe("object");
    expect(Object.keys(adapters?.items?.properties ?? {}).sort()).toEqual(
      Object.keys(adapterRegistryEntrySchema.shape).sort(),
    );
    expect(adapters?.items?.required).toEqual(["adapterType"]);
  });
});
