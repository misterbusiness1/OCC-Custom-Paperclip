import { describe, expect, it } from "vitest";
import { updateAgentSchema } from "./agent.js";
import { objectWithoutDefaults } from "./partial.js";
import { z } from "zod";

describe("updateAgentSchema", () => {
  it("keeps the explicit environment-removal field on a parsed update", () => {
    // The agent update route reads `envRemovedKeys` to remove a binding. If the
    // schema does not carry the field, the request body is parsed without it
    // and the removal request becomes a silent no-op: the binding stays, and
    // nothing reports an error.
    const result = updateAgentSchema.parse({
      adapterConfig: { env: {} },
      envRemovedKeys: ["AGENTMAIL_API_KEY"],
    });

    expect(result.envRemovedKeys).toEqual(["AGENTMAIL_API_KEY"]);
  });

  it("drops fields a caller may not edit instead of passing them to the agent write", () => {
    // The update writes every agent column it receives, so the schema is the
    // allow-list. A caller must not move an agent to another company, change
    // its id, or forge its pause, error and heartbeat state.
    const result = updateAgentSchema.parse({
      name: "Renamed",
      companyId: "00000000-0000-4000-8000-000000000001",
      id: "00000000-0000-4000-8000-000000000002",
      pausedAt: "2026-10-21T00:00:00.000Z",
      pauseReason: "forged",
      errorReason: "forged",
      lastHeartbeatAt: "2026-10-21T00:00:00.000Z",
      someFieldTheSchemaDoesNotKnowAbout: "dropped",
    }) as Record<string, unknown>;

    expect(result).toEqual({ name: "Renamed" });
  });

  it("still rejects a malformed removal list", () => {
    const result = updateAgentSchema.safeParse({ envRemovedKeys: [""] });
    expect(result.success).toBe(false);
  });
});

describe("objectWithoutDefaults", () => {
  it("carries the source schema's catchall over to the rebuilt schema", () => {
    const base = z.object({ known: z.string().default("x") }).catchall(z.unknown());
    const rebuilt = objectWithoutDefaults(base);

    const parsed = rebuilt.parse({ known: "y", extra: 1 });
    expect(parsed).toMatchObject({ known: "y", extra: 1 });
  });

  it("still drops the top-level defaults it exists to drop", () => {
    const base = z.object({ known: z.string().default("x") });
    const rebuilt = objectWithoutDefaults(base).partial();

    expect(rebuilt.parse({})).toEqual({});
  });
});
