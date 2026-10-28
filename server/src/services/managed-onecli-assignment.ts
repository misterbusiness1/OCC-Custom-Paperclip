import { and, eq } from "drizzle-orm";
import {
  companySecretBindings,
  companySecrets,
  heartbeatRuns,
  environmentLeases,
  type Db,
} from "@paperclipai/db";
import {
  ONECLI_IDENTITY_PATH,
  projectManagedOnecliToRealizedWorker,
  type ManagedOnecliProjectionInput,
} from "./managed-onecli-identity.js";
import { secretService } from "./secrets.js";

/** Trusted control-plane entry point. No value is read before run/assignment/worker checks. */
export async function prepareManagedOnecliAssignment(
  db: Db,
  input: ManagedOnecliProjectionInput,
  registerForRedaction: (value: string) => void,
  config: Record<string, unknown>,
  secretKeys: Set<string>,
) {
  const secrets = secretService(db);
  return projectManagedOnecliToRealizedWorker(
    input,
    {
      loadRun: () =>
        db
          .select({
            id: heartbeatRuns.id,
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, input.runId))
          .then((rows) => rows[0] ?? null),
      loadLease: () =>
        db
          .select()
          .from(environmentLeases)
          .where(eq(environmentLeases.id, input.executionTarget!.leaseId!))
          .then((rows) => rows[0] ?? null),
      loadAssignment: async () => {
        const rows = await db
          .select({ binding: companySecretBindings, secret: companySecrets })
          .from(companySecretBindings)
          .innerJoin(
            companySecrets,
            eq(companySecrets.id, companySecretBindings.secretId),
          )
          .where(
            and(
              eq(companySecretBindings.companyId, input.companyId),
              eq(companySecretBindings.targetType, "agent"),
              eq(companySecretBindings.targetId, input.agentId),
              eq(companySecretBindings.configPath, ONECLI_IDENTITY_PATH),
            ),
          );
        if (rows.length !== 1) return null;
        return { ...rows[0].binding, secret: rows[0].secret };
      },
      resolveSecret: (secretId, version) =>
        secrets.resolveSecretValue(input.companyId, secretId, version, {
          bindingContext: {
            consumerType: "agent",
            consumerId: input.agentId,
            configPath: ONECLI_IDENTITY_PATH,
          },
          accessContext: {
            consumerType: "agent",
            consumerId: input.agentId,
            configPath: ONECLI_IDENTITY_PATH,
            actorType: "system",
            actorId: "managed-onecli-projection",
            heartbeatRunId: input.runId,
          },
        }),
      registerForRedaction,
      fetch: globalThis.fetch,
    },
    config,
    secretKeys,
  );
}
