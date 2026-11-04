// Ported from the archived paperclip-minimax-local fork, with three adaptations:
// - the IPv4 loopback range 127.0.0.0/8 is treated as loopback (not only 127.0.0.1);
// - the separate migration connection string (DATABASE_MIGRATION_URL) is checked too,
//   because OCC can run migrations through a different URL than the runtime one;
// - the refusal message no longer suggests `pnpm dev:once`, which also runs the
//   server "dev" script and therefore carries the same marker.

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export function describeDatabaseHostForLogging(connectionString: string): string {
  try {
    return new URL(connectionString).host || "<unknown-host>";
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

export function isNonLoopbackPostgresUrl(connectionString: string): boolean {
  try {
    const parsed = new URL(connectionString);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return false;
    return !isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

// `pnpm dev`, `pnpm dev:watch`, `pnpm dev:once` and `pnpm dev:server` all end up running
// the server package's "dev" or "dev:watch" script (directly, or via scripts/dev-runner.ts),
// and those scripts set PAPERCLIP_LOCAL_DEV_ENTRYPOINT=true. That marker is the only thing
// that tells a local dev boot apart from `node dist/index.js` in staging/production, where
// a non-loopback DATABASE_URL is expected and required.
export function assertLocalDevDatabaseIsolation(
  env: NodeJS.ProcessEnv,
  databaseUrl: string | undefined,
  databaseMigrationUrl?: string | undefined,
): void {
  if (env.PAPERCLIP_LOCAL_DEV_ENTRYPOINT !== "true") return;
  if (env.PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE === "true") return;

  const candidates: Array<[label: string, url: string | undefined]> = [
    ["DATABASE_URL", databaseUrl],
    ["DATABASE_MIGRATION_URL", databaseMigrationUrl],
  ];
  for (const [label, url] of candidates) {
    if (!url) continue;
    if (!isNonLoopbackPostgresUrl(url)) continue;
    throw new Error(
      `Refusing to start: this local dev entrypoint inherited a non-loopback ${label} ` +
        `(host=${describeDatabaseHostForLogging(url)}). This looks like a production/shared ` +
        "connection string leaking into a dev process rather than an isolated local database. " +
        `Unset ${label} to use embedded PostgreSQL, or point it at a loopback host ` +
        "(127.0.0.1/localhost). If this is a deliberate non-loopback dev database, " +
        "set PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE=true to override.",
    );
  }
}
