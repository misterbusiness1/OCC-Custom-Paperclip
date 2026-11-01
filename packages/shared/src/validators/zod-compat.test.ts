import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { telemetryConfigSchema } from "../config-schema.js";
import { builtInAgentProvisionSchema, updateAgentSchema } from "./agent.js";
import { updateCompanySchema } from "./company.js";
import { companyPortabilityExportSchema } from "./company-portability.js";
import { updateGoalSchema } from "./goal.js";
import { patchInstanceExperimentalSettingsSchema, patchInstanceGeneralSettingsSchema } from "./instance.js";
import { updateIssueSchema } from "./issue.js";
import { setPluginStateSchema } from "./plugin.js";
import { updateProjectSchema } from "./project.js";
import { updateRoutineSchema } from "./routine.js";
import {
  createToolMcpGatewaySchema,
  createToolMcpGatewayTokenSchema,
  deleteToolProfileSchema,
  toolMcpGatewayAuthConfigSchema,
  toolMcpGatewayHeaderPolicySchema,
  toolRedactedValueSummarySchema,
  updateToolConnectionSchema,
  updateToolPolicySchema,
  updateToolProfileSchema,
} from "./tool-access.js";
import { updateIssueWorkProductSchema } from "./work-product.js";
import { workspaceFileListQuerySchema, workspaceFileResourceQuerySchema } from "./workspace-file-resource.js";
import { datetimeString, urlString, withoutFieldDefaults, withoutOptionalDefault } from "./zod-compat.js";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("withoutOptionalDefault", () => {
  it("drops defaults under .optional(), including through .nullable() in either order", () => {
    const probe = (field: z.ZodType) => z.object({ k: withoutOptionalDefault(field) }).parse({});
    expect(probe(z.string().default("x").optional())).toEqual({});
    expect(probe(z.string().default("x").optional().nullable())).toEqual({});
    expect(probe(z.string().default("x").nullable().optional())).toEqual({});
    expect(probe(z.object({ a: z.boolean().default(true) }).prefault({}).optional())).toEqual({});
  });

  it("keeps defaults that are not under .optional() (zod 3 applied those too)", () => {
    const outer = z.string().optional().default("x");
    expect(withoutOptionalDefault(outer)).toBe(outer);
    const nullableDefault = z.string().default("x").nullable();
    expect(withoutOptionalDefault(nullableDefault)).toBe(nullableDefault);
    expect(z.object({ k: withoutOptionalDefault(outer) }).parse({})).toEqual({ k: "x" });
  });

  it("returns the same schema when there is nothing to strip", () => {
    const field = z.string().optional();
    expect(withoutOptionalDefault(field)).toBe(field);
  });

  it("still validates and passes through values that are present", () => {
    const field = withoutOptionalDefault(z.enum(["a", "b"]).default("a").optional().nullable());
    expect(field.parse("b")).toBe("b");
    expect(field.parse(null)).toBeNull();
    expect(field.safeParse("c").success).toBe(false);
  });

  it("keeps .describe() metadata that sat on the removed default", () => {
    const stripped = withoutOptionalDefault(agentAdapterTypeSchema.optional()) as z.ZodOptional<z.ZodType>;
    expect(stripped.unwrap().description).toBe(agentAdapterTypeSchema.description);
    expect(agentAdapterTypeSchema.description).toMatch(/Known built-in adapters/);
  });
});

describe("withoutFieldDefaults", () => {
  it("keeps strict objects strict and refinements in place", () => {
    const strict = withoutFieldDefaults(z.object({ a: z.number().default(1).optional() }).strict());
    expect(strict.parse({})).toEqual({});
    expect(strict.safeParse({ extra: true }).success).toBe(false);

    const refined = withoutFieldDefaults(
      z.object({ a: z.number().default(1).optional() }).refine((value) => Object.keys(value).length > 0, "need one"),
    );
    expect(refined.safeParse({}).success).toBe(false);
    expect(refined.parse({ a: 2 })).toEqual({ a: 2 });
  });

  it("returns the same schema when no field needs stripping", () => {
    const schema = z.object({ a: z.string().optional() });
    expect(withoutFieldDefaults(schema)).toBe(schema);
  });
});

describe("update and PATCH schemas leave omitted fields omitted", () => {
  const cases: Array<[string, z.ZodType, Record<string, unknown>]> = [
    ["updateIssueSchema", updateIssueSchema, { title: "Renamed" }],
    ["updateAgentSchema", updateAgentSchema, { name: "Renamed" }],
    ["updateCompanySchema", updateCompanySchema, { name: "Renamed" }],
    ["updateGoalSchema", updateGoalSchema, { title: "Renamed" }],
    ["updateProjectSchema", updateProjectSchema, { name: "Renamed" }],
    ["updateRoutineSchema", updateRoutineSchema, { title: "Renamed" }],
    ["updateIssueWorkProductSchema", updateIssueWorkProductSchema, { title: "Renamed" }],
    ["patchInstanceExperimentalSettingsSchema", patchInstanceExperimentalSettingsSchema, { enableApps: true }],
    ["patchInstanceGeneralSettingsSchema", patchInstanceGeneralSettingsSchema, { keyboardShortcuts: true }],
    ["updateToolConnectionSchema", updateToolConnectionSchema, { name: "Renamed" }],
    ["updateToolProfileSchema", updateToolProfileSchema, { name: "Renamed" }],
    ["updateToolPolicySchema", updateToolPolicySchema, { name: "Renamed" }],
  ];

  for (const [name, schema, oneKey] of cases) {
    it(`${name} returns only the keys that were sent`, () => {
      const empty = schema.safeParse({});
      if (empty.success) expect(empty.data).toEqual({});
      expect(schema.parse(oneKey)).toEqual(oneKey);
    });
  }

  it("rejects {} for the tool update schemas that require at least one field", () => {
    expect(updateToolConnectionSchema.safeParse({}).success).toBe(false);
    expect(updateToolProfileSchema.safeParse({}).success).toBe(false);
    expect(updateToolPolicySchema.safeParse({}).success).toBe(false);
  });

  it("keeps patchInstanceGeneralSettingsSchema strict and the experimental patch stripping", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ bogus: true }).success).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ bogus: true, enableApps: false })).toEqual({ enableApps: false });
  });
});

describe("non-PATCH schemas that reuse defaulted fields under .optional()", () => {
  it("leaves builtInAgentProvisionSchema.adapterType absent so the built-in default adapter applies", () => {
    expect(builtInAgentProvisionSchema.parse({})).toEqual({});
    expect(builtInAgentProvisionSchema.parse({ budgetMonthlyCents: 5 })).toEqual({ budgetMonthlyCents: 5 });
    expect(builtInAgentProvisionSchema.parse({ adapterType: " codex_local " })).toEqual({ adapterType: "codex_local" });
    expect(builtInAgentProvisionSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("does not inject gateway/token defaults the server applies itself", () => {
    const gateway = createToolMcpGatewaySchema.parse({ name: "Gateway", profileId: uuid });
    expect(gateway).not.toHaveProperty("defaultProfileMode");
    expect(gateway).not.toHaveProperty("contextScopeType");
    const token = createToolMcpGatewayTokenSchema.parse({ name: "Token", clientLabel: "CLI", ownerNote: "ops" });
    expect(token).not.toHaveProperty("subjectType");
    expect(token).not.toHaveProperty("allowedActions");
    expect(toolRedactedValueSummarySchema.parse({ summary: "x" })).toEqual({ summary: "x" });
  });

  it("leaves workspace file selectors absent", () => {
    expect(workspaceFileResourceQuerySchema.parse({ path: "a.md" })).toEqual({ path: "a.md" });
    expect(workspaceFileListQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
  });

  it("leaves sidebar order lists absent in partial portability exports", () => {
    const parsed = companyPortabilityExportSchema.parse({ sidebarOrder: {} });
    expect(parsed.sidebarOrder).toEqual({});
  });
});

describe("object defaults keep zod 3's nested defaults (prefault)", () => {
  it("fills nested defaults from an empty default object", () => {
    expect(telemetryConfigSchema.parse(undefined)).toEqual({ enabled: true });
    expect(deleteToolProfileSchema.parse(undefined)).toEqual({ force: false });
    expect(toolMcpGatewayAuthConfigSchema.parse({})).toEqual({
      version: 1,
      bearer: {
        enabled: true,
        tokenPrefix: "pcgw",
        defaultTtlSeconds: 7_776_000,
        requireFiniteExpiry: true,
        longLivedTokenRequiresOverride: true,
      },
      oauth: { enabled: false, reservedFor: "v1_5" },
    });
    expect(toolMcpGatewayHeaderPolicySchema.parse({})).toEqual({
      version: 1,
      callerPassthrough: { enabled: false, allowedHeaders: [] },
      staticHeaders: [],
      generatedMetadata: { enabled: false, allowedHeaders: [] },
      responseHeaders: { forwardMcpRequiredHeaders: true, forwardSafeCacheHeaders: true },
    });
  });
});

describe("setPluginStateSchema", () => {
  it("accepts an omitted value like zod 3 did", () => {
    expect(setPluginStateSchema.parse({ scopeKind: "instance", stateKey: "k" })).toEqual({
      scopeKind: "instance",
      stateKey: "k",
    });
  });
});

describe("datetimeString", () => {
  it("accepts zod 3 datetimes that zod 4's .datetime() rejects", () => {
    expect(datetimeString().parse("2026-10-31T12:00Z")).toBe("2026-10-31T12:00Z");
    expect(datetimeString({ offset: true }).parse("2026-10-31T12:00+0200")).toBe("2026-10-31T12:00+0200");
    expect(z.iso.datetime().safeParse("2026-10-31T12:00Z").success).toBe(false);
  });

  it("rejects what zod 3 rejected, with zod 3's message", () => {
    for (const value of ["2026-10-31T12:00:00", "2026-10-31T12:00:00+02:00", "2026-02-30T12:00:00Z", "2026-10-31"]) {
      const result = datetimeString().safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("Invalid datetime");
    }
    expect(datetimeString({ offset: true }).safeParse("2026-10-31T12:00:00+02").success).toBe(false);
  });

  it("trims before validating when asked, like z.string().trim().datetime()", () => {
    expect(datetimeString({ offset: true, trim: true }).parse(" 2026-10-31T12:00:00+02:00 ")).toBe("2026-10-31T12:00:00+02:00");
    expect(datetimeString({ offset: true }).safeParse(" 2026-10-31T12:00:00+02:00 ").success).toBe(false);
  });
});

describe("urlString", () => {
  it("returns the input unchanged like zod 3 (zod 4's .url() trims it)", () => {
    expect(urlString().parse(" https://example.com ")).toBe(" https://example.com ");
    expect(urlString().parse("https://example.com/\n")).toBe("https://example.com/\n");
    expect(urlString({ trim: true }).parse(" https://example.com ")).toBe("https://example.com");
  });

  it("rejects unparseable URLs with zod 3's message", () => {
    const result = urlString().safeParse("example.com");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Invalid url");
  });
});

describe("strict UUIDs", () => {
  it("accept RFC 9562 UUIDs and reject other 8-4-4-4-12 hex strings", () => {
    expect(z.uuid().safeParse(uuid).success).toBe(true);
    expect(z.uuid().safeParse("00000000-0000-0000-0000-000000000000").success).toBe(true);
    expect(z.uuid().safeParse("11111111-1111-1111-1111-111111111111").success).toBe(false);
  });
});
