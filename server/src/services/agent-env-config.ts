/**
 * Environment-binding helpers for agent adapter config.
 *
 * `PATCH /api/agents/:id` used to replace the whole `adapterConfig.env` map
 * whenever a request carried one. A request that mentioned a single env key
 * therefore deleted every other binding, including the `secret_ref` bindings
 * that hold an agent's credentials. The helpers here make the map merge per
 * key, so an omitted key keeps its stored value, and they make an intentional
 * removal explicit.
 */

/** Environment variable names are POSIX-style identifiers. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The env key that carries the fixed Claude Code OAuth binding. */
export const CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

export type AgentEnvBindings = Record<string, unknown>;

export interface AgentEnvMergeInput {
  /** The stored env map. */
  existingEnv: unknown;
  /** The env map carried by the request. `null`/`undefined` means "not sent". */
  requestedEnv: unknown;
  /** Env keys the caller explicitly asked to remove. */
  removedKeys?: readonly string[];
}

export interface AgentEnvMergeResult {
  /** The effective env map to persist. */
  env: AgentEnvBindings;
  /** Keys the request added (they were not stored before). */
  addedKeys: string[];
  /** Keys the request changed. */
  updatedKeys: string[];
  /** Keys the request omitted; their stored values are preserved. */
  preservedKeys: string[];
  /** Keys removed by an explicit removal request. */
  removedKeys: string[];
}

export function asEnvRecord(value: unknown): AgentEnvBindings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as AgentEnvBindings;
}

function sameBinding(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Merge a requested env map over the stored one, per key.
 *
 * - A key present in the request wins.
 * - A key missing from the request keeps its stored value. This is the fix for
 *   the silent credential loss: a partial env map can no longer delete the
 *   bindings it does not mention.
 * - A key listed in `removedKeys` is deleted. Removal is only ever explicit.
 */
export function mergeAgentEnvBindings(input: AgentEnvMergeInput): AgentEnvMergeResult {
  const existing = asEnvRecord(input.existingEnv) ?? {};
  const requested = asEnvRecord(input.requestedEnv);
  const env: AgentEnvBindings = { ...existing };
  const addedKeys: string[] = [];
  const updatedKeys: string[] = [];
  const preservedKeys: string[] = [];

  if (requested) {
    for (const [key, binding] of Object.entries(requested)) {
      if (!Object.prototype.hasOwnProperty.call(existing, key)) {
        addedKeys.push(key);
      } else if (!sameBinding(existing[key], binding)) {
        updatedKeys.push(key);
      }
      env[key] = binding;
    }
    for (const key of Object.keys(existing)) {
      if (!Object.prototype.hasOwnProperty.call(requested, key)) preservedKeys.push(key);
    }
  } else {
    preservedKeys.push(...Object.keys(existing));
  }

  const removedKeys: string[] = [];
  for (const key of input.removedKeys ?? []) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) continue;
    delete env[key];
    removedKeys.push(key);
  }

  return { env, addedKeys, updatedKeys, preservedKeys, removedKeys };
}

export type EnvBindingKind = "plain" | "secret_ref" | "user_secret_ref" | "unknown";

/** Classify an env binding. Only the kind is returned, never the value. */
export function envBindingKind(binding: unknown): EnvBindingKind {
  if (typeof binding === "string") return "plain";
  if (typeof binding !== "object" || binding === null) return "unknown";
  const type = (binding as { type?: unknown }).type;
  if (type === "plain") return "plain";
  if (type === "secret_ref") return "secret_ref";
  if (type === "user_secret_ref") return "user_secret_ref";
  return "unknown";
}

/** True when the binding points at a secret rather than holding a plain value. */
export function isSecretEnvBinding(binding: unknown): boolean {
  const kind = envBindingKind(binding);
  return kind === "secret_ref" || kind === "user_secret_ref";
}

/**
 * True when the binding is the exact fixed Claude Code OAuth user-secret
 * reference. The fixed binding is a `user_secret_ref` whose key is the fixed
 * key. Any other shape (a plain value, a company secret reference, or a
 * different user-secret key) is a replacement or a weaker binding.
 */
export function isFixedClaudeOAuthEnvBinding(binding: unknown): boolean {
  if (typeof binding !== "object" || binding === null) return false;
  const record = binding as Record<string, unknown>;
  return record.type === "user_secret_ref" && record.key === CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY;
}

/**
 * Env keys whose stored secret binding would disappear without an explicit
 * removal request. A plain binding can be dropped by a client that rebuilds
 * its config from scratch; a secret binding cannot, because the drop silently
 * unbinds a credential.
 */
export function findSilentSecretBindingRemovals(input: {
  existingEnv: unknown;
  nextEnv: unknown;
  authorizedRemovals?: readonly string[];
}): string[] {
  const existing = asEnvRecord(input.existingEnv);
  const next = asEnvRecord(input.nextEnv);
  if (!existing) return [];
  const authorized = new Set(input.authorizedRemovals ?? []);
  return Object.keys(existing).filter((key) => {
    if (next && Object.prototype.hasOwnProperty.call(next, key)) return false;
    if (authorized.has(key)) return false;
    return isSecretEnvBinding(existing[key]);
  });
}

/**
 * Validate an explicit removal request against the stored env map.
 *
 * Returns the list of keys to remove. Throws the caller's error for a key that
 * is not a valid env name, that is not stored, or that the same request also
 * tries to set.
 */
export function assertValidEnvRemovalRequest(input: {
  existingEnv: unknown;
  requestedEnv: unknown;
  removedKeys: readonly string[];
  invalidNameError: (key: string) => Error;
  unknownKeyError: (key: string) => Error;
  conflictingKeyError: (key: string) => Error;
}): string[] {
  const existing = asEnvRecord(input.existingEnv);
  const requested = asEnvRecord(input.requestedEnv);
  const removals: string[] = [];
  for (const rawKey of input.removedKeys) {
    const key = rawKey.trim();
    if (!key || !ENV_KEY_RE.test(key)) throw input.invalidNameError(rawKey);
    if (!existing || !Object.prototype.hasOwnProperty.call(existing, key)) {
      throw input.unknownKeyError(key);
    }
    if (requested && Object.prototype.hasOwnProperty.call(requested, key)) {
      throw input.conflictingKeyError(key);
    }
    if (!removals.includes(key)) removals.push(key);
  }
  return removals;
}
