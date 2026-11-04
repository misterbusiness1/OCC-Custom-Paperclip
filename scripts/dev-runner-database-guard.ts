import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

/** Recheck after any prompt, then prevent the child from rereading mutable DB config. */
export async function withDevRunnerMigrationTarget<T>(
  env: NodeJS.ProcessEnv,
  run: (childEnv: NodeJS.ProcessEnv) => Promise<T>,
  resolveTarget: () => ResolvedDatabaseTarget = resolveDatabaseTarget,
): Promise<T> {
  const target = resolveTarget();
  const childEnv = { ...env };
  assertDevRunnerDatabaseIsolation(childEnv, () => target);
  const databaseUrl = childEnv.DATABASE_URL?.trim()
    || (target.mode === "postgres" ? target.connectionString : undefined);
  if (databaseUrl) {
    return await run({ ...childEnv, DATABASE_URL: databaseUrl });
  }

  // Embedded migration startup also resolves config in the child. Give it only the
  // already-vetted local data directory and port, not the mutable instance files.
  if (target.mode !== "embedded-postgres") throw new Error("Missing migration database target");
  const directory = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-migration-"));
  try {
    const configPath = path.join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: target.dataDir,
      embeddedPostgresPort: target.port,
    } }), { mode: 0o600, flag: "wx" });
    return await run({ ...childEnv, DATABASE_URL: "", PAPERCLIP_CONFIG: configPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
