import { and, eq } from "drizzle-orm";
import { userSecretDeclarations, type Db } from "@paperclipai/db";
import { envBindingSchema, type SecretBindingTargetType } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { createEffectiveRunConfigFingerprints } from "./effective-run-config-fingerprints.js";
import { secretService } from "./secrets.js";

export type ProviderCooldownSecretVersion = { secretId: string; version: number; envKey?: string | null };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sortedSecretVersions(versions: readonly ProviderCooldownSecretVersion[]) {
  return [...new Map(versions.map((entry) => [
    `${entry.secretId}:${entry.version}`,
    { secretId: entry.secretId, version: entry.version },
  ])).values()].sort((a, b) => a.secretId.localeCompare(b.secretId) || a.version - b.version);
}

export function createProviderCooldownKey(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: unknown;
  responsibleUserId: string | null;
  environment: {
    id: string;
    driver: string;
    config: unknown;
    envVars: unknown;
  } | null;
  projectEnv: unknown;
  routineEnv: unknown;
  credentialMetadata?: unknown;
  secretVersions?: readonly ProviderCooldownSecretVersion[];
}) {
  const declaredSecretIds = new Set<string>();
  const declaredUserEnvKeys = new Set<string>();
  for (const env of [input.adapterConfig.env, input.environment?.envVars, input.projectEnv, input.routineEnv]) {
    for (const [key, value] of Object.entries(record(env))) {
      const binding = record(value);
      if (binding.type === "secret_ref" && typeof binding.secretId === "string") declaredSecretIds.add(binding.secretId);
      if (binding.type === "user_secret_ref") declaredUserEnvKeys.add(key);
    }
  }
  const credentialMetadata = record(input.credentialMetadata);
  return createEffectiveRunConfigFingerprints({ session: {
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
    aiConnection: input.aiConnection ?? null,
    responsibleUserId: input.responsibleUserId,
    environment: input.environment ? {
      id: input.environment.id,
      driver: input.environment.driver,
      config: input.environment.config,
      env: input.environment.envVars,
    } : null,
    // The existing canonicalizer hashes env bindings beneath literal `env`
    // keys; sensitive config fields elsewhere are intentionally redacted.
    project: { env: input.projectEnv },
    routine: { env: input.routineEnv },
    managedAccount: input.credentialMetadata ? {
      attribution: credentialMetadata.attribution,
      accountGeneration: credentialMetadata.accountGeneration ?? null,
      // Managed subscriptions rotate tokens during ordinary refresh. Their
      // selected version pins execution, but only explicit account changes
      // should open a new quota scope.
      secretId: record(credentialMetadata.credential).secretId,
    } : null,
    secretVersions: sortedSecretVersions((input.secretVersions ?? []).filter((entry) =>
      declaredSecretIds.has(entry.secretId) || (entry.envKey != null && declaredUserEnvKeys.has(entry.envKey)),
    )),
  } }).sessionFingerprint.fingerprint;
}

type CooldownSecretService = Pick<ReturnType<typeof secretService>,
  "resolveSecretVersion" | "getById" | "collectMissingRuntimeBindings" | "listCurrentUserSecretValues"
>;

/** Read declared binding/version metadata only; runtime still owns value resolution. */
export async function resolveProviderCooldownSecretVersions(
  secrets: CooldownSecretService,
  companyId: string,
  scopes: readonly {
    consumerType: SecretBindingTargetType;
    consumerId: string;
    env: unknown;
    responsibleUserId?: string | null;
  }[],
): Promise<ProviderCooldownSecretVersion[]> {
  const versions: ProviderCooldownSecretVersion[] = [];
  const userValues = new Map<string, Awaited<ReturnType<CooldownSecretService["listCurrentUserSecretValues"]>>>();
  for (const scope of scopes) {
    if (!scope.env || typeof scope.env !== "object" || Array.isArray(scope.env)) continue;
    const bindings = Object.entries(scope.env).map(([key, value]) => {
      const parsed = envBindingSchema.safeParse(value);
      if (!parsed.success) throw unprocessable("Provider cooldown environment metadata is invalid");
      return { key, binding: parsed.data };
    });
    if (!bindings.some(({ binding }) => typeof binding === "object" && binding.type !== "plain")) continue;
    const context = {
      consumerType: scope.consumerType,
      consumerId: scope.consumerId,
      responsibleUserId: scope.responsibleUserId ?? null,
    };
    // Admission validation normally skips optional user refs entirely. Inspect
    // their metadata through the same policy using a strict temporary copy,
    // then apply the original optional-absence semantics below.
    const validationEnv = Object.fromEntries(bindings.map(({ key, binding }) => [
      key,
      typeof binding === "object" && binding.type === "user_secret_ref"
        ? { ...binding, required: true, allowMissingOverride: false }
        : binding,
    ]));
    const missing = await secrets.collectMissingRuntimeBindings(companyId, validationEnv, context);
    const skippedOptionalKeys = new Set(missing.flatMap((entry) => {
      const binding = bindings.find(({ key }) => key === entry.envKey)?.binding;
      const optional = typeof binding === "object" && binding.type === "user_secret_ref"
        && (binding.required === false || binding.allowMissingOverride === true);
      // Match resolveUserSecretValue's optional-absence cases. Concrete secret
      // or version revocation and permission failures still require validation.
      return optional && [
        "user_secret_definition_missing", "user_secret_definition_inactive",
        "responsible_user_missing", "binding_missing", "user_secret_missing",
      ].includes(entry.errorCode ?? "") ? [entry.envKey] : [];
    }));
    if (missing.some((entry) => !skippedOptionalKeys.has(entry.envKey))) {
      throw unprocessable("Provider cooldown secret metadata is unavailable");
    }
    for (const { key, binding } of bindings) {
      if (typeof binding === "string" || binding.type === "plain" || skippedOptionalKeys.has(key)) continue;
      if (binding.type === "secret_ref") {
        const secret = await secrets.getById(binding.secretId);
        if (!secret || secret.companyId !== companyId || secret.scope !== "company") {
          throw forbidden("Provider cooldown secret must belong to this company");
        }
        const version = await secrets.resolveSecretVersion(companyId, binding.secretId, binding.version ?? "latest", {
          ...context, configPath: `env.${key}`,
        });
        versions.push({ secretId: binding.secretId, version, envKey: key });
        continue;
      }
      const ownerUserId = context.responsibleUserId;
      const optional = binding.required === false || binding.allowMissingOverride === true;
      if (!ownerUserId && optional) continue;
      if (!ownerUserId) throw unprocessable("Provider cooldown user secret requires a responsible user");
      let values = userValues.get(ownerUserId);
      if (!values) {
        values = await secrets.listCurrentUserSecretValues(companyId, ownerUserId);
        userValues.set(ownerUserId, values);
      }
      const selected = values.find(({ definition }) => definition.key === binding.key);
      const secret = selected?.secret;
      if (!secret && optional) continue;
      if (!secret || secret.companyId !== companyId || secret.ownerUserId !== ownerUserId || secret.scope !== "user") {
        throw forbidden("Provider cooldown user secret ownership mismatch");
      }
      // collectMissingRuntimeBindings above checked this consumer's declaration;
      // company binding rows do not mediate owner-scoped user secret values.
      const version = await secrets.resolveSecretVersion(companyId, secret.id, binding.version ?? "latest");
      versions.push({ secretId: secret.id, version, envKey: key });
    }
  }
  return versions.sort((a, b) => a.secretId.localeCompare(b.secretId) || a.version - b.version || (a.envKey ?? "").localeCompare(b.envKey ?? ""));
}

/** Select the same authorized managed account as runtime without reading its value. */
export async function managedProviderCooldownMetadata(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string | null;
    adapterType: string;
    binding: Parameters<ReturnType<typeof aiConnectionService>["select"]>[0]["binding"];
    config: Record<string, unknown>;
    allowUninstalledPersonal?: boolean;
    allowUninstalledShared?: boolean;
    allowLegacyValidation?: boolean;
  },
) {
  const selection = await aiConnectionService(db).select({
    ...input,
    userId: input.responsibleUserId,
    model: input.config.model,
    runnerProvider: input.config.provider,
    acpxAgent: input.config.acpxAgent,
  });
  return managedProviderCooldownMetadataForSelection(db, selection);
}

export async function managedProviderCooldownMetadataForSelection(
  db: Db,
  selection: Awaited<ReturnType<ReturnType<typeof aiConnectionService>["select"]>>,
) {
  const companyId = selection.connection.companyId;
  const ref = selection.grant.credentialSecretRefs.find((entry) => entry.configPath === "ai.credential");
  if (!ref) throw unprocessable("The selected AI account has no credential binding");
  const secrets = secretService(db);
  const secret = await secrets.getById(ref.secretId);
  if (!secret || secret.companyId !== companyId) {
    throw forbidden("Provider cooldown credential must belong to this company");
  }
  const context = {
    consumerType: "tool_connection" as const,
    consumerId: selection.connection.id,
    configPath: ref.configPath,
    responsibleUserId: selection.grant.subjectUserId,
    actorType: "system" as const,
  };
  if (secret.scope === "user") {
    if (secret.ownerUserId !== selection.grant.subjectUserId || !secret.userSecretDefinitionId) {
      throw forbidden("Provider cooldown credential ownership mismatch");
    }
    const definition = await secrets.getUserSecretDefinitionById(companyId, secret.userSecretDefinitionId);
    if (!definition || definition.status !== "active" || definition.deletedAt) {
      throw unprocessable("The selected AI account credential definition is unavailable");
    }
    const [declaration] = await db.select({ id: userSecretDeclarations.id }).from(userSecretDeclarations).where(and(
      eq(userSecretDeclarations.companyId, companyId),
      eq(userSecretDeclarations.userSecretDefinitionId, secret.userSecretDefinitionId),
      eq(userSecretDeclarations.targetType, context.consumerType),
      eq(userSecretDeclarations.targetId, context.consumerId),
      eq(userSecretDeclarations.configPath, context.configPath),
    ));
    if (!declaration) throw unprocessable("The selected AI account credential is not declared");
  } else if (secret.scope !== "company") {
    throw forbidden("Provider cooldown credential scope is invalid");
  }
  const version = await secrets.resolveSecretVersion(companyId, secret.id, "latest",
    secret.scope === "user" ? undefined : context);
  return {
    attribution: selection.attribution,
    accountGeneration: selection.connection.config.aiAccountGeneration ?? null,
    credential: { secretId: secret.id, version },
  };
}
