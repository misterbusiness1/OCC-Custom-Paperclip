/**
 * @fileoverview Validates plugin instance configuration against its JSON Schema.
 *
 * Uses Ajv to validate `configJson` values against the `instanceConfigSchema`
 * declared in a plugin's manifest. This ensures that invalid configuration is
 * rejected at the API boundary, not discovered later at worker startup.
 *
 * @module server/services/plugin-config-validator
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { envBindingSecretRefSchema, type JsonSchema } from "@paperclipai/shared";

export interface ConfigValidationResult {
  valid: boolean;
  errors?: { field: string; message: string }[];
}

// Plugin manifests use format:secret-ref as a UI annotation, historically on a
// string schema. The persisted value is the shared managed binding object, not
// a string or resolved credential. Adapt only schema positions, never config
// data (or object literals in enum/default), so storage and worker delivery keep
// the exact binding and version supplied by the caller.
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaValues = new Set(["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else"]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function managedSecretSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const node = schema as Record<string, unknown>;
  const result: Record<string, unknown> = { ...node };
  for (const [key, value] of Object.entries(node)) {
    if (schemaMaps.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, managedSecretSchema(child)]));
    } else if (schemaLists.has(key) && Array.isArray(value)) {
      result[key] = value.map(managedSecretSchema);
    } else if (schemaValues.has(key)) {
      result[key] = Array.isArray(value) ? value.map(managedSecretSchema) : managedSecretSchema(value);
    } else if (key === "dependencies" && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, managedSecretSchema(child)]));
    }
  }
  if (node.format === "secret-ref") {
    delete result.format;
    // Keep scalar constraints in the schema. They apply only to strings under
    // JSON Schema; the keyword below rejects all strings. Parent required,
    // enum/const, combinators and additionalProperties still apply normally.
    if (node.type === "string" || node.type === undefined) result.type = ["string", "object"];
    else if (Array.isArray(node.type) && node.type.includes("string")) result.type = [...new Set([...node.type, "object"])];
    result.paperclipManagedSecretRef = true;
  }
  return result;
}

/**
 * Validate a config object against a JSON Schema.
 *
 * @param configJson - The configuration values to validate.
 * @param schema - The JSON Schema from the plugin manifest's `instanceConfigSchema`.
 * @returns Validation result with structured field errors on failure.
 */
export function validateInstanceConfig(
  configJson: Record<string, unknown>,
  schema: JsonSchema,
): ConfigValidationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  const ajv = new AjvCtor({ allErrors: true, allowUnionTypes: true });
  // ajv-formats v3 default export is a FormatsPlugin object; call it as a plugin.
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  ajv.addKeyword({
    keyword: "paperclipManagedSecretRef",
    schemaType: "boolean",
    errors: false,
    validate: (_enabled: boolean, value: unknown) => envBindingSecretRefSchema.strict().safeParse(value).success,
  });
  const validate = ajv.compile(managedSecretSchema(schema));
  const valid = validate(configJson);

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map((err: ErrorObject) => ({
    field: err.instancePath || "/",
    message: err.message ?? "validation failed",
  }));

  return { valid: false, errors };
}
