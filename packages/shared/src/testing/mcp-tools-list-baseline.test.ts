import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZOD3_DATETIME_OFFSET_REGEX } from "../validators/zod-compat.js";
import { classifyToolsListDifferences, diffToolsList, type McpToolEntry } from "./mcp-tools-list-baseline.js";

function tool(inputSchema: unknown, extra: Record<string, unknown> = {}): McpToolEntry {
  return { name: "t", description: "d", inputSchema, ...extra };
}

describe("diffToolsList", () => {
  it("treats zod-to-json-schema and zod 4 spellings of the same schema as equal", () => {
    const golden = tool({
      type: "object",
      properties: {
        a: { anyOf: [{ anyOf: [{ not: {} }, { type: "string", minLength: 1 }] }, { type: "null" }] },
        b: { $ref: "#/properties/a/anyOf/0/anyOf/1" },
        c: { type: "object", additionalProperties: {} },
        d: { anyOf: [{ type: "object", properties: { k: { type: "string", const: "x" } } }, { type: "null" }] },
      },
      required: ["b"],
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    const current = tool({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["b"],
      properties: {
        a: { type: ["string", "null"], minLength: 1 },
        b: { minLength: 1, type: "string" },
        c: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
        d: { anyOf: [{ oneOf: [{ type: "object", properties: { k: { type: "string", const: "x" } } }] }, { type: "null" }] },
      },
    });
    // `d` differs: zod 4 wraps the exclusive union, zod-to-json-schema did not.
    expect(diffToolsList([golden], [current]).map((difference) => difference.pointer)).toEqual([
      "/inputSchema/properties/d/anyOf/0/anyOf",
      "/inputSchema/properties/d/anyOf/0/properties",
      "/inputSchema/properties/d/anyOf/0/type",
    ]);
  });

  it("explains only the documented content changes", () => {
    const uuidPattern = z.core.regexes.uuid().source;
    const golden = tool({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        at: { type: "string", format: "date-time" },
        count: { type: "integer", minimum: 0 },
        ratio: { type: "number" },
        code: { type: "string" },
        mode: { type: "string", enum: ["a", "b"], default: "a" },
        list: { type: "array", items: { type: "string" }, additionalProperties: false },
      },
      additionalProperties: false,
    });
    const current = tool({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", pattern: uuidPattern },
        at: { type: "string", format: "date-time", pattern: ZOD3_DATETIME_OFFSET_REGEX.source },
        count: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        ratio: { type: "number", maximum: Number.MAX_SAFE_INTEGER },
        code: { type: "string", pattern: "^x$" },
        mode: { type: "string", enum: ["a", "b"] },
        list: { type: "array", items: { type: "string" } },
      },
    });
    const differences = diffToolsList([golden], [current]);
    expect(differences.map(({ pointer, rule }) => [pointer, rule ?? null])).toEqual([
      ["/inputSchema/additionalProperties", "strip-object-additional-properties"],
      ["/inputSchema/properties/at/pattern", "zod3-datetime-pattern"],
      ["/inputSchema/properties/code/pattern", null],
      ["/inputSchema/properties/count/maximum", "safe-integer-bound"],
      ["/inputSchema/properties/id/pattern", "strict-uuid-pattern"],
      ["/inputSchema/properties/list/additionalProperties", null],
      ["/inputSchema/properties/mode/default", null],
      ["/inputSchema/properties/ratio/maximum", null],
    ]);

    const classified = classifyToolsListDifferences(differences, {
      "t/inputSchema/properties/mode/default": "documented",
      "t/inputSchema/properties/gone": "stale",
    });
    expect(classified.unexplained.map((difference) => difference.pointer)).toEqual([
      "/inputSchema/properties/code/pattern",
      "/inputSchema/properties/list/additionalProperties",
      "/inputSchema/properties/ratio/maximum",
    ]);
    expect(classified.staleDocumented).toEqual(["t/inputSchema/properties/gone"]);
    expect(classified.byRule["strict-uuid-pattern"]).toEqual(["t/inputSchema/properties/id/pattern"]);
  });

  it("reports changed tool metadata and added or removed tools", () => {
    const differences = diffToolsList(
      [tool({ type: "object", properties: {} }), { name: "gone", inputSchema: {} }],
      [tool({ type: "object", properties: {} }, { description: "changed" }), { name: "new", inputSchema: {} }],
    );
    expect(differences.map(({ tool: name, pointer, rule }) => [name, pointer, rule ?? null])).toEqual([
      ["t", "/description", null],
      ["gone", "", null],
      ["new", "", null],
    ]);
  });
});
