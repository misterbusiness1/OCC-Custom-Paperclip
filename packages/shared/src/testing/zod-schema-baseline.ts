/**
 * Version-agnostic zod schema introspection for the zod 3 -> zod 4 migration
 * baseline tests.
 *
 * Test-only module (like everything in src/testing): imported by test files
 * here, in the server, the MCP servers and plugin-workspace-diff, and by
 * relative path from the standalone kubernetes provider's tests, which
 * therefore only run inside this repository. It is compiled into dist with
 * the rest of src (as the package's tests are) but is not runtime API.
 *
 * This module deliberately imports nothing from "zod". It reads either zod 3
 * internals (`_def.typeName`) or zod 4 internals (`_zod.def.type`) so the same
 * analyzer runs before and after the migration, and callers pass in their own
 * `z` so the probes are built with the same zod copy as the schemas under test.
 *
 * What it records, per schema root:
 * - `fields`: for every object field reachable from the root, what parsing an
 *   object that OMITS that key produces: "required" (parse fails), "omitted"
 *   (parse succeeds and the key stays absent) or `{ filled: value }` (parse
 *   succeeds and a value is injected, i.e. a default fired).
 * - `objects`: the unknown-key policy (strip/strict/passthrough/catchall) of
 *   every object reachable from the root.
 * - `defaultsUnderOptional`: fields whose schema puts a `.default()` or
 *   `.prefault()` underneath an `.optional()` wrapper (directly, through
 *   `.partial()`, or through `.nullable()`/`.readonly()`/pipes). zod 3 never
 *   fired those defaults for an absent key; zod 4 does.
 * - `roots`: what the root itself returns for `undefined` and `{}`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;

export interface ZodLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  object: (shape: Record<string, any>) => { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
}

export type FieldBehaviour =
  | "required"
  | "omitted"
  | { filled: unknown }
  | { threw: string }
  | { conflict: FieldBehaviour[] };

export type ParseOutcome = { ok: true; data: unknown } | { ok: false } | { threw: string };

export type ObjectPolicy = "strip" | "strict" | "passthrough" | "catchall";

export interface SchemaBaseline {
  fields: Record<string, FieldBehaviour>;
  objects: Record<string, ObjectPolicy>;
  defaultsUnderOptional: string[];
  roots: Record<string, { undefined: ParseOutcome; emptyObject: ParseOutcome }>;
}

type Kind =
  | "object"
  | "optional"
  | "nullable"
  | "default"
  | "prefault"
  | "catch"
  | "readonly"
  | "branded"
  | "nonoptional"
  | "effects"
  | "pipe"
  | "transform"
  | "array"
  | "record"
  | "union"
  | "intersection"
  | "tuple"
  | "lazy"
  | "never"
  | "unknown"
  | "any"
  | "other";

const V3_KINDS: Record<string, Kind> = {
  ZodObject: "object",
  ZodOptional: "optional",
  ZodNullable: "nullable",
  ZodDefault: "default",
  ZodCatch: "catch",
  ZodReadonly: "readonly",
  ZodBranded: "branded",
  ZodEffects: "effects",
  ZodPipeline: "pipe",
  ZodArray: "array",
  ZodRecord: "record",
  ZodUnion: "union",
  ZodDiscriminatedUnion: "union",
  ZodIntersection: "intersection",
  ZodTuple: "tuple",
  ZodLazy: "lazy",
  ZodNever: "never",
  ZodUnknown: "unknown",
  ZodAny: "any",
};

const V4_KINDS: Record<string, Kind> = {
  object: "object",
  optional: "optional",
  nullable: "nullable",
  default: "default",
  prefault: "prefault",
  catch: "catch",
  readonly: "readonly",
  nonoptional: "nonoptional",
  pipe: "pipe",
  transform: "transform",
  array: "array",
  record: "record",
  union: "union",
  intersection: "intersection",
  tuple: "tuple",
  lazy: "lazy",
  never: "never",
  unknown: "unknown",
  any: "any",
};

export function isZodSchema(value: unknown): value is AnySchema {
  if (!value || typeof value !== "object") return false;
  const candidate = value as AnySchema;
  return typeof candidate.safeParse === "function" && (candidate._zod !== undefined || candidate._def !== undefined);
}

function v4Def(schema: AnySchema): AnySchema | undefined {
  return schema?._zod?.def;
}

export function schemaKind(schema: AnySchema): Kind {
  const def4 = v4Def(schema);
  if (def4) return V4_KINDS[def4.type as string] ?? "other";
  const typeName = schema?._def?.typeName as string | undefined;
  return (typeName && V3_KINDS[typeName]) || "other";
}

function innerOf(schema: AnySchema): AnySchema | undefined {
  const def4 = v4Def(schema);
  if (def4) return def4.innerType;
  const def3 = schema._def;
  return def3.innerType ?? def3.type ?? def3.schema;
}

function objectShape(schema: AnySchema): Record<string, AnySchema> {
  const def4 = v4Def(schema);
  if (def4) return def4.shape as Record<string, AnySchema>;
  return schema._def.shape() as Record<string, AnySchema>;
}

function objectCatchall(schema: AnySchema): AnySchema | undefined {
  const def4 = v4Def(schema);
  if (def4) return def4.catchall;
  return schema._def.catchall;
}

export function objectPolicy(schema: AnySchema): ObjectPolicy {
  const catchall = objectCatchall(schema);
  const def4 = v4Def(schema);
  if (def4) {
    if (!catchall) return "strip";
    const kind = schemaKind(catchall);
    if (kind === "never") return "strict";
    if (kind === "unknown" || kind === "any") return "passthrough";
    return "catchall";
  }
  if (catchall && schemaKind(catchall) !== "never") {
    // `.catchall(z.unknown())` keeps unknown keys untouched, exactly like
    // `.passthrough()`; zod 4 implements both as a `z.unknown()` catchall.
    const kind = schemaKind(catchall);
    return kind === "unknown" || kind === "any" ? "passthrough" : "catchall";
  }
  const unknownKeys = schema._def.unknownKeys as string | undefined;
  if (unknownKeys === "strict") return "strict";
  if (unknownKeys === "passthrough") return "passthrough";
  return "strip";
}

function pipeParts(schema: AnySchema): { in: AnySchema; out: AnySchema } {
  const def = v4Def(schema) ?? schema._def;
  return { in: def.in, out: def.out };
}

function defaultValueOf(schema: AnySchema): unknown {
  const def4 = v4Def(schema);
  if (def4) return def4.defaultValue;
  const raw = schema._def.defaultValue;
  return typeof raw === "function" ? raw() : raw;
}

interface Child {
  segment: string;
  schema: AnySchema;
}

/** Children of a non-object node; wrappers contribute no path segment. */
function nonObjectChildren(schema: AnySchema, kind: Kind): Child[] {
  const def4 = v4Def(schema);
  const def = def4 ?? schema._def;
  switch (kind) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "branded":
    case "nonoptional":
    case "effects": {
      const inner = innerOf(schema);
      return inner ? [{ segment: "", schema: inner }] : [];
    }
    case "pipe": {
      const parts = pipeParts(schema);
      return [
        { segment: "", schema: parts.in },
        { segment: "", schema: parts.out },
      ];
    }
    case "array":
      return [{ segment: "[]", schema: def4 ? def4.element : def.type }];
    case "record":
      return [{ segment: "{}", schema: def.valueType }];
    case "union": {
      const options: AnySchema[] = Array.isArray(def.options) ? def.options : Array.from(def.options.values());
      return options.map((option, index) => ({ segment: `|${index}`, schema: option }));
    }
    case "intersection":
      return [
        { segment: "&L", schema: def.left },
        { segment: "&R", schema: def.right },
      ];
    case "tuple": {
      const items: AnySchema[] = def.items ?? [];
      const children = items.map((item, index) => ({ segment: `[${index}]`, schema: item }));
      if (def.rest) children.push({ segment: "[...]", schema: def.rest });
      return children;
    }
    case "lazy": {
      try {
        const resolved = def.getter();
        return resolved ? [{ segment: "", schema: resolved }] : [];
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}

/**
 * Returns the default value when the field's wrapper chain places a default or
 * prefault below an `.optional()` wrapper (the zod 4 "default fires inside
 * optional/partial" hazard). Returns `undefined` otherwise.
 */
export function findDefaultUnderOptional(field: AnySchema): { value: unknown } | undefined {
  let current = field;
  let sawOptional = false;
  for (let depth = 0; depth < 32 && current; depth += 1) {
    const kind = schemaKind(current);
    switch (kind) {
      case "optional":
        sawOptional = true;
        current = innerOf(current);
        continue;
      case "nonoptional":
        sawOptional = false;
        current = innerOf(current);
        continue;
      case "nullable":
      case "readonly":
      case "branded":
      case "catch":
      case "effects":
        current = innerOf(current);
        continue;
      case "pipe": {
        const parts = pipeParts(current);
        current = schemaKind(parts.in) === "transform" ? parts.out : parts.in;
        continue;
      }
      case "default":
      case "prefault":
        if (!sawOptional) return undefined;
        try {
          return { value: defaultValueOf(current) };
        } catch (error) {
          return { value: `<default threw: ${(error as Error).message}>` };
        }
      default:
        return undefined;
    }
  }
  return undefined;
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return "<undefined>";
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, inner) => {
        if (inner === undefined) return "<undefined>";
        if (typeof inner === "bigint") return `<bigint ${inner.toString()}>`;
        if (typeof inner === "function") return "<function>";
        return inner;
      }),
    );
  } catch (error) {
    return `<unserializable: ${(error as Error).message}>`;
  }
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What parsing `{}` against `z.object({ [key]: field })` produces. */
export function missingKeyBehaviour(z: ZodLike, key: string, field: AnySchema): FieldBehaviour {
  const probeOnce = (): FieldBehaviour => {
    let result: { success: boolean; data?: unknown };
    try {
      result = z.object({ [key]: field }).safeParse({});
    } catch (error) {
      return { threw: (error as Error).message };
    }
    if (!result.success) return "required";
    const data = result.data as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(data, key)) return { filled: jsonSafe(data[key]) };
    return "omitted";
  };
  const first = probeOnce();
  const second = probeOnce();
  if (!sameJson(first, second)) return { filled: "<nondeterministic>" };
  return first;
}

function parseOutcome(schema: AnySchema, input: unknown): ParseOutcome {
  const once = (): ParseOutcome => {
    try {
      const result = schema.safeParse(input);
      return result.success ? { ok: true, data: jsonSafe(result.data) } : { ok: false };
    } catch (error) {
      return { threw: (error as Error).message };
    }
  };
  const first = once();
  const second = once();
  if (!sameJson(first, second)) return { ok: true, data: "<nondeterministic>" };
  return first;
}

const MAX_DEPTH = 24;

function recordField(baseline: SchemaBaseline, path: string, behaviour: FieldBehaviour) {
  const existing = baseline.fields[path];
  if (existing === undefined) {
    baseline.fields[path] = behaviour;
    return;
  }
  if (sameJson(existing, behaviour)) return;
  const prior = typeof existing === "object" && existing !== null && "conflict" in existing ? existing.conflict : [existing];
  if (prior.some((entry) => sameJson(entry, behaviour))) return;
  baseline.fields[path] = { conflict: [...prior, behaviour] };
}

function walk(
  z: ZodLike,
  schema: AnySchema,
  path: string,
  baseline: SchemaBaseline,
  stack: Set<AnySchema>,
  depth: number,
) {
  if (!isZodSchema(schema) || depth > MAX_DEPTH || stack.has(schema)) return;
  stack.add(schema);
  try {
    const kind = schemaKind(schema);
    if (kind === "object") {
      if (baseline.objects[path] === undefined) baseline.objects[path] = objectPolicy(schema);
      const shape = objectShape(schema);
      for (const key of Object.keys(shape)) {
        const field = shape[key];
        const fieldPath = `${path}.${key}`;
        recordField(baseline, fieldPath, missingKeyBehaviour(z, key, field));
        if (findDefaultUnderOptional(field) && !baseline.defaultsUnderOptional.includes(fieldPath)) {
          baseline.defaultsUnderOptional.push(fieldPath);
        }
        walk(z, field, fieldPath, baseline, stack, depth + 1);
      }
      const catchall = objectCatchall(schema);
      if (catchall && !["never", "unknown", "any"].includes(schemaKind(catchall))) {
        walk(z, catchall, `${path}.<catchall>`, baseline, stack, depth + 1);
      }
      return;
    }
    for (const child of nonObjectChildren(schema, kind)) {
      walk(z, child.schema, `${path}${child.segment}`, baseline, stack, depth + 1);
    }
  } finally {
    stack.delete(schema);
  }
}

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A plain object whose values are all zod schemas (a reusable field map spread into object schemas). */
export function isZodFieldMap(value: unknown): value is Record<string, AnySchema> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isZodSchema(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return entries.length > 0 && entries.every((entry) => isZodSchema(entry));
}

/** Collects every zod schema (and zod field map) found among a module's exports. */
export function zodExports(moduleExports: Record<string, unknown>, prefix: string): Record<string, AnySchema> {
  const out: Record<string, AnySchema> = {};
  for (const [name, value] of Object.entries(moduleExports)) {
    if (isZodSchema(value) || isZodFieldMap(value)) out[`${prefix}${name}`] = value;
  }
  return out;
}

function walkFieldMap(z: ZodLike, fields: Record<string, AnySchema>, path: string, baseline: SchemaBaseline) {
  for (const key of Object.keys(fields)) {
    const field = fields[key];
    const fieldPath = `${path}.${key}`;
    recordField(baseline, fieldPath, missingKeyBehaviour(z, key, field));
    if (findDefaultUnderOptional(field) && !baseline.defaultsUnderOptional.includes(fieldPath)) {
      baseline.defaultsUnderOptional.push(fieldPath);
    }
    walk(z, field, fieldPath, baseline, new Set(), 1);
  }
}

/**
 * Walks every root (a schema or a zod field map). Pass `{ includeRequired: false }`
 * to leave "required" fields out of `fields` (absence then means "required"),
 * which keeps committed goldens small without losing information.
 */
export function collectSchemaBaseline(
  z: ZodLike,
  roots: Record<string, AnySchema>,
  options: { includeRequired?: boolean } = {},
): SchemaBaseline {
  const baseline: SchemaBaseline = { fields: {}, objects: {}, defaultsUnderOptional: [], roots: {} };
  for (const name of Object.keys(roots).sort()) {
    const root = roots[name];
    if (isZodFieldMap(root)) {
      walkFieldMap(z, root, name, baseline);
      continue;
    }
    baseline.roots[name] = {
      undefined: parseOutcome(root, undefined),
      emptyObject: parseOutcome(root, {}),
    };
    walk(z, root, name, baseline, new Set(), 0);
  }
  if (options.includeRequired === false) {
    for (const [path, behaviour] of Object.entries(baseline.fields)) {
      if (behaviour === "required") delete baseline.fields[path];
    }
  }
  baseline.fields = sortRecord(baseline.fields);
  baseline.objects = sortRecord(baseline.objects);
  baseline.defaultsUnderOptional.sort();
  return baseline;
}

/** True when `z` is zod 4 (classic schemas carry `_zod` internals). */
export function isZod4(z: { string: () => unknown }): boolean {
  const probe = z.string() as Record<string, unknown>;
  return probe !== null && typeof probe === "object" && "_zod" in probe;
}

/**
 * Static guard for the analyzer: every `.default(`, `.prefault(`, `.partial(` or
 * `.deepPartial(` call in a source file must sit inside a top-level
 * `export const` so the runtime analyzer (which walks module exports) reaches
 * it. Returns offending `line: text` entries; `allowedConsts` names top-level
 * consts covered some other way (for example MCP tool schemas walked through
 * `createToolDefinitions`).
 */
export function findUnexportedSchemaDefaults(source: string, allowedConsts: readonly string[] = []): string[] {
  const offenders: string[] = [];
  const lines = source.split("\n");
  let header: string | null = null;
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith("//")) return;
    if (/^(export\s+)?(const|let|var|function|async\s+function|class|interface|type|enum)\b/.test(line) || /^export\s+(default|\{)/.test(line)) {
      header = line;
    }
    if (!/\.(default|prefault|partial|deepPartial)\(/.test(line)) return;
    const current = header as string | null;
    if (current && /^export\s+const\b/.test(current)) return;
    const constName = current?.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)/)?.[1];
    if (constName && allowedConsts.includes(constName)) return;
    offenders.push(`${index + 1}: ${trimmed}`);
  });
  return offenders;
}

const DEFAULT_PASS_THROUGH_METHODS = new Set(["nullable", "readonly", "describe", "meta", "brand"]);

/**
 * The method names of an expression's outermost call chain, outermost first:
 * `z.record(a, b).default({}).describe("x")` -> ["describe", "default", "record"].
 * Brackets are matched textually; good enough for schema declarations.
 */
function outerMethodChain(expression: string): string[] {
  let rest = expression.trim().replace(/;\s*$/, "").trim();
  const methods: string[] = [];
  while (rest.endsWith(")")) {
    let depth = 0;
    let index = rest.length - 1;
    for (; index >= 0; index -= 1) {
      const char = rest[index];
      if (char === ")" || char === "]" || char === "}") depth += 1;
      else if (char === "(" || char === "[" || char === "{") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (index < 0) break;
    const before = rest.slice(0, index);
    const match = before.match(/\.\s*(\w+)\s*$/);
    if (!match) break;
    methods.push(match[1]!);
    rest = before.slice(0, before.length - match[0].length).trimEnd();
  }
  return methods;
}

function endsInDefault(expression: string): boolean {
  for (const method of outerMethodChain(expression)) {
    if (method === "default" || method === "prefault") return true;
    if (!DEFAULT_PASS_THROUGH_METHODS.has(method)) return false;
  }
  return false;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const TOP_LEVEL_HEADER = /^(export\s+)?(const|let|var|function|async\s+function|class|interface|type|enum)\b|^export\s+(default|\{)/;

/**
 * Names of a module's top-level consts whose schema ends in `.default()` or
 * `.prefault()` (also behind `.nullable()`/`.readonly()`/`.describe()`/`.meta()`).
 */
export function findDefaultedConsts(source: string): string[] {
  const names: string[] = [];
  const lines = stripComments(source).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=(.*)$/);
    if (!match) continue;
    const body = [match[2]!];
    for (let next = index + 1; next < lines.length && !TOP_LEVEL_HEADER.test(lines[next]!); next += 1) body.push(lines[next]!);
    if (endsInDefault(body.join("\n"))) names.push(match[1]!);
  }
  return names;
}

/**
 * Names of exported schemas whose outermost wrapper (through
 * nullable/readonly) is a `.default()` or `.prefault()`. Pass them to
 * `findOptionalOverDefaults` for modules that import them.
 */
export function defaultedSchemaExports(moduleExports: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(moduleExports)) {
    if (!isZodSchema(value)) continue;
    let current: AnySchema = value;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      const kind = schemaKind(current);
      if (kind === "default" || kind === "prefault") {
        names.push(name);
        break;
      }
      if (kind !== "nullable" && kind !== "readonly" && kind !== "branded") break;
      current = innerOf(current);
    }
  }
  return names.sort();
}

/**
 * Static guard for the case the runtime analyzer cannot see: a schema that
 * ends in `.default()`/`.prefault()` is defined in one const (exported, so the
 * analyzer is satisfied) and wrapped in `.optional()`/`.nullish()` somewhere
 * else, for example in an unexported route body schema. zod 4 applies that
 * default for an omitted key; zod 3 did not. Flags every
 * `NAME.optional()`, `NAME.nullish()`, `NAME.nullable().optional()` and
 * `z.optional(NAME)` where NAME is a same-file const found by
 * `findDefaultedConsts` or listed in `knownDefaulted` (imported schemas, see
 * `defaultedSchemaExports`). A use is accepted when its line also calls
 * `withoutOptionalDefault(`, or its top-level declaration calls
 * `withoutFieldDefaults(`. Returns `line: text` entries.
 */
export function findOptionalOverDefaults(source: string, knownDefaulted: readonly string[] = []): string[] {
  const names = [...new Set([...findDefaultedConsts(source), ...knownDefaulted])];
  if (names.length === 0) return [];
  const alternatives = names.map((name) => name.replace(/[$]/g, "\\$")).join("|");
  const usage = new RegExp(
    `\\b(?:${alternatives})\\s*(?:\\.\\s*nullable\\(\\s*\\))?\\s*\\.\\s*(?:optional|nullish)\\s*\\(|\\bz\\s*\\.\\s*(?:optional|nullish)\\(\\s*(?:${alternatives})\\b`,
  );
  const offenders: string[] = [];
  const lines = source.split("\n");
  let declarationStart = 0;
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith("//")) return;
    if (TOP_LEVEL_HEADER.test(line)) declarationStart = index;
    if (!usage.test(line)) return;
    if (line.includes("withoutOptionalDefault(")) return;
    let declarationEnd = index + 1;
    while (declarationEnd < lines.length && !TOP_LEVEL_HEADER.test(lines[declarationEnd]!)) declarationEnd += 1;
    if (lines.slice(declarationStart, declarationEnd).join("\n").includes("withoutFieldDefaults(")) return;
    offenders.push(`${index + 1}: ${trimmed}`);
  });
  return offenders;
}

/**
 * Fields that zod 3 left absent but the current zod fills in: the regressions
 * the migration must not introduce. Expects `fields` from a zod 3 golden.
 */
export function diffFieldBehaviour(
  golden: Record<string, FieldBehaviour>,
  current: Record<string, FieldBehaviour>,
): Array<{ path: string; golden: FieldBehaviour | undefined; current: FieldBehaviour | undefined }> {
  const paths = new Set([...Object.keys(golden), ...Object.keys(current)]);
  const out: Array<{ path: string; golden: FieldBehaviour | undefined; current: FieldBehaviour | undefined }> = [];
  for (const path of [...paths].sort()) {
    if (!sameJson(golden[path], current[path])) out.push({ path, golden: golden[path], current: current[path] });
  }
  return out;
}
