import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertDevRunnerDatabaseIsolation } from "../../../scripts/dev-runner-database-guard.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const REMOTE_URL = "postgres://u:secret@prod.example.com:5432/db";
const LOOPBACK_URL = "postgres://u:p@127.0.0.1:5432/db";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_PAPERCLIP_CONFIG = process.env.PAPERCLIP_CONFIG;
const tempDirs: string[] = [];

afterEach(() => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_PAPERCLIP_CONFIG === undefined) delete process.env.PAPERCLIP_CONFIG;
  else process.env.PAPERCLIP_CONFIG = ORIGINAL_PAPERCLIP_CONFIG;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const embedded = () =>
  ({
    mode: "embedded-postgres",
    dataDir: "/tmp/paperclip-db",
    port: 54329,
    source: "embedded-postgres@54329",
    configPath: "/tmp/config.json",
    envPath: "/tmp/.env",
  }) as const;

const fromPaperclipEnv = (connectionString: string) => () =>
  ({
    mode: "postgres",
    connectionString,
    source: "paperclip-env",
    configPath: "/tmp/config.json",
    envPath: "/tmp/.env",
  }) as const;

describe("assertDevRunnerDatabaseIsolation", () => {
  it("marks the runner env as a local dev entrypoint so the server child checks too", () => {
    const env: NodeJS.ProcessEnv = {};
    assertDevRunnerDatabaseIsolation(env, embedded);
    expect(env.PAPERCLIP_LOCAL_DEV_ENTRYPOINT).toBe("true");
  });

  it("refuses a non-loopback DATABASE_URL from the environment", () => {
    expect(() => assertDevRunnerDatabaseIsolation({ DATABASE_URL: REMOTE_URL }, embedded)).toThrow(
      /Refusing to start: .*non-loopback DATABASE_URL \(host=prod\.example\.com:5432\)/,
    );
  });

  it("refuses a non-loopback URL resolved from .paperclip/.env or the config file", () => {
    expect(() => assertDevRunnerDatabaseIsolation({}, fromPaperclipEnv(REMOTE_URL))).toThrow(
      /non-loopback DATABASE_URL/,
    );
  });

  it("refuses a non-loopback DATABASE_MIGRATION_URL", () => {
    expect(() =>
      assertDevRunnerDatabaseIsolation({ DATABASE_URL: LOOPBACK_URL, DATABASE_MIGRATION_URL: REMOTE_URL }, embedded),
    ).toThrow(/non-loopback DATABASE_MIGRATION_URL/);
  });

  it("allows embedded PostgreSQL and loopback URLs", () => {
    expect(() => assertDevRunnerDatabaseIsolation({}, embedded)).not.toThrow();
    expect(() => assertDevRunnerDatabaseIsolation({ DATABASE_URL: LOOPBACK_URL }, embedded)).not.toThrow();
    expect(() => assertDevRunnerDatabaseIsolation({}, fromPaperclipEnv(LOOPBACK_URL))).not.toThrow();
  });

  it("honors PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE=true", () => {
    expect(() =>
      assertDevRunnerDatabaseIsolation(
        { DATABASE_URL: REMOTE_URL, PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE: "true" },
        embedded,
      ),
    ).not.toThrow();
  });

  it("uses the db package's resolution by default (DATABASE_URL in the instance .paperclip/.env)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-guard-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, ".paperclip", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ database: { mode: "embedded-postgres" } }));
    fs.writeFileSync(path.join(dir, ".paperclip", ".env"), `DATABASE_URL=${REMOTE_URL}\n`);
    delete process.env.DATABASE_URL;
    process.env.PAPERCLIP_CONFIG = configPath;

    expect(() => assertDevRunnerDatabaseIsolation({})).toThrow(/non-loopback DATABASE_URL/);
  });
});

describe("local dev entrypoint wiring", () => {
  it("runs the guard in dev-runner before the migration preflight touches the database", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/dev-runner.ts"), "utf8");
    const preflightStart = source.indexOf("async function maybePreflightMigrations(");
    expect(preflightStart).toBeGreaterThan(-1);
    const guardCall = source.indexOf("enforceDevDatabaseIsolation();", preflightStart);
    const firstDbTouch = source.indexOf("await refreshPendingMigrations()", preflightStart);
    expect(guardCall).toBeGreaterThan(preflightStart);
    expect(firstDbTouch).toBeGreaterThan(guardCall);
    expect(source).toMatch(/assertDevRunnerDatabaseIsolation\(env\)/);
  });

  it("marks the server dev scripts (pnpm dev:server and the dev-runner child) as local dev entrypoints", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "server/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.dev).toMatch(/PAPERCLIP_LOCAL_DEV_ENTRYPOINT=true/);
    expect(pkg.scripts["dev:watch"]).toMatch(/PAPERCLIP_LOCAL_DEV_ENTRYPOINT=true/);
    expect(pkg.scripts.start ?? "").not.toMatch(/PAPERCLIP_LOCAL_DEV_ENTRYPOINT/);
  });
});
