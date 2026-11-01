import type { AdapterRegistryEntry } from "./adapter-registry.js";

export interface AdapterDefaults {
  runtimeImage: string;
  envKeys: string[];
  allowFqdns: string[];
  probeCommand: string[];
  /** Non-secret env injected as the base layer for the Job (process-env wins on top). */
  defaultEnv?: Record<string, string>;
}

const REGISTRY: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["claude", "--version"],
  },
  codex_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-codex:v1",
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
    probeCommand: ["codex", "--version"],
  },
  gemini_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-gemini:v1",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    allowFqdns: ["generativelanguage.googleapis.com"],
    probeCommand: ["gemini", "--version"],
  },
  opencode_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-opencode:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "openrouter.ai"],
    probeCommand: ["opencode", "--version"],
  },
  pi_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-pi:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["pi", "--version"],
  },
};

/**
 * Adapter types the config schema accepts that ship NO built-in runtime
 * defaults: they only run when a declarative `adapters` registry entry supplies
 * runtimeImage / envKeys / allowFqdns. The value is the actionable error raised
 * when no such entry is configured.
 *
 * Cursor (Paperclip adapter type "cursor") is registry-only because no
 * agent-runtime-cursor image is built or published (docker/agent-runtime has no
 * Cursor target); built-in defaults would only ever end in ImagePullBackOff.
 */
const REGISTRY_ONLY_ADAPTER_TYPES: ReadonlyMap<string, string> = new Map([
  [
    "cursor",
    'Cursor has no built-in Kubernetes runtime image; add an adapters registry entry for "cursor" with runtimeImage, envKeys (CURSOR_API_KEY) and allowFqdns (the Cursor backend hosts)',
  ],
]);

/** Legacy adapter-type keys mapped to Paperclip's canonical adapter type. */
const ADAPTER_TYPE_ALIASES: ReadonlyMap<string, string> = new Map([["cursor_local", "cursor"]]);

/**
 * Map a legacy alias (e.g. "cursor_local") to Paperclip's canonical adapter
 * type ("cursor"); any other value is returned unchanged. Applied by the config
 * schema and before every registry lookup / label so an alias behaves exactly
 * like its canonical type.
 */
export function normalizeAdapterType(adapterType: string): string {
  return ADAPTER_TYPE_ALIASES.get(adapterType) ?? adapterType;
}

/** Canonical adapter types accepted by the config schema (aliases normalise onto these). */
export const KNOWN_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(REGISTRY),
  ...REGISTRY_ONLY_ADAPTER_TYPES.keys(),
]);

/** `type` is the canonical (normalised) adapter type the entry was matched for. */
function fromRegistryEntry(entry: AdapterRegistryEntry, type: string): AdapterDefaults {
  // Only runtimeImage is strictly required. The array fields are optional and
  // default to []: the operator emits them with `omitempty`, so a genuinely
  // empty allowFqdns/envKeys/probeCommand arrives as undefined, which is valid
  // (no extra egress / no forwarded secrets / no probe), NOT an error.
  if (!entry.runtimeImage) {
    throw new Error(`Adapter "${type}" is missing required runtime field: runtimeImage`);
  }
  return {
    runtimeImage: entry.runtimeImage,
    envKeys: entry.envKeys ?? [],
    allowFqdns: entry.allowFqdns ?? [],
    probeCommand: entry.probeCommand ?? [],
    defaultEnv: entry.defaultEnv,
  };
}

/**
 * Resolve the runtime defaults for an adapter. When a `registry` is supplied it
 * is authoritative (replace semantics): the type MUST be present exactly once
 * (counting aliases) and complete, else this throws. With no registry, falls
 * back to the built-in REGISTRY; registry-only types (e.g. "cursor") throw an
 * actionable error there. Legacy aliases are normalised on both sides of the
 * registry lookup.
 */
export function getAdapterDefaults(
  adapterType: string,
  registry?: readonly AdapterRegistryEntry[],
): AdapterDefaults {
  const type = normalizeAdapterType(adapterType);
  const registryOnlyHint = REGISTRY_ONLY_ADAPTER_TYPES.get(type);
  if (registry && registry.length > 0) {
    const entries = registry.filter((e) => normalizeAdapterType(e.adapterType) === type);
    if (entries.length === 0) {
      const base = `Adapter "${type}" is not in the configured adapter registry`;
      throw new Error(registryOnlyHint ? `${base}. ${registryOnlyHint}` : base);
    }
    if (entries.length > 1) {
      // e.g. both "cursor" and the legacy "cursor_local": refuse to pick one silently.
      throw new Error(
        `Adapter "${type}" has ${entries.length} entries in the configured adapter registry (${entries
          .map((e) => `"${e.adapterType}"`)
          .join(", ")}); keep exactly one`,
      );
    }
    return fromRegistryEntry(entries[0], type);
  }
  if (registryOnlyHint) {
    throw new Error(registryOnlyHint);
  }
  // Own-property lookup: a run hint such as "constructor" or "toString" must not
  // resolve to an Object.prototype member.
  const defaults = Object.hasOwn(REGISTRY, type) ? REGISTRY[type] : undefined;
  if (!defaults) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return defaults;
}

/**
 * Resolve the adapter type for a single run: prefer the run's adapter (the agent's,
 * from the lease params) so one environment can serve mixed harnesses; fall back to
 * the environment's configured default adapter when the run does not specify one.
 * The result is normalised (legacy aliases -> canonical type), so labels and
 * registry lookups downstream never see an alias.
 */
export function resolveRunAdapterType(
  runAdapterType: string | null | undefined,
  configAdapterType: string,
): string {
  const trimmed = typeof runAdapterType === "string" ? runAdapterType.trim() : "";
  return normalizeAdapterType(trimmed.length > 0 ? trimmed : configAdapterType);
}

/**
 * Build the per-run env for the Job: the non-secret `defaultEnv` is the base
 * and the process-env values (the secret API keys named by `envKeys`) override
 * it. Pure for testability.
 */
export function buildAdapterEnv(
  defaults: AdapterDefaults,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...(defaults.defaultEnv ?? {}) };
  for (const k of defaults.envKeys) {
    const v = processEnv[k];
    if (v) out[k] = v;
  }
  return out;
}
