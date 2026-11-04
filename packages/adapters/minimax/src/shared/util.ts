// Small shared string helpers used by the server runtime and the environment
// probe so the same coercion semantics apply everywhere.

export function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

// Extract a string from an adapter env binding, which at runtime is a resolved
// plain string but may also arrive as a { value } / { secretValue } object on
// some paths (e.g. the environment-test draft). Returns null when absent.
export function readAdapterEnvString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.value === "string") return rec.value.trim() || null;
    if (typeof rec.secretValue === "string") return rec.secretValue.trim() || null;
  }
  return null;
}
