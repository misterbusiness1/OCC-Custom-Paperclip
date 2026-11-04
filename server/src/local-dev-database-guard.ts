// Ported from the archived paperclip-minimax-local fork, with these adaptations:
// - the IPv4 loopback range 127.0.0.0/8 is treated as loopback (not only 127.0.0.1);
// - the separate migration connection string (DATABASE_MIGRATION_URL) is checked too,
//   because OCC can run migrations through a different URL than the runtime one;
// - hosts are extracted the way postgres.js does it, so multi-host URLs
//   (`postgres://u:p@a:5432,b:5432/db`) are checked host by host, and a postgres URL
//   that cannot be parsed is refused (fail closed) instead of being let through;
// - an empty host (`postgres://u:p@/db`) resolves like postgres.js does, through PGHOST
//   and then `localhost`, and unix-socket paths count as local;
// - the refusal message no longer suggests `pnpm dev:once`, which carries the same marker.

export const LOCAL_DEV_ENTRYPOINT_ENV = "PAPERCLIP_LOCAL_DEV_ENTRYPOINT";
export const ALLOW_REMOTE_DEV_DATABASE_ENV = "PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE";

type GuardEnv = Record<string, string | undefined>;

const POSTGRES_URL_PATTERN = /^postgres(?:ql)?:\/\//i;

function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith("/")) return true; // unix-socket directory
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function stripPort(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  return trimmed.split(":")[0] ?? "";
}

function hostAuthority(connectionString: string): string {
  const rest = connectionString.slice(connectionString.indexOf("://") + 3);
  return rest.split(/[?/]/)[0] ?? "";
}

/**
 * Returns every host a postgres.js client would try for this URL, or null when the
 * URL is a postgres URL that cannot be parsed. Mirrors postgres.js parseUrl/parseOptions:
 * the host list is the authority after the first "@", split on ",", and an empty host
 * falls back to PGHOST and then "localhost". The WHATWG hostname is added as well when
 * it parses, so the check is at least as strict as either parser.
 */
export function resolvePostgresUrlHosts(connectionString: string, env: GuardEnv = {}): string[] | null {
  const authority = hostAuthority(connectionString);
  let hostList: string;
  try {
    hostList = decodeURIComponent(authority.slice(authority.indexOf("@") + 1));
  } catch {
    return null;
  }

  const hosts = new Set<string>();
  for (const entry of hostList.split(",")) {
    const host = stripPort(entry);
    if (host) hosts.add(host);
  }
  if (hosts.size === 0) {
    const fallback = env.PGHOST?.trim() || "localhost";
    for (const entry of fallback.split(",")) {
      const host = stripPort(entry);
      if (host) hosts.add(host);
    }
  }

  try {
    const parsed = new URL(connectionString);
    if (parsed.hostname) hosts.add(parsed.hostname);
  } catch {
    // Multi-host URLs are not valid WHATWG URLs; the manual split above covers them.
  }

  return hosts.size > 0 ? [...hosts] : null;
}

export function describeDatabaseHostForLogging(connectionString: string): string {
  if (!POSTGRES_URL_PATTERN.test(connectionString)) {
    try {
      return new URL(connectionString).host || "<unknown-host>";
    } catch {
      return "<invalid DATABASE_URL>";
    }
  }
  // Use the text after the last "@" so a password containing a raw "@" never leaks.
  const authority = hostAuthority(connectionString);
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  return hostPart || "<empty host>";
}

export function isNonLoopbackPostgresUrl(connectionString: string, env: GuardEnv = {}): boolean {
  if (!POSTGRES_URL_PATTERN.test(connectionString.trim())) return false;
  const hosts = resolvePostgresUrlHosts(connectionString.trim(), env);
  if (hosts === null) return true; // fail closed on an unparseable postgres URL
  return hosts.some((host) => !isLocalHost(host));
}

// `pnpm dev`, `pnpm dev:watch` and `pnpm dev:once` run scripts/dev-runner.ts, which calls
// this guard itself before its migration preflight (that preflight connects to the
// database and may apply migrations before the server child starts). The runner and the
// server package's "dev" / "dev:watch" scripts (`pnpm dev:server`) set
// PAPERCLIP_LOCAL_DEV_ENTRYPOINT=true, and server startup checks again before it connects.
// That marker is the only thing that tells a local dev boot apart from
// `node dist/index.js` in staging/production, where a non-loopback DATABASE_URL is
// expected and required.
export function assertLocalDevDatabaseIsolation(
  env: GuardEnv,
  databaseUrl: string | undefined,
  databaseMigrationUrl?: string | undefined,
): void {
  if (env[LOCAL_DEV_ENTRYPOINT_ENV] !== "true") return;
  if (env[ALLOW_REMOTE_DEV_DATABASE_ENV] === "true") return;

  const candidates: Array<[label: string, url: string | undefined]> = [
    ["DATABASE_URL", databaseUrl],
    ["DATABASE_MIGRATION_URL", databaseMigrationUrl],
  ];
  for (const [label, url] of candidates) {
    if (!url?.trim()) continue;
    if (!isNonLoopbackPostgresUrl(url, env)) continue;
    throw new Error(
      `Refusing to start: this local dev entrypoint inherited a non-loopback ${label} ` +
        `(host=${describeDatabaseHostForLogging(url.trim())}). This looks like a production/shared ` +
        "connection string leaking into a dev process rather than an isolated local database. " +
        `Unset ${label} to use embedded PostgreSQL, or point it at a loopback host ` +
        "(127.0.0.1/localhost). If this is a deliberate non-loopback dev database, " +
        "set PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE=true to override.",
    );
  }
}
