import { describe, expect, it } from "vitest";
import {
  assertLocalDevDatabaseIsolation,
  describeDatabaseHostForLogging,
  isNonLoopbackPostgresUrl,
  resolvePostgresUrlHosts,
} from "../local-dev-database-guard.ts";

const REMOTE_URL = "postgres://user:pass@prod-db.internal:5432/db";
const LOOPBACK_URL = "postgres://user:pass@127.0.0.1:5432/db";
const DEV_ENV = { PAPERCLIP_LOCAL_DEV_ENTRYPOINT: "true" };

describe("isNonLoopbackPostgresUrl", () => {
  it("treats loopback hosts as safe", () => {
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@127.0.0.1:5432/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@localhost:5432/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@LOCALHOST:5432/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgresql://user:pass@[::1]:5432/db")).toBe(false);
  });

  it("treats the whole IPv4 loopback range 127.0.0.0/8 as safe", () => {
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@127.0.1.1:5432/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@127.255.255.254:5432/db")).toBe(false);
  });

  it("flags non-loopback hosts", () => {
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@db:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl(REMOTE_URL)).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@10.0.0.5:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@128.0.0.1:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgres://user:pass@127.example.com:5432/db")).toBe(true);
  });

  it("checks the host whatever the URL scheme, because postgres.js ignores the scheme", () => {
    // postgres.js parseUrl slices at "://" and never looks at the scheme, so all of these
    // connect to the remote host. The guard used to allow any non-postgres:// scheme.
    expect(isNonLoopbackPostgresUrl("pg://u:p@example.invalid:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgresql+psycopg2://user:pw@prod-host/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgres+x://u:p@example.invalid/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("tcp://u:p@example.invalid/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("https://example.com")).toBe(true);
    expect(isNonLoopbackPostgresUrl("pg://u:p@127.0.0.1:5432/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgresql+psycopg2://u:p@localhost/db")).toBe(false);
  });

  it("fails closed on a non-empty value that is not a URL at all", () => {
    expect(isNonLoopbackPostgresUrl("not a url")).toBe(true);
    expect(isNonLoopbackPostgresUrl("host=prod.example.com dbname=x")).toBe(true);
    expect(isNonLoopbackPostgresUrl("   ")).toBe(false);
  });

  it("uses the host postgres.js connects to when the userinfo contains a raw '@'", () => {
    // The manual first-"@" split yields "localhost", but postgres.js connects to the
    // WHATWG hostname (example.invalid). Both must be checked.
    expect(isNonLoopbackPostgresUrl("postgres://u@localhost:p@example.invalid/db")).toBe(true);
    expect(resolvePostgresUrlHosts("postgres://u@localhost:p@example.invalid/db")).toContain("example.invalid");
  });

  it("treats other spellings of the loopback address as loopback", () => {
    expect(isNonLoopbackPostgresUrl("postgres://u:p@[0:0:0:0:0:0:0:1]:5432/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgres://u:p@[::ffff:127.0.0.1]:5432/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgres://u:p@[::ffff:10.0.0.5]:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgres://u:p@[::2]:5432/db")).toBe(true);
  });

  it("fails closed on a postgres URL that cannot be parsed", () => {
    // WHATWG URL rejects both; the old guard returned false (allowed) for them.
    expect(isNonLoopbackPostgresUrl("postgres://u:p@prod example.com:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgres://u:p@%E0%A4%A,localhost/db")).toBe(true);
    expect(resolvePostgresUrlHosts("postgres://u:p@%E0%A4%A,localhost/db")).toBeNull();
  });

  it("flags multi-host URLs (which WHATWG URL rejects) when any host is non-loopback", () => {
    // postgres.js accepts these and tries the hosts in order.
    expect(isNonLoopbackPostgresUrl("postgres://u:p@prod.example.com:5432,localhost:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgres://u:p@localhost:5432,prod.example.com:5432/db")).toBe(true);
    expect(isNonLoopbackPostgresUrl("postgresql://u:p@127.0.0.1:5432,10.0.0.5/db?sslmode=require")).toBe(true);
  });

  it("allows multi-host URLs whose hosts are all loopback", () => {
    expect(isNonLoopbackPostgresUrl("postgres://u:p@localhost:5432,127.0.0.2:5433/db")).toBe(false);
  });

  it("resolves an empty host like postgres.js: PGHOST, then localhost", () => {
    expect(isNonLoopbackPostgresUrl("postgres://u:p@/db")).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgres://u:p@/db", { PGHOST: "/var/run/postgresql" })).toBe(false);
    expect(isNonLoopbackPostgresUrl("postgres://u:p@/db", { PGHOST: "prod.example.com" })).toBe(true);
  });
});

describe("resolvePostgresUrlHosts", () => {
  it("lists every host postgres.js would try, without ports or credentials", () => {
    expect(resolvePostgresUrlHosts("postgres://u:p@a.example:5432,b.example:5433/db")).toEqual([
      "a.example",
      "b.example",
    ]);
    expect(resolvePostgresUrlHosts("postgres://u:p@[::1]:5432/db")).toEqual(["[::1]"]);
  });
});

describe("describeDatabaseHostForLogging", () => {
  it("returns host:port without credentials", () => {
    expect(describeDatabaseHostForLogging("postgres://user:secret@db:5432/db")).toBe("db:5432");
  });

  it("does not echo a value that is not a URL (it may be a secret)", () => {
    expect(describeDatabaseHostForLogging("not a url")).toBe("<invalid DATABASE_URL>");
  });

  it("describes non-postgres schemes without credentials", () => {
    expect(describeDatabaseHostForLogging("postgresql+psycopg2://user:s3cret@prod-host:5432/db")).toBe(
      "prod-host:5432",
    );
    expect(describeDatabaseHostForLogging("pg://u:p@w@example.invalid/db")).toBe("example.invalid");
  });

  it("describes multi-host URLs without credentials", () => {
    expect(describeDatabaseHostForLogging("postgres://u:secret@prod.example.com:5432,localhost:5432/db")).toBe(
      "prod.example.com:5432,localhost:5432",
    );
  });
});

describe("assertLocalDevDatabaseIsolation", () => {
  it("is a no-op outside the local dev entrypoint (e.g. production start)", () => {
    expect(() => assertLocalDevDatabaseIsolation({}, REMOTE_URL, REMOTE_URL)).not.toThrow();
  });

  it("only treats the exact marker value 'true' as the dev entrypoint", () => {
    expect(() =>
      assertLocalDevDatabaseIsolation({ PAPERCLIP_LOCAL_DEV_ENTRYPOINT: "1" }, REMOTE_URL),
    ).not.toThrow();
  });

  it("is a no-op when no database URL is set (embedded PostgreSQL fallback)", () => {
    expect(() => assertLocalDevDatabaseIsolation(DEV_ENV, undefined, undefined)).not.toThrow();
  });

  it("is a no-op when both URLs point at loopback hosts", () => {
    expect(() =>
      assertLocalDevDatabaseIsolation(DEV_ENV, LOOPBACK_URL, "postgres://u:p@localhost:5432/db"),
    ).not.toThrow();
  });

  it("refuses to start against a non-loopback DATABASE_URL in the local dev entrypoint", () => {
    expect(() => assertLocalDevDatabaseIsolation(DEV_ENV, REMOTE_URL)).toThrow(
      /non-loopback DATABASE_URL \(host=prod-db\.internal:5432\)/,
    );
  });

  it("does not leak credentials in the refusal message", () => {
    expect(() => assertLocalDevDatabaseIsolation(DEV_ENV, "postgres://admin:s3cret@db:5432/x")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cret") }),
    );
  });

  it("refuses a non-loopback DATABASE_MIGRATION_URL even when DATABASE_URL is loopback", () => {
    expect(() => assertLocalDevDatabaseIsolation(DEV_ENV, LOOPBACK_URL, REMOTE_URL)).toThrow(
      /non-loopback DATABASE_MIGRATION_URL/,
    );
  });

  it("refuses a multi-host DATABASE_URL that includes a non-loopback host", () => {
    expect(() =>
      assertLocalDevDatabaseIsolation(DEV_ENV, "postgres://u:secret@localhost:5432,prod.example.com:5432/db"),
    ).toThrow(/non-loopback DATABASE_URL \(host=localhost:5432,prod\.example\.com:5432\)/);
  });

  it("refuses an unparseable postgres DATABASE_URL instead of letting it through", () => {
    expect(() => assertLocalDevDatabaseIsolation(DEV_ENV, "postgres://u:p@%E0%A4%A,localhost/db")).toThrow(
      /Refusing to start/,
    );
  });

  it("refuses a DATABASE_URL with a driver-qualified or alternate scheme", () => {
    expect(() =>
      assertLocalDevDatabaseIsolation(DEV_ENV, "postgresql+psycopg2://user:pw@prod-host/db"),
    ).toThrow(/non-loopback DATABASE_URL \(host=prod-host\)/);
    expect(() => assertLocalDevDatabaseIsolation(DEV_ENV, LOOPBACK_URL, "pg://u:p@example.invalid/db")).toThrow(
      /non-loopback DATABASE_MIGRATION_URL/,
    );
  });

  it("honors an explicit override for deliberate non-loopback dev databases", () => {
    expect(() =>
      assertLocalDevDatabaseIsolation(
        { ...DEV_ENV, PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE: "true" },
        REMOTE_URL,
        REMOTE_URL,
      ),
    ).not.toThrow();
  });

  it("does not accept other truthy spellings as the override", () => {
    expect(() =>
      assertLocalDevDatabaseIsolation(
        { ...DEV_ENV, PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE: "1" },
        REMOTE_URL,
      ),
    ).toThrow(/Refusing to start/);
  });
});
