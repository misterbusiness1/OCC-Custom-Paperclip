import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINIMAX_LOCAL_MAX_TOOL_ITERATIONS,
  DEFAULT_MINIMAX_LOCAL_MODEL,
  DEFAULT_MINIMAX_LOCAL_TOOLS_ENABLED,
  models,
} from "../constants.js";
import { createServerAdapter, getConfigSchema } from "../index.js";

describe("minimax_local config schema", () => {
  it("exposes the documented fields in order", () => {
    expect(getConfigSchema().fields.map((f) => f.key)).toEqual([
      "model",
      "baseUrl",
      "temperature",
      "max_completion_tokens",
      "stripThink",
      "toolsEnabled",
      "maxToolIterations",
      "toolCommandTimeoutSec",
      "timeoutSec",
      "instructionsFilePath",
    ]);
  });

  it("offers the known MiniMax models with MiniMax-M3 as default", () => {
    const model = getConfigSchema().fields.find((f) => f.key === "model")!;
    expect(model.type).toBe("select");
    expect(model.default).toBe(DEFAULT_MINIMAX_LOCAL_MODEL);
    expect(model.options?.map((o) => o.value)).toEqual(models.map((m) => m.id));
  });

  it("defaults tools off and the iteration cap to 25", () => {
    const fields = getConfigSchema().fields;
    expect(DEFAULT_MINIMAX_LOCAL_TOOLS_ENABLED).toBe(false);
    expect(DEFAULT_MINIMAX_LOCAL_MAX_TOOL_ITERATIONS).toBe(25);
    expect(fields.find((f) => f.key === "toolsEnabled")).toMatchObject({ type: "toggle", default: false });
    expect(fields.find((f) => f.key === "maxToolIterations")).toMatchObject({ type: "number", default: 25 });
  });

  it("does not expose the API key as a schema field (it is an env/secret binding)", () => {
    const keys = getConfigSchema().fields.map((f) => f.key.toLowerCase());
    expect(keys.some((k) => k.includes("key"))).toBe(false);
  });
});

describe("createServerAdapter", () => {
  it("returns a stateless minimax_local module that opts into the local agent JWT", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("minimax_local");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(adapter.getConfigSchema).toBe(getConfigSchema);
    expect(adapter.models).toEqual(models);
    expect(adapter.agentConfigurationDoc).toContain("toolsEnabled (boolean, optional): defaults to false");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
    expect(adapter.sessionCodec).toBeUndefined();
  });
});
