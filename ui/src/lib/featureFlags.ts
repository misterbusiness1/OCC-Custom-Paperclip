/**
 * Lightweight, dependency-free feature-flag resolution for the UI.
 *
 * Flags are addressed by their canonical dotted name (e.g.
 * `paperclip.approvals.decisionCard`). Resolution precedence, highest first:
 *   1. a `localStorage` override at key `paperclip.flags.<flag>` (per-browser QA/dev toggle)
 *   2. the build-time env var mapped in {@link ENV_VAR_BY_FLAG}
 *   3. a hard default of `false` (every flag ships off)
 *
 * The pure {@link resolveFeatureFlag} / {@link coerceFlag} helpers carry all the
 * logic so they can be unit-tested without a DOM or a Vite env.
 */

export const FeatureFlags = {
  /** Board Approval decision-card redesign (OXFA-2799 / OXFA-2798). */
  approvalsDecisionCard: "paperclip.approvals.decisionCard",
} as const;

export type FeatureFlagName = (typeof FeatureFlags)[keyof typeof FeatureFlags];

/** Maps a dotted flag name to its build-time (`VITE_`) env var. */
const ENV_VAR_BY_FLAG: Record<string, string> = {
  [FeatureFlags.approvalsDecisionCard]: "VITE_APPROVALS_DECISION_CARD",
};

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled", ""]);

/** Parse a raw string toggle into a boolean, or `null` when unset/unrecognised. */
export function coerceFlag(value: string | null | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return null;
}

/** Pure precedence resolver: override, then env, then default-off. */
export function resolveFeatureFlag(sources: {
  override?: string | null;
  env?: string | null;
}): boolean {
  return coerceFlag(sources.override) ?? coerceFlag(sources.env) ?? false;
}

function readEnv(flag: string): string | null {
  const key = ENV_VAR_BY_FLAG[flag];
  if (!key) return null;
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return env?.[key] ?? null;
  } catch {
    return null;
  }
}

function readOverride(flag: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(`paperclip.flags.${flag}`);
  } catch {
    return null;
  }
}

/** Resolve a flag against the live browser environment. */
export function isFeatureEnabled(flag: string): boolean {
  return resolveFeatureFlag({ override: readOverride(flag), env: readEnv(flag) });
}

/**
 * React hook wrapper. Flags are resolved from build-time env + localStorage, both
 * static for the lifetime of a page load, so a plain read is sufficient and avoids
 * subscribing components to a store that never changes mid-session.
 */
export function useFeatureFlag(flag: string): boolean {
  return isFeatureEnabled(flag);
}
