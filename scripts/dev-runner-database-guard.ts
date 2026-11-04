import {
  resolveDatabaseTarget,
  type ResolvedDatabaseTarget,
} from "../packages/db/src/runtime-config.ts";
import {
  assertLocalDevDatabaseIsolation,
  LOCAL_DEV_ENTRYPOINT_ENV,
} from "../server/src/local-dev-database-guard.ts";

/**
 * Root `pnpm dev`, `pnpm dev:watch` and `pnpm dev:once` run scripts/dev-runner.ts. Before it
 * spawns the server child, the runner runs `@paperclipai/db` migration-status (a database
 * connection) and possibly `pnpm db:migrate`. Both resolve the target with
 * resolveDatabaseTarget(): DATABASE_URL, then DATABASE_URL in the instance's
 * .paperclip/.env, then config.database.connectionString. So the runner must apply the
 * local-dev isolation guard itself, against that same resolution, before the preflight.
 *
 * Marks `env` as a local dev entrypoint (so the server child also checks) and throws when a
 * resolved database URL points at a non-loopback host without the explicit override.
 */
export function assertDevRunnerDatabaseIsolation(
  env: NodeJS.ProcessEnv,
  resolveTarget: () => ResolvedDatabaseTarget = resolveDatabaseTarget,
): void {
  env[LOCAL_DEV_ENTRYPOINT_ENV] = "true";
  const envUrl = env.DATABASE_URL?.trim();
  let databaseUrl: string | undefined = envUrl || undefined;
  if (!databaseUrl) {
    const target = resolveTarget();
    databaseUrl = target.mode === "postgres" ? target.connectionString : undefined;
  }
  assertLocalDevDatabaseIsolation(env, databaseUrl, env.DATABASE_MIGRATION_URL);
}
