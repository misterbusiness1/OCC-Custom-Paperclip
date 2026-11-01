import type { Request } from "express";
import { forbidden, unprocessable } from "../errors.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";

// Guards on agent adapter configuration shared by the agent routes and by
// hire_agent approvals (which become agents when approved). Kept free of the
// adapter registry so the approvals router can use it without loading every
// adapter package.

// Legacy hardcoded map — used as fallback when adapter module does not
// declare capability flags explicitly.
export const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
  claude_local: "instructionsFilePath",
  codex_local: "instructionsFilePath",
  droid_local: "instructionsFilePath",
  gemini_local: "instructionsFilePath",
  opencode_local: "instructionsFilePath",
  cursor: "instructionsFilePath",
  pi_local: "instructionsFilePath",
};
const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));

export const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Check if an adapter supports the managed instructions bundle. `adapter` is
 * the active server adapter module for `adapterType`, if any.
 */
export function supportsManagedInstructionsBundle(
  adapterType: string,
  adapter: { supportsInstructionsBundle?: boolean } | null | undefined,
): boolean {
  if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
  return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
}

export function assertNoLegacyPromptTemplateForNewAgent(
  supportsInstructionsBundle: boolean,
  adapterConfig: Record<string, unknown>,
) {
  if (!supportsInstructionsBundle) return;
  if (
    Object.prototype.hasOwnProperty.call(adapterConfig, "promptTemplate")
    || Object.prototype.hasOwnProperty.call(adapterConfig, "bootstrapPromptTemplate")
  ) {
    throw unprocessable(
      "New agents must use instructionsBundle/AGENTS.md instead of adapterConfig.promptTemplate or bootstrapPromptTemplate",
    );
  }
}

export function listRuntimeModelProfileAdapterConfigs(
  runtimeConfig: unknown,
  pathPrefix = "runtimeConfig",
): Array<{
  profileKey: string;
  profile: Record<string, unknown>;
  adapterConfig: Record<string, unknown>;
  path: string;
}> {
  const runtimeRecord = asRecord(runtimeConfig);
  const modelProfiles = asRecord(runtimeRecord?.modelProfiles);
  if (!modelProfiles) return [];

  const entries: Array<{
    profileKey: string;
    profile: Record<string, unknown>;
    adapterConfig: Record<string, unknown>;
    path: string;
  }> = [];
  for (const [profileKey, rawProfile] of Object.entries(modelProfiles)) {
    const profile = asRecord(rawProfile);
    const adapterConfig = asRecord(profile?.adapterConfig);
    if (!profile || !adapterConfig) continue;
    entries.push({
      profileKey,
      profile,
      adapterConfig,
      path: `${pathPrefix}.modelProfiles.${profileKey}.adapterConfig`,
    });
  }
  return entries;
}

export function assertNoAgentInstructionsConfigMutation(
  req: Request,
  adapterConfig: Record<string, unknown> | null | undefined,
  path = "adapterConfig",
) {
  if (req.actor.type !== "agent" || !adapterConfig) return;
  const changedSensitiveKeys = KNOWN_INSTRUCTIONS_BUNDLE_KEYS
    .filter((key) => adapterConfig[key] !== undefined)
    .map((key) => `${path}.${key}`);
  if (changedSensitiveKeys.length === 0) return;
  throw forbidden(
    `Agent-authenticated callers cannot modify instructions path or bundle configuration (${changedSensitiveKeys.join(", ")})`,
  );
}

export function assertNoAgentAdapterConfigMutation(
  req: Request,
  adapterConfig: Record<string, unknown>,
  path = "adapterConfig",
) {
  assertNoAgentInstructionsConfigMutation(req, adapterConfig, path);
  assertNoAgentHostWorkspaceCommandMutation(
    req,
    collectAgentAdapterWorkspaceCommandPaths(adapterConfig, path),
  );
}

export function assertNoAgentRuntimeConfigAdapterConfigMutation(
  req: Request,
  runtimeConfig: unknown,
  pathPrefix = "runtimeConfig",
) {
  for (const entry of listRuntimeModelProfileAdapterConfigs(runtimeConfig, pathPrefix)) {
    assertNoAgentAdapterConfigMutation(req, entry.adapterConfig, entry.path);
  }
}
