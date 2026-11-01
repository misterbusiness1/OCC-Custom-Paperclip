import { z } from "zod";
import { ZOD3_DATETIME_OFFSET_REGEX, ZOD3_DATETIME_REGEX } from "../validators/zod-compat.js";

/**
 * Compares an MCP `tools/list` result with its zod 3 golden. Test-only module
 * (see zod-schema-baseline.ts).
 *
 * The goldens were produced by @modelcontextprotocol/sdk with zod 3, which
 * converts tool input schemas with zod-to-json-schema. With zod 4 the SDK uses
 * zod's own `toJSONSchema(schema, { io: "input" })`, which spells some of the
 * same schemas differently. The comparison first rewrites both sides into one
 * spelling (REPRESENTATION_RULES: the JSON Schemas accept exactly the same
 * instances), then reports every remaining difference at its JSON Pointer.
 * A difference is accepted only when a CONTENT_RULE (a documented, intentional
 * class of change) or the caller's per-pointer list explains it.
 */

/** Rewrites that do not change which instances a JSON Schema accepts. */
export const REPRESENTATION_RULES = {
  "zod3-ref": "zod-to-json-schema emitted `$ref` to the first occurrence of a reused schema instance; zod 4 inlines it. The `$ref` is resolved before comparing.",
  "zod3-optional-in-union":
    "zod-to-json-schema spelled `.optional()` inside a union or `.nullable()` as `anyOf: [{ not: {} }, X]`; `{ not: {} }` matches nothing, so this is X.",
  "exclusive-union-one-of":
    "zod 4 emits `oneOf` for exclusive unions (discriminated unions); their options cannot both match, so `oneOf` and the `anyOf` zod-to-json-schema used accept the same instances.",
  "nullable-type-array":
    "zod 4 spells some nullable primitives as `type: [T, \"null\"]` where zod-to-json-schema used `anyOf: [{ type: T }, { type: \"null\" }]`; the two accept the same instances.",
  "record-string-keys":
    "zod 4 adds `propertyNames: { type: \"string\" }` to `z.record(z.string(), ...)`; JSON object keys are always strings.",
  "key-order": "Object keys are compared without regard to order.",
} as const;

/** Intentional classes of change in the advertised schemas. */
export const CONTENT_RULES = {
  "strip-object-additional-properties":
    "zod-to-json-schema emitted `additionalProperties: false` for every non-passthrough object. zod 4 describes the input (`io: \"input\"`, which the MCP SDK requests): a non-strict object accepts unknown keys and strips them, so zod 4 leaves `additionalProperties` out. Parsing is unchanged (unknown keys are still stripped; the schema behaviour baselines assert each object's unknown-key policy), and `.strict()` objects still advertise `additionalProperties: false`.",
  "strict-uuid-pattern":
    "IDs are validated with RFC 9562 `z.uuid()` (owner decision: strict UUIDs); zod 4 publishes the accepted pattern next to `format: \"uuid\"`.",
  "zod3-datetime-pattern":
    "`datetimeString()` keeps zod 3's ISO datetime grammar (seconds optional); zod 4 publishes that grammar as `pattern` next to `format: \"date-time\"`.",
  "safe-integer-bound":
    "zod 4's `.int()` accepts only safe integers and publishes the bound (`maximum: 9007199254740991` / `minimum: -9007199254740991`) where no tighter bound exists.",
} as const;

export type ContentRule = keyof typeof CONTENT_RULES;

export interface McpToolEntry {
  name: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface ToolsListDifference {
  tool: string;
  /** JSON Pointer inside the tool entry, e.g. `/inputSchema/properties/priority/default`. */
  pointer: string;
  golden: unknown;
  current: unknown;
  /** The content rule that explains this difference, if any. */
  rule?: ContentRule;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const ABSENT = "<absent>";
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const UUID_PATTERN = z.core.regexes.uuid().source;
const ZOD3_DATETIME_PATTERNS = new Set([ZOD3_DATETIME_REGEX.source, ZOD3_DATETIME_OFFSET_REGEX.source]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointerSegment(segment: string) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function resolvePointer(root: Json, ref: string): Json {
  let node: Json = root;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(segment)] as Json;
    else if (isObject(node)) node = node[segment] as Json;
    else throw new Error(`Unresolvable $ref ${ref}`);
    if (node === undefined) throw new Error(`Unresolvable $ref ${ref}`);
  }
  return node;
}

// zod3-ref: resolve zod-to-json-schema's relative refs against the input schema root.
function resolveRefs(root: Json, node: Json, depth = 0): Json {
  if (depth > 64) throw new Error("$ref nesting too deep");
  if (Array.isArray(node)) return node.map((entry) => resolveRefs(root, entry, depth));
  if (!isObject(node)) return node;
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/") && Object.keys(node).length === 1) {
    return resolveRefs(root, resolvePointer(root, ref), depth + 1);
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolveRefs(root, value, depth)]));
}

// zod3-optional-in-union
function normalizeGolden(node: Json): Json {
  if (Array.isArray(node)) return node.map(normalizeGolden);
  if (!isObject(node)) return node;
  const next = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, normalizeGolden(value)]));
  if (Array.isArray(next.anyOf)) {
    const options = next.anyOf.filter((option) => !(isObject(option) && Object.keys(option).length === 1 && isObject(option.not) && Object.keys(option.not).length === 0));
    if (options.length === 1 && Object.keys(next).length === 1) return options[0]!;
    next.anyOf = options;
  }
  return next;
}

// Keywords that only constrain instances of one primitive type, so moving them
// into the `{ type: T }` option of an anyOf keeps the accepted instances.
const TYPE_SPECIFIC_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

// exclusive-union-one-of, nullable-type-array, record-string-keys
function normalizeCurrent(node: Json): Json {
  if (Array.isArray(node)) return node.map(normalizeCurrent);
  if (!isObject(node)) return node;
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "propertyNames" && isObject(value) && Object.keys(value).length === 1 && value.type === "string") continue;
    next[key === "oneOf" ? "anyOf" : key] = normalizeCurrent(value);
  }
  const type = next.type;
  if (
    Array.isArray(type) &&
    type.length === 2 &&
    type.includes("null") &&
    Object.keys(next).every((key) => key === "type" || TYPE_SPECIFIC_KEYWORDS.has(key))
  ) {
    const { type: _type, ...constraints } = next;
    return { anyOf: [{ type: type.find((entry) => entry !== "null")!, ...constraints }, { type: "null" }] };
  }
  return next;
}

function contentRuleFor(
  key: string,
  golden: unknown,
  current: unknown,
  currentParent: JsonObject | undefined,
): ContentRule | undefined {
  if (key === "additionalProperties" && golden === false && current === ABSENT && currentParent?.type === "object") {
    return "strip-object-additional-properties";
  }
  if (key === "pattern" && golden === ABSENT && typeof current === "string") {
    if (current === UUID_PATTERN && currentParent?.format === "uuid") return "strict-uuid-pattern";
    if (ZOD3_DATETIME_PATTERNS.has(current) && currentParent?.format === "date-time") return "zod3-datetime-pattern";
  }
  if (golden === ABSENT && currentParent?.type === "integer") {
    if (key === "maximum" && current === SAFE_INTEGER_MAX) return "safe-integer-bound";
    if (key === "minimum" && current === -SAFE_INTEGER_MAX) return "safe-integer-bound";
  }
  return undefined;
}

function diffNodes(tool: string, golden: Json, current: Json, pointer: string, out: ToolsListDifference[]) {
  if (isObject(golden) && isObject(current)) {
    for (const key of [...new Set([...Object.keys(golden), ...Object.keys(current)])].sort()) {
      const childPointer = `${pointer}/${escapePointerSegment(key)}`;
      const hasGolden = Object.hasOwn(golden, key);
      const hasCurrent = Object.hasOwn(current, key);
      if (hasGolden && hasCurrent) {
        diffNodes(tool, golden[key]!, current[key]!, childPointer, out);
        continue;
      }
      const goldenValue = hasGolden ? golden[key] : ABSENT;
      const currentValue = hasCurrent ? current[key] : ABSENT;
      out.push({
        tool,
        pointer: childPointer,
        golden: goldenValue,
        current: currentValue,
        rule: contentRuleFor(key, goldenValue, currentValue, current),
      });
    }
    return;
  }
  if (Array.isArray(golden) && Array.isArray(current) && golden.length === current.length) {
    golden.forEach((entry, index) => diffNodes(tool, entry, current[index]!, `${pointer}/${index}`, out));
    return;
  }
  if (JSON.stringify(golden) !== JSON.stringify(current)) {
    out.push({ tool, pointer, golden, current });
  }
}

function canonicalGoldenTool(tool: McpToolEntry): Json {
  const entry = JSON.parse(JSON.stringify(tool)) as JsonObject;
  if (entry.inputSchema !== undefined) entry.inputSchema = normalizeGolden(resolveRefs(entry.inputSchema, entry.inputSchema));
  return entry;
}

function canonicalCurrentTool(tool: McpToolEntry): Json {
  const entry = JSON.parse(JSON.stringify(tool)) as JsonObject;
  if (entry.inputSchema !== undefined) entry.inputSchema = normalizeCurrent(entry.inputSchema);
  return entry;
}

/**
 * Every difference between the golden and the current `tools/list` entries
 * after the representation rules, with the content rule that explains it
 * (if any). Tools present on only one side are reported at pointer "".
 */
export function diffToolsList(golden: readonly McpToolEntry[], current: readonly McpToolEntry[]): ToolsListDifference[] {
  const out: ToolsListDifference[] = [];
  const currentByName = new Map(current.map((tool) => [tool.name, tool]));
  const goldenNames = new Set(golden.map((tool) => tool.name));
  for (const goldenTool of golden) {
    const currentTool = currentByName.get(goldenTool.name);
    if (!currentTool) {
      out.push({ tool: goldenTool.name, pointer: "", golden: "<tool>", current: ABSENT });
      continue;
    }
    diffNodes(goldenTool.name, canonicalGoldenTool(goldenTool), canonicalCurrentTool(currentTool), "", out);
  }
  for (const tool of current) {
    if (!goldenNames.has(tool.name)) out.push({ tool: tool.name, pointer: "", golden: ABSENT, current: "<tool>" });
  }
  return out;
}

/**
 * Splits `differences` into those a content rule or `documented`
 * (`${tool}${pointer}` -> reason) explains and those nothing explains, and
 * lists documented entries that no longer match a difference.
 */
export function classifyToolsListDifferences(
  differences: readonly ToolsListDifference[],
  documented: Readonly<Record<string, string>>,
) {
  const keys = new Set(differences.map((difference) => `${difference.tool}${difference.pointer}`));
  return {
    unexplained: differences.filter(
      (difference) => !difference.rule && !Object.hasOwn(documented, `${difference.tool}${difference.pointer}`),
    ),
    staleDocumented: Object.keys(documented).filter((key) => !keys.has(key)),
    byRule: Object.fromEntries(
      (Object.keys(CONTENT_RULES) as ContentRule[]).map((rule) => [
        rule,
        differences.filter((difference) => difference.rule === rule).map((difference) => `${difference.tool}${difference.pointer}`),
      ]),
    ) as Record<ContentRule, string[]>,
  };
}
