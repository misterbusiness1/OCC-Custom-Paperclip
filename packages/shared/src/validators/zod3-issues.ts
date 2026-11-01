import { z } from "zod";

/**
 * zod 3-compatible validation issues for API responses.
 *
 * Paperclip's API returned zod 3 issue objects in validation error bodies
 * (`{ error: "Validation error", details: [...] }` and the routes that
 * serialize `error.issues` or `error.flatten()` themselves). zod 4 changed
 * those objects: other codes (`invalid_format`, `invalid_value`), other
 * fields (`origin`, `values`, `format`, nested `errors`), no `received`, and
 * new default messages ("Invalid input: expected string, received undefined"
 * instead of "Required"). To keep the response contract (`code`, `path`,
 * `message`, and `expected`/`received` where zod 3 had them), the server
 * parses client input with `zod3IssueParams` and serializes issues with
 * `toZod3Issues` / `flattenZod3Issues`.
 *
 * How it works:
 * - `zod3ErrorMap` is passed per parse (`schema.parse(input, zod3IssueParams)`),
 *   never installed with `z.config()`: zod 4 shares one global config across
 *   every copy in the process (better-auth, SDKs), and their messages must not
 *   change. zod 4 consults a per-parse map only for issues without a custom
 *   message, and passes it the raw issue, which still has the input value and
 *   the schema that raised it. The map returns zod 3's English message and
 *   records the zod 3 form of the issue under `ZOD3_ISSUE_KEY` on the raw
 *   issue; zod 4.6.7 copies the raw issue's own keys into the final issue
 *   after the map has run (core/util.ts `finalizeIssue`), so the record
 *   reaches `error.issues`. zod is pinned to an exact version and
 *   zod3-issues.test.ts fails if a zod upgrade stops carrying it.
 * - `toZod3Issues` turns final zod 4 issues into zod 3 issue objects: from the
 *   recorded form when present, otherwise from the zod 4 fields alone (issues
 *   with a custom message, or from a parse without `zod3IssueParams`; those
 *   keep their message and cannot report `received`).
 * - It also restores zod 3's issue set and order where zod 4 parses
 *   differently:
 *   - zod 4 runs length/size checks on any value with a `length`/`size`, even
 *     after the type check failed (`[]` sent to `z.string().min(1)` also got
 *     "Array must contain at least 1 element(s)"); zod 3 stopped at the type
 *     error, so those issues are dropped (`inZod3Order`).
 *   - zod 4 runs an array's size checks after its elements; zod 3 reported
 *     the size issue first, so it is moved ahead of the element issues.
 *   - zod 4 aborts a number after a failed `.int()`; zod 3 still ran the
 *     later bound checks (`.int().min(30)` reported both for 1.5). The error
 *     map runs those checks and records their issues
 *     (`laterNumberCheckIssues`, `ZOD3_FOLLOWING_ISSUES_KEY`).
 *   - zod 3 returned the issues of the first union option that failed without
 *     aborting (right type, failing checks or refinements, or a float failing
 *     `.int()`); zod 4 reports `invalid_union` when two or more options did,
 *     and treats `.int()` as aborting. `convertIssue` picks that option.
 *
 * Known differences from zod 3 (zod 4 parsing behaviour that the conversion
 * cannot undo):
 * - An array, set or map over its `.max()` fails before its elements are
 *   parsed (zod 4.6.6's fix for GHSA-mrhx-c7xc-m3w5), so element issues are
 *   not reported alongside the size issue.
 * - `z.enum()` values that look like array indices ("0", "1") are listed
 *   first in `options` and in the message: zod 4 stores enum values as object
 *   keys.
 * - Custom issues added by `superRefine`/`ctx.addIssue` with `path` written
 *   before `message` list `message` before `path` (key order only): zod 4's
 *   final issue no longer shows whether it came from `.refine()` or from the
 *   caller's own object.
 * - When an earlier union option fails only `.int()` (dirty in zod 3) and a
 *   later option has the right type and fails only checks, zod 4 resolves to
 *   the later option without reporting the union, so zod 3's choice of the
 *   earlier option cannot be restored.
 * - zod 4 does not run size checks on a `z.set()` whose elements failed and
 *   reports set element issues without an index. JSON request bodies cannot
 *   carry sets.
 * - A custom message on `.int()` itself skips the error map, so the later
 *   bound checks of that number are not reported (zod 3 reported them).
 */

export const ZOD3_ISSUE_KEY = "zod3" as const;
/** Raw-issue key for zod 3 issues that zod 4 skipped after this one (see `laterNumberCheckIssues`). */
export const ZOD3_FOLLOWING_ISSUES_KEY = "zod3Following" as const;

export type Zod3IssuePath = (string | number)[];

/** A zod 3 issue object as it appears in API responses. */
export interface Zod3Issue {
  code: string;
  path: Zod3IssuePath;
  message: string;
  [key: string]: unknown;
}

/** zod 3's `ZodError` as serialized inside `invalid_union.unionErrors`. */
export interface Zod3SerializedError {
  issues: Zod3Issue[];
  name: "ZodError";
}

type AnyIssue = Record<string, unknown> & { code?: string; path?: PropertyKey[]; message?: string };

/**
 * The zod 3 issue fields in zod 3's key order. A `message: undefined` entry
 * marks where zod 3's issue data carried `message`; `path` is appended.
 */
type Zod3Template = Record<string, unknown>;

const NO_INPUT: unique symbol = Symbol("no input");
type InputValue = unknown | typeof NO_INPUT;

// zod 3 `getParsedType` (helpers/util.js).
function zod3ParsedType(data: unknown): string {
  switch (typeof data) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object": {
      if (Array.isArray(data)) return "array";
      if (data === null) return "null";
      const record = data as { then?: unknown; catch?: unknown };
      if (typeof record.then === "function" && typeof record.catch === "function") return "promise";
      if (typeof Map !== "undefined" && data instanceof Map) return "map";
      if (typeof Set !== "undefined" && data instanceof Set) return "set";
      if (typeof Date !== "undefined" && data instanceof Date) return "date";
      return "object";
    }
    default:
      return "unknown";
  }
}

// zod 3 `util.joinValues`.
function joinValues(values: readonly unknown[], separator = " | ") {
  return values.map((value) => (typeof value === "string" ? `'${value}'` : value)).join(separator);
}

function stringifyLiteral(value: unknown) {
  return JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}

function schemaDef(schema: unknown): Record<string, unknown> | undefined {
  const internals = (schema as { _zod?: { def?: Record<string, unknown> } } | null | undefined)?._zod;
  return internals?.def;
}

// zod 4 `invalid_type.expected` -> zod 3 `ZodParsedType` name.
const ZOD4_EXPECTED_TO_ZOD3: Record<string, string> = {
  int: "integer",
  record: "object",
  tuple: "array",
};

function zod3ExpectedForSchema(schema: unknown): string | undefined {
  let current = schema;
  for (let depth = 0; depth < 16; depth += 1) {
    const def = schemaDef(current);
    if (!def) return undefined;
    const type = def.type as string | undefined;
    if (type === "optional" || type === "nonoptional" || type === "default" || type === "prefault" || type === "catch" || type === "readonly") {
      current = def.innerType;
      continue;
    }
    if (type === "pipe") {
      current = def.in;
      continue;
    }
    return type ? ZOD4_EXPECTED_TO_ZOD3[type] ?? type : undefined;
  }
  return undefined;
}

// zod 4 string format -> zod 3 `invalid_string.validation`.
const ZOD4_FORMAT_TO_ZOD3: Record<string, string> = {
  guid: "uuid",
  uuidv4: "uuid",
  uuidv6: "uuid",
  uuidv7: "uuid",
  ipv4: "ip",
  ipv6: "ip",
  cidrv4: "cidr",
  cidrv6: "cidr",
};

// zod 3 emitted `code` before `validation` for these validations.
const CODE_FIRST_VALIDATIONS = new Set(["datetime", "date", "time"]);

function invalidStringTemplate(issue: AnyIssue, schema: unknown): Zod3Template {
  const format = String(issue.format ?? "");
  if (format === "starts_with") {
    return { code: "invalid_string", validation: { startsWith: issue.prefix }, message: undefined };
  }
  if (format === "ends_with") {
    return { code: "invalid_string", validation: { endsWith: issue.suffix }, message: undefined };
  }
  if (format === "includes") {
    const position = schemaDef(schema)?.position;
    return {
      code: "invalid_string",
      validation: { includes: issue.includes, position: typeof position === "number" ? position : undefined },
      message: undefined,
    };
  }
  const validation = ZOD4_FORMAT_TO_ZOD3[format] ?? format;
  return CODE_FIRST_VALIDATIONS.has(validation)
    ? { code: "invalid_string", validation, message: undefined }
    : { validation, code: "invalid_string", message: undefined };
}

function sizeTemplate(issue: AnyIssue): Zod3Template {
  const origin = String(issue.origin ?? "");
  const type = origin === "int" ? "number" : origin;
  const bound = issue.code === "too_small" ? "minimum" : "maximum";
  return {
    code: issue.code,
    [bound]: issue[bound],
    type,
    inclusive: issue.inclusive ?? true,
    exact: issue.exact === true,
    message: undefined,
  };
}

function prefixPath(prefix: readonly PropertyKey[], path: readonly PropertyKey[] | undefined): Zod3IssuePath {
  return [...prefix, ...(path ?? [])].map((segment) => (typeof segment === "symbol" ? String(segment) : segment)) as Zod3IssuePath;
}

/**
 * The zod 3 form of one zod 4 issue (raw or final). `input` and `schema` are
 * only known while zod builds the issue; without them the input-derived zod 3
 * fields (`received`, the enum/literal split) are left out or guessed.
 */
function zod3Template(issue: AnyIssue, input: InputValue, schema: unknown): Zod3Template | null {
  const hasInput = input !== NO_INPUT;
  switch (issue.code) {
    case "invalid_type": {
      const expected = String(issue.expected ?? "");
      if (expected === "date" && issue.received === "Invalid Date") {
        return { code: "invalid_date" };
      }
      if (expected === "int") {
        return { code: "invalid_type", expected: "integer", received: "float", message: undefined };
      }
      const zod3Expected =
        expected === "nonoptional"
          ? zod3ExpectedForSchema(schemaDef(schema)?.innerType) ?? expected
          : ZOD4_EXPECTED_TO_ZOD3[expected] ?? expected;
      return hasInput
        ? { code: "invalid_type", expected: zod3Expected, received: zod3ParsedType(input) }
        : { code: "invalid_type", expected: zod3Expected };
    }
    case "invalid_value": {
      const values = Array.isArray(issue.values) ? issue.values : [];
      const schemaType = schemaDef(schema)?.type;
      const isLiteral = schemaType ? schemaType === "literal" : values.length === 1 && typeof values[0] !== "string";
      if (isLiteral) {
        const expected = values.length === 1 ? values[0] : values;
        return hasInput
          ? { received: input, code: "invalid_literal", expected }
          : { code: "invalid_literal", expected };
      }
      if (hasInput && typeof input !== "string") {
        // zod 3's z.enum() reported a non-string input as a type error.
        return { expected: joinValues(values), received: zod3ParsedType(input), code: "invalid_type" };
      }
      return hasInput
        ? { received: input, code: "invalid_enum_value", options: values }
        : { code: "invalid_enum_value", options: values };
    }
    case "invalid_format":
      return invalidStringTemplate(issue, schema);
    case "too_small":
    case "too_big":
      return sizeTemplate(issue);
    case "not_multiple_of":
      return { code: "not_multiple_of", multipleOf: issue.divisor, message: undefined };
    case "unrecognized_keys":
      return { code: "unrecognized_keys", keys: issue.keys };
    case "invalid_union":
      if (issue.note === "No matching discriminator" || (issue.discriminator !== undefined && Array.isArray(issue.options))) {
        return { code: "invalid_union_discriminator", options: issue.options ?? [] };
      }
      return { code: "invalid_union" };
    default:
      return null;
  }
}

/** zod 3.25.76's English default message for a zod 3 issue (locales/en.js). */
function zod3DefaultMessage(issue: Zod3Template): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" ? "Required" : `Expected ${issue.expected}, received ${issue.received}`;
    case "invalid_literal":
      return `Invalid literal value, expected ${stringifyLiteral(issue.expected)}`;
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${joinValues((issue.keys as unknown[]) ?? [], ", ")}`;
    case "invalid_union":
      return "Invalid input";
    case "invalid_union_discriminator":
      return `Invalid discriminator value. Expected ${joinValues((issue.options as unknown[]) ?? [])}`;
    case "invalid_enum_value":
      return `Invalid enum value. Expected ${joinValues((issue.options as unknown[]) ?? [])}, received '${String(issue.received)}'`;
    case "invalid_date":
      return "Invalid date";
    case "invalid_string": {
      const validation = issue.validation;
      if (validation && typeof validation === "object") {
        const record = validation as Record<string, unknown>;
        if ("includes" in record) {
          const base = `Invalid input: must include "${String(record.includes)}"`;
          return typeof record.position === "number"
            ? `${base} at one or more positions greater than or equal to ${record.position}`
            : base;
        }
        if ("startsWith" in record) return `Invalid input: must start with "${String(record.startsWith)}"`;
        if ("endsWith" in record) return `Invalid input: must end with "${String(record.endsWith)}"`;
        return "Invalid";
      }
      return validation !== "regex" ? `Invalid ${String(validation)}` : "Invalid";
    }
    case "too_small": {
      const { type, exact, inclusive, minimum } = issue;
      if (type === "array") return `Array must contain ${exact ? "exactly" : inclusive ? "at least" : "more than"} ${minimum} element(s)`;
      if (type === "string") return `String must contain ${exact ? "exactly" : inclusive ? "at least" : "over"} ${minimum} character(s)`;
      if (type === "number" || type === "bigint") {
        return `Number must be ${exact ? "exactly equal to " : inclusive ? "greater than or equal to " : "greater than "}${minimum}`;
      }
      if (type === "date") {
        return `Date must be ${exact ? "exactly equal to " : inclusive ? "greater than or equal to " : "greater than "}${new Date(Number(minimum))}`;
      }
      return "Invalid input";
    }
    case "too_big": {
      const { type, exact, inclusive, maximum } = issue;
      if (type === "array") return `Array must contain ${exact ? "exactly" : inclusive ? "at most" : "less than"} ${maximum} element(s)`;
      if (type === "string") return `String must contain ${exact ? "exactly" : inclusive ? "at most" : "under"} ${maximum} character(s)`;
      if (type === "number") return `Number must be ${exact ? "exactly" : inclusive ? "less than or equal to" : "less than"} ${maximum}`;
      if (type === "bigint") return `BigInt must be ${exact ? "exactly" : inclusive ? "less than or equal to" : "less than"} ${maximum}`;
      if (type === "date") {
        return `Date must be ${exact ? "exactly" : inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number(maximum))}`;
      }
      return "Invalid input";
    }
    case "not_multiple_of":
      return `Number must be a multiple of ${issue.multipleOf}`;
    default:
      return "Invalid input";
  }
}

function recordTemplate(rawIssue: AnyIssue, template: Zod3Template) {
  (rawIssue as Record<string, unknown>)[ZOD3_ISSUE_KEY] = template;
}

type CheckInternals = { def?: { check?: string; error?: (issue: unknown) => unknown }; check?: (payload: unknown) => unknown };

function unwrapMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const message = (value as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : undefined;
}

// zod 4 number checks that zod 3 still evaluated after a failed `.int()`.
const NUMBER_BOUND_CHECKS = new Set(["greater_than", "less_than", "multiple_of"]);

/**
 * zod 3's `.int()` was one check among the number's checks: a float failed it
 * and the later checks (`.min()`, `.max()`, `.multipleOf()`, ...) still ran, so
 * `z.number().int().min(30)` reported both issues for 1.5. zod 4 aborts after
 * the integer check. For an integer failure this runs the owning schema's
 * later bound checks on the input and returns their zod 3 issues (template
 * plus message, honouring a check's own custom message).
 */
function laterNumberCheckIssues(issue: AnyIssue, input: InputValue): Array<{ template: Zod3Template; message: string }> {
  if (issue.code !== "invalid_type" || issue.expected !== "int" || typeof input !== "number") return [];
  const checks = schemaDef(issue.schema)?.checks;
  if (!Array.isArray(checks)) return [];
  const start = checks.indexOf(issue.inst);
  if (start < 0) return [];
  const out: Array<{ template: Zod3Template; message: string }> = [];
  for (const check of checks.slice(start + 1)) {
    const internals = (check as { _zod?: CheckInternals } | null)?._zod;
    if (!internals || typeof internals.check !== "function" || !NUMBER_BOUND_CHECKS.has(String(internals.def?.check))) continue;
    const payload = { value: input, issues: [] as AnyIssue[] };
    internals.check(payload);
    for (const raw of payload.issues) {
      const template = zod3Template(raw, input, check);
      if (!template) continue;
      out.push({ template, message: unwrapMessage(internals.def?.error?.(raw)) ?? zod3DefaultMessage(template) });
    }
  }
  return out;
}

/**
 * Per-parse zod 4 error map that produces zod 3's English messages and records
 * each issue's zod 3 form (see the module comment). Pass it as
 * `zod3IssueParams`; do not install it globally with `z.config()`.
 */
export const zod3ErrorMap: z.core.$ZodErrorMap = (rawIssue) => {
  const issue = rawIssue as unknown as AnyIssue;
  const input: InputValue = "input" in issue ? issue.input : NO_INPUT;
  const template = zod3Template(issue, input, issue.inst);
  if (!template) return undefined;
  recordTemplate(issue, template);
  const following = laterNumberCheckIssues(issue, input);
  if (following.length > 0) (issue as Record<string, unknown>)[ZOD3_FOLLOWING_ISSUES_KEY] = following;
  return zod3DefaultMessage(template);
};

/** Parse params for client input whose issues are returned in API responses. */
export const zod3IssueParams = { error: zod3ErrorMap } as const satisfies z.core.ParseContext<z.core.$ZodIssue>;

/**
 * zod 3's `required_error`: a type-level error map that uses `message` when
 * the value is missing and zod 3's default message otherwise, e.g.
 * `z.string({ error: zod3RequiredError("Host is required.") })`.
 */
export function zod3RequiredError(message: string): z.core.$ZodErrorMap {
  return (rawIssue) => {
    const issue = rawIssue as unknown as AnyIssue;
    if (issue.code === "invalid_type" && issue.input === undefined) {
      const template = zod3Template(issue, undefined, issue.inst);
      if (template) recordTemplate(issue, template);
      return message;
    }
    return undefined;
  };
}

function fillTemplate(template: Zod3Template, path: Zod3IssuePath, message: string): Zod3Issue {
  // zod 3 built issues as `{ ...issueData, path, message }`: a `message` key
  // that was part of the issue data keeps its position, `path` follows.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (key === "message") out.message = message;
    else if (key !== "path" && value !== undefined) out[key] = value;
  }
  out.path = path;
  if (!("message" in out)) out.message = message;
  return out as Zod3Issue;
}

function convertIssue(issue: AnyIssue, parentPath: readonly PropertyKey[]): Zod3Issue[] {
  const path = prefixPath(parentPath, issue.path);
  const message = typeof issue.message === "string" ? issue.message : "Invalid input";

  if (issue.code === "invalid_key" || issue.code === "invalid_element") {
    // zod 3 reported record/map key and element failures as the inner issues.
    const nested = Array.isArray(issue.issues) ? (issue.issues as AnyIssue[]) : [];
    return inZod3Order(nested).flatMap((inner) => convertIssue(inner, path));
  }

  const recorded = issue[ZOD3_ISSUE_KEY];
  const template =
    recorded && typeof recorded === "object" ? (recorded as Zod3Template) : zod3Template(issue, NO_INPUT, undefined);

  if (!template) {
    // custom (refine/superRefine/addIssue) and unknown codes: zod 3 and zod 4
    // share the shape; drop zod 4-only bookkeeping.
    // zod 3 refinements built `{ code, message, ...params }` and appended `path`.
    const {
      [ZOD3_ISSUE_KEY]: _recorded,
      [ZOD3_FOLLOWING_ISSUES_KEY]: _following,
      input: _input,
      path: _path,
      message: _message,
      code,
      ...rest
    } = issue;
    return [{ code: String(code ?? "custom"), message, ...rest, path } as Zod3Issue];
  }

  const converted = fillTemplate(template, path, message);
  if (converted.code === "invalid_union") {
    const branches = Array.isArray(issue.errors) ? (issue.errors as AnyIssue[][]) : [];
    const branchIssues = branches.map((branch) => inZod3Order(branch).flatMap((inner) => convertIssue(inner, path)));
    // zod 3 returned the issues of the first option that failed without
    // aborting ("dirty": it had the right type and failed only checks or
    // refinements); zod 4 treats some of those failures as aborting (`.int()`)
    // or reports invalid_union when two or more options are dirty.
    const dirty = branchIssues.find((issues) => issues.length > 0 && !issues.some(zod3IssueAborts));
    if (dirty) return dirty;
    const unionErrors: Zod3SerializedError[] = branchIssues
      .filter((issues) => issues.length > 0)
      .map((issues) => ({ issues, name: "ZodError" }));
    return [{ code: "invalid_union", unionErrors, path, message }];
  }
  const following = Array.isArray(issue[ZOD3_FOLLOWING_ISSUES_KEY])
    ? (issue[ZOD3_FOLLOWING_ISSUES_KEY] as Array<{ template: Zod3Template; message: string }>)
    : [];
  return [converted, ...following.map((entry) => fillTemplate(entry.template, path, entry.message))];
}

// zod 3 issue codes whose schema returned INVALID (aborted) instead of a
// "dirty" result; an aborted field also aborts its object, array or union.
const ZOD3_ABORTING_CODES = new Set([
  "invalid_type",
  "invalid_literal",
  "invalid_enum_value",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_date",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_intersection_types",
]);

function zod3IssueAborts(issue: Zod3Issue) {
  // zod 3's `.int()` was a check: a float failed it without aborting.
  if (issue.code === "invalid_type") return !(issue.expected === "integer" && issue.received === "float");
  return ZOD3_ABORTING_CODES.has(issue.code);
}

// zod 4 `origin` of a length (`.min()`/`.max()`/`.length()`/`.nonempty()`) or
// size check; number and date bounds use other origins.
const LENGTH_OR_SIZE_ORIGINS = new Set(["string", "array", "set", "map", "file", "unknown"]);

function isLengthOrSizeIssue(issue: AnyIssue) {
  return (issue.code === "too_small" || issue.code === "too_big") && LENGTH_OR_SIZE_ORIGINS.has(String(issue.origin ?? ""));
}

function extendsPath(prefix: readonly PropertyKey[] | undefined, path: readonly PropertyKey[] | undefined) {
  const head = prefix ?? [];
  const full = path ?? [];
  return full.length > head.length && head.every((segment, index) => segment === full[index]);
}

/**
 * Puts one list of sibling zod 4 issues (a parse result or one union branch)
 * into the set and order zod 3 reported:
 * - zod 4 runs length/size checks (they carry a `when` guard) on any value
 *   with a `length`/`size`, even after the type check failed, so `[]` sent to
 *   `z.string().min(1)` also gets "Array must contain at least 1
 *   element(s)". zod 3 stopped at the type error, so a length/size issue that
 *   follows an `invalid_type` issue at the same path is dropped.
 * - zod 4 runs an array's size checks after parsing its elements; zod 3 ran
 *   them first. The size issue is moved ahead of the element issues directly
 *   before it.
 */
function inZod3Order(issues: readonly AnyIssue[]): AnyIssue[] {
  // Index earlier type errors by their exact path instead of rescanning a
  // growing prefix for every size error (quadratic for large invalid arrays).
  type TypeErrorPath = { children: Map<PropertyKey, TypeErrorPath>; invalid: boolean };
  const typeErrors: TypeErrorPath = { children: new Map(), invalid: false };
  // Moving a bound before its contiguous descendant block must not splice a
  // growing array either. A linked list makes each block insertion constant
  // time once its start has been found. Nested bounds visit their descendants
  // only along schema ancestry, rather than shifting all unrelated siblings.
  type Node = { issue: AnyIssue; previous?: Node; next?: Node };
  let head: Node | undefined;
  let tail: Node | undefined;
  for (const issue of issues) {
    const size = isLengthOrSizeIssue(issue);
    if (size || issue.code === "invalid_type") {
      let entry = typeErrors;
      for (const segment of issue.path ?? []) {
        let child = entry.children.get(segment);
        if (!child) {
          child = { children: new Map(), invalid: false };
          entry.children.set(segment, child);
        }
        entry = child;
      }
      if (size && entry.invalid) continue;
      if (issue.code === "invalid_type") entry.invalid = true;
    }
    const node: Node = { issue };
    let following: Node | undefined;
    if (size && issue.origin === "array") {
      let candidate = tail;
      while (candidate && extendsPath(issue.path, candidate.issue.path)) {
        following = candidate;
        candidate = candidate.previous;
      }
    }
    if (following) {
      node.previous = following.previous;
      node.next = following;
      if (following.previous) following.previous.next = node;
      else head = node;
      following.previous = node;
    } else {
      node.previous = tail;
      if (tail) tail.next = node;
      else head = node;
      tail = node;
    }
  }
  const ordered: AnyIssue[] = [];
  for (let node = head; node; node = node.next) ordered.push(node.issue);
  return ordered;
}

/**
 * Converts zod 4 issues (e.g. `error.issues`) to the zod 3 issue objects the
 * API has always returned.
 */
export function toZod3Issues(issues: readonly z.core.$ZodIssue[] | readonly unknown[]): Zod3Issue[] {
  return inZod3Order(issues as readonly AnyIssue[]).flatMap((issue) => convertIssue(issue, []));
}

/** zod 3's `error.flatten()` result. */
export interface Zod3FlattenedError {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

/** zod 3's `error.flatten()` over the zod 3 form of `issues`. */
export function flattenZod3Issues(issues: readonly z.core.$ZodIssue[] | readonly unknown[]): Zod3FlattenedError {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of toZod3Issues(issues)) {
    if (issue.path.length > 0) {
      const key = String(issue.path[0]);
      (fieldErrors[key] ??= []).push(issue.message);
    } else {
      formErrors.push(issue.message);
    }
  }
  return { formErrors, fieldErrors };
}

/**
 * True for any zod 4 `ZodError` (also one created by another zod copy, which
 * `instanceof` may not recognise).
 */
export function isZodError(value: unknown): value is z.ZodError {
  if (value instanceof z.ZodError) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; issues?: unknown };
  return (candidate.name === "ZodError" || candidate.name === "$ZodError") && Array.isArray(candidate.issues);
}
