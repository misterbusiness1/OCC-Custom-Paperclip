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

  it("does not strip an unknown top-level field before the route sees it", () => {
    // The update schema is rebuilt through `objectWithoutDefaults`, which used
    // to build a fresh object without the base schema's catchall. Every
    // unknown top-level field was then dropped by the parse, so a new field a
    // caller sent reached the handler as if it had never been sent.
    const result = updateAgentSchema.parse({
      someFieldTheSchemaDoesNotKnowAbout: "kept",
    });

    expect((result as Record<string, unknown>).someFieldTheSchemaDoesNotKnowAbout).toBe("kept");
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
