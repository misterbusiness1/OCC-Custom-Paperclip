// Ported from the archived paperclip-minimax-local fork, with these adaptations:
// - the IPv4 loopback range 127.0.0.0/8 is treated as loopback (not only 127.0.0.1);
// - the separate migration connection string (DATABASE_MIGRATION_URL) is checked too,
//   because OCC can run migrations through a different URL than the runtime one;
// - hosts are extracted the way postgres.js does it, so multi-host URLs
//   (`postgres://u:p@a:5432,b:5432/db`) are checked host by host, and a postgres URL
//   that cannot be parsed is refused (fail closed) instead of being let through;
// - an empty host (`postgres://u:p@/db`) resolves like postgres.js does, through PGHOST
//   and then `localhost`, and unix-socket paths count as local;
// - the refusal message no longer suggests `pnpm dev:once`, which carries the same marker;
// - the host is checked whatever the URL scheme, because postgres.js ignores the scheme
//   (`pg://`, `postgresql+psycopg2://` and `tcp://` all connect), and a non-empty value
//   that is not a URL at all is refused (fail closed).

export const LOCAL_DEV_ENTRYPOINT_ENV = "PAPERCLIP_LOCAL_DEV_ENTRYPOINT";
export const ALLOW_REMOTE_DEV_DATABASE_ENV = "PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE";

type GuardEnv = Record<string, string | undefined>;

const IPV4_LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith("/")) return true; // unix-socket directory
  if (normalized === "localhost") return true;
  if (IPV4_LOOPBACK_PATTERN.test(normalized)) return true;
  const ipv6 = normalized.replace(/^\[(.*)\]$/, "$1");
  if (ipv6 === "::1" || /^(?:0{1,4}:){7}0{0,3}1$/.test(ipv6)) return true;
  // IPv4-mapped loopback, in dotted form or as WHATWG URL normalises it (::ffff:7f00:1).
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv6)) return true;
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(ipv6);
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
 * Returns every host a postgres.js client would try for this URL (whatever its scheme),
 * or null when the URL cannot be parsed. Mirrors postgres.js parseUrl/parseOptions:
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
  // Never echo a value that is not a URL: it could be a bare secret or a keyword DSN.
  if (!connectionString.includes("://")) return "<invalid DATABASE_URL>";
  // Use the text after the last "@" so a password containing a raw "@" never leaks.
  const authority = hostAuthority(connectionString);
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  return hostPart || "<empty host>";
}

/**
 * True when a database client could reach a non-loopback host through this value. Any
 * scheme counts: postgres.js (packages/db createDb) slices the URL at "://" and never
 * checks the scheme, so `pg://`, `postgresql+psycopg2://` or `tcp://` URLs still connect.
 * A non-empty value without "://" is refused (fail closed); an empty value is not a URL.
 */
export function isNonLoopbackPostgresUrl(connectionString: string, env: GuardEnv = {}): boolean {
  const trimmed = connectionString.trim();
  if (!trimmed) return false;
  if (!trimmed.includes("://")) return true;
  const hosts = resolvePostgresUrlHosts(trimmed, env);
  if (hosts === null) return true; // fail closed on an unparseable URL
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
