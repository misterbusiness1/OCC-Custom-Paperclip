import { z } from "zod";

/**
 * Helpers that keep zod 3 behaviour where zod 4 changed it silently.
 *
 * Paperclip moved from zod 3.25 to zod 4. Two zod 4 changes alter what the API
 * accepts or stores without any type error, so the affected schemas go
 * through these helpers instead of plain zod calls:
 *
 * 1. zod 4 applies a `.default()`/`.prefault()` that sits under `.optional()`
 *    when the key is omitted; zod 3 left the key absent. Update/PATCH schemas
 *    built with `.partial()` from create schemas would otherwise start
 *    writing every default the caller never sent.
 *    `withoutFieldDefaults` / `withoutOptionalDefault` remove exactly those
 *    defaults, so an omitted key stays omitted.
 * 2. zod 4's `.datetime()` requires seconds whenever the value carries `Z` or
 *    an offset and only accepts `+HH:MM` offsets; zod 3 accepted
 *    `2026-10-31T12:00Z` and `+0200`. `datetimeString` keeps zod 3's rules.
 * 3. zod 4's `.url()` rewrites the value it returns (trims it and strips tabs
 *    and newlines); zod 3 validated with `new URL()` and returned the input
 *    unchanged. `urlString` keeps zod 3's behaviour, so stored URLs do not
 *    change shape.
 */

type AnyZod = z.ZodType;

function withMetadataOf<T extends AnyZod>(source: AnyZod, target: T): T {
  const metadata = z.globalRegistry.get(source);
  if (!metadata) return target;
  return target.meta({ ...metadata }) as T;
}

function stripUnderOptional(schema: AnyZod, underOptional: boolean): AnyZod {
  if (schema instanceof z.ZodOptional) {
    const inner = schema.unwrap() as AnyZod;
    const next = stripUnderOptional(inner, true);
    if (next === inner) return schema;
    return withMetadataOf(schema, next instanceof z.ZodOptional ? next : next.optional());
  }
  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as AnyZod;
    const next = stripUnderOptional(inner, underOptional);
    if (next === inner) return schema;
    return withMetadataOf(schema, next.nullable());
  }
  if (schema instanceof z.ZodReadonly) {
    const inner = schema.unwrap() as AnyZod;
    const next = stripUnderOptional(inner, underOptional);
    if (next === inner) return schema;
    return withMetadataOf(schema, next.readonly());
  }
  if (underOptional && (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault)) {
    const inner = schema.unwrap() as AnyZod;
    return withMetadataOf(schema, stripUnderOptional(inner, true));
  }
  return schema;
}

/**
 * Removes any `.default()`/`.prefault()` that sits under an `.optional()`
 * wrapper of `field` (also through `.nullable()`/`.readonly()`), keeping the
 * optional/nullable wrappers and any `.describe()`/`.meta()` metadata. A
 * default that is not under `.optional()` (for example `.optional().default(x)`)
 * is kept, because zod 3 applied that one too. Returns `field` itself when
 * nothing needs stripping.
 */
export function withoutOptionalDefault<T extends AnyZod>(field: T): T {
  return stripUnderOptional(field, false) as T;
}

/**
 * Returns `schema` with every top-level field passed through
 * `withoutOptionalDefault`, so parsing an object that omits a key never
 * injects a default, as in zod 3. Strictness/catchall and refinements are
 * kept (the shape is replaced with `safeExtend`). Use it on update/PATCH
 * schemas built with `.partial()` and on any object whose optional fields
 * reuse defaulted schemas.
 */
export function withoutFieldDefaults<T extends z.ZodObject>(schema: T): T {
  const replacements: Record<string, AnyZod> = {};
  for (const [key, field] of Object.entries(schema.shape as Record<string, AnyZod>)) {
    const next = withoutOptionalDefault(field);
    if (next !== field) replacements[key] = next;
  }
  if (Object.keys(replacements).length === 0) return schema;
  return withMetadataOf(schema, schema.safeExtend(replacements)) as unknown as T;
}

// zod 3.25.76's ISO datetime grammar (precision unset, local: false): seconds
// and fractional seconds are optional, the date part checks month lengths and
// leap years, and `offset: true` adds `+HH:MM`, `+HHMM`, `-HH:MM`, `-HHMM`.
const ZOD3_DATE_SOURCE =
  "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))";
const ZOD3_TIME_SOURCE = "([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?";

export const ZOD3_DATETIME_REGEX = new RegExp(`^${ZOD3_DATE_SOURCE}T${ZOD3_TIME_SOURCE}(Z)$`);
export const ZOD3_DATETIME_OFFSET_REGEX = new RegExp(`^${ZOD3_DATE_SOURCE}T${ZOD3_TIME_SOURCE}(Z|([+-]\\d{2}:?\\d{2}))$`);

/**
 * An ISO 8601 datetime string with zod 3's acceptance rules. Use instead of
 * `z.string().datetime()` / `z.iso.datetime()`; pass `trim: true` for
 * `z.string().trim().datetime()`. The check reports the `datetime` string
 * format (the same way zod 4's own `.datetime()` attaches its format check),
 * so documentation and JSON Schema generators keep describing it as a
 * date-time, and a failure reads "Invalid datetime" as in zod 3.
 */
export function datetimeString(options: { offset?: boolean; trim?: boolean } = {}) {
  const base = options.trim ? z.string().trim() : z.string();
  return base.check(
    z.stringFormat("datetime", options.offset ? ZOD3_DATETIME_OFFSET_REGEX : ZOD3_DATETIME_REGEX, {
      error: "Invalid datetime",
    }),
  );
}

function isParseableUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A URL string with zod 3's rules: accepted when `new URL(value)` parses it,
 * returned unchanged. Use instead of `z.string().url()` / `z.url()`; pass
 * `trim: true` for `z.string().trim().url()`. Reports the `url` string format,
 * and a failure reads "Invalid url" as in zod 3.
 */
export function urlString(options: { trim?: boolean } = {}) {
  const base = options.trim ? z.string().trim() : z.string();
  return base.check(z.stringFormat("url", isParseableUrl, { error: "Invalid url" }));
}

// zod 3.25.76's `.uuid()` pattern: any 8-4-4-4-12 hex string, whatever its
// version and variant digits.
export const ZOD3_UUID_REGEX = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;

type IssuePath = readonly PropertyKey[];

function readAt(value: unknown, path: IssuePath): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function writeAt(value: unknown, path: IssuePath, next: unknown): boolean {
  if (path.length === 0) return false;
  const parent = readAt(value, path.slice(0, -1));
  if (parent === null || typeof parent !== "object") return false;
  (parent as Record<PropertyKey, unknown>)[path[path.length - 1]!] = next;
  return true;
}

function collectStrings(value: unknown, out: Set<string>, depth = 0) {
  if (typeof value === "string") out.add(value);
  else if (value && typeof value === "object" && depth < 64) {
    for (const entry of Object.values(value as Record<string, unknown>)) collectStrings(entry, out, depth + 1);
  }
  return out;
}

function replaceStrings<T>(value: T, replacements: ReadonlyMap<string, string>, depth = 0): T {
  if (typeof value === "string") return (replacements.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, replacements, depth + 1)) as T;
  if (value && typeof value === "object" && depth < 64 && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, replaceStrings(entry, replacements, depth + 1)]),
    ) as T;
  }
  return value;
}

/**
 * `schema.safeParse(value, params)` for data that was stored while the
 * schema still used zod 3's `.uuid()`, which accepted any 8-4-4-4-12 hex
 * string (for example `11111111-1111-1111-1111-111111111111`). Request input
 * is validated with strict RFC 9562 `z.uuid()`; rows written before the zod 4
 * migration may still hold such IDs, and re-validating them strictly on read
 * would turn a stored row into a 400/422 or silently drop it.
 *
 * When every issue of the strict parse is a UUID format failure on a value
 * zod 3 accepted, each such value is swapped for a unique RFC placeholder,
 * the value is parsed again, and the original strings are put back in the
 * output. Any other failure returns the strict result unchanged. Use it only
 * where stored rows are parsed, never for request input.
 */
export function safeParseStoredUuids<T extends z.ZodType>(
  schema: T,
  value: unknown,
  params?: z.core.ParseContext<z.core.$ZodIssue>,
): z.ZodSafeParseResult<z.output<T>> {
  const strict = schema.safeParse(value, params) as z.ZodSafeParseResult<z.output<T>>;
  if (strict.success) return strict;
  const issues = strict.error.issues;
  if (issues.length === 0 || !issues.every((issue) => issue.code === "invalid_format" && issue.format === "uuid")) {
    return strict;
  }
  const taken = collectStrings(value, new Set());
  const placeholders = new Map<string, string>();
  let counter = 0;
  const patched = structuredClone(value);
  for (const issue of issues) {
    const original = readAt(value, issue.path);
    if (typeof original !== "string" || !ZOD3_UUID_REGEX.test(original)) return strict;
    let placeholder = placeholders.get(original);
    if (!placeholder) {
      do {
        counter += 1;
        placeholder = `ffffffff-ffff-4fff-bfff-${counter.toString(16).padStart(12, "0")}`;
      } while (taken.has(placeholder));
      placeholders.set(original, placeholder);
      taken.add(placeholder);
    }
    if (!writeAt(patched, issue.path, placeholder)) return strict;
  }
  const lenient = schema.safeParse(patched, params) as z.ZodSafeParseResult<z.output<T>>;
  if (!lenient.success) return strict;
  const originals = new Map([...placeholders].map(([original, placeholder]) => [placeholder, original]));
  return { success: true, data: replaceStrings(lenient.data, originals) } as z.ZodSafeParseResult<z.output<T>>;
}
