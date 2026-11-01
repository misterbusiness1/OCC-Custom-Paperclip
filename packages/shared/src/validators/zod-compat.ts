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
