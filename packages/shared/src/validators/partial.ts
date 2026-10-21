import { z } from "zod";

// Remove each `.default()` wrapper from one field. The wrapper can sit at the
// top, or under an `.optional()` or `.nullable()` wrapper, so this walks the
// chain and keeps the `optional`/`nullable` wrappers. The field then has no
// default at any level of the outer chain.
function fieldWithoutDefault(field: z.ZodTypeAny): z.ZodTypeAny {
  if (field instanceof z.ZodDefault) {
    return fieldWithoutDefault(field.unwrap() as z.ZodTypeAny);
  }
  if (field instanceof z.ZodOptional) {
    return z.optional(fieldWithoutDefault(field.unwrap() as z.ZodTypeAny));
  }
  if (field instanceof z.ZodNullable) {
    return z.nullable(fieldWithoutDefault(field.unwrap() as z.ZodTypeAny));
  }
  return field;
}

// Zod 4 keeps a field `.default()` active after `.partial()`. A patch parse then
// fills the default for an absent key. The merge then overwrites a stored value
// that the caller did not send. A patch schema must keep only the keys the
// caller sends. This helper removes each top-level field default from an object
// shape. `.partial()` then leaves an absent key absent.
export function shapeWithoutDefaults(shape: z.ZodRawShape): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      fieldWithoutDefault(field as z.ZodTypeAny),
    ]),
  );
}

// Read the catchall off an object schema, if it has one. Zod keeps it on the
// object definition.
function catchallOf(schema: z.ZodObject<z.ZodRawShape>): z.ZodTypeAny | undefined {
  const def = (schema as unknown as { _zod?: { def?: { catchall?: z.ZodTypeAny } } })._zod?.def;
  const catchall = def?.catchall;
  return catchall && typeof catchall === "object" ? catchall : undefined;
}

// Build a patch object schema from a base object schema. The result drops each
// top-level `.default()`, so a `.partial()` parse keeps only the keys the caller
// sends. Chain `.partial()` and any `.extend()`/`.refine()` on the result.
//
// The source schema's catchall is carried over. Rebuilding the object without it
// would strip every unknown top-level field from a parsed body, so a field a
// caller sends that the schema does not know about would be dropped before the
// handler ever sees it - a new field on a request body would be silently
// ignored instead of reaching the route. That is how `envRemovedKeys` was
// swallowed on the agent update schema: the route implemented the removal, the
// schema had no field for it, and the removal request was a silent no-op.
export function objectWithoutDefaults<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodObject<T> {
  const rebuilt = z.object(shapeWithoutDefaults(schema.shape)) as unknown as z.ZodObject<T>;
  const catchall = catchallOf(schema);
  return catchall ? (rebuilt.catchall(catchall) as unknown as z.ZodObject<T>) : rebuilt;
}
