import { describe, expect, it } from "vitest";
import {
  assertLocalDevDatabaseIsolation,
  describeDatabaseHostForLogging,
  isNonLoopbackPostgresUrl,
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

  it("ignores non-postgres URLs and invalid strings", () => {
    expect(isNonLoopbackPostgresUrl("https://example.com")).toBe(false);
    expect(isNonLoopbackPostgresUrl("not a url")).toBe(false);
  });
});

describe("describeDatabaseHostForLogging", () => {
  it("returns host:port without credentials", () => {
    expect(describeDatabaseHostForLogging("postgres://user:secret@db:5432/db")).toBe("db:5432");
  });

  it("falls back for invalid input", () => {
    expect(describeDatabaseHostForLogging("not a url")).toBe("<invalid DATABASE_URL>");
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
