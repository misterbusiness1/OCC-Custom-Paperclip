import fs from "node:fs";
import os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDatabaseTarget } from "../../../packages/db/src/runtime-config.ts";
import { assertDevRunnerDatabaseIsolation, withDevRunnerMigrationTarget } from "../../../scripts/dev-runner-database-guard.ts";

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

  it("refuses a driver-qualified URL resolved from .paperclip/.env or the config file", () => {
    expect(() =>
      assertDevRunnerDatabaseIsolation({}, fromPaperclipEnv("postgresql+psycopg2://u:p@prod-host/db")),
    ).toThrow(/non-loopback DATABASE_URL \(host=prod-host\)/);
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

  it("runs the guard before every migration-status call, including background rescans", () => {
    // refreshPendingMigrations() is also called after a restart (markChildAsCurrent) and by
    // the periodic backend scan; each call runs migration-status, which connects.
    const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/dev-runner.ts"), "utf8");
    const start = source.indexOf("async function getMigrationStatusPayload(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end);
    const guard = body.indexOf("devDatabaseIsolationRefusal()");
    const connect = body.indexOf("src/migration-status.ts");
    expect(guard).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(guard);
    expect(source.match(/await getMigrationStatusPayload\(\)/g)).toHaveLength(1);
    expect(source).toMatch(/async function refreshPendingMigrations\(\) \{\n  const payload = await getMigrationStatusPayload\(\);/);
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

describe("withDevRunnerMigrationTarget", () => {
  it("refuses a config switched to remote while the migration prompt is pending", async () => {
    let target = fromPaperclipEnv(LOOPBACK_URL);
    const env = {};
    assertDevRunnerDatabaseIsolation(env, () => target());
    await Promise.resolve(); // interactive prompt yields to config writers
    target = fromPaperclipEnv(REMOTE_URL);
    let spawned = false;
    await expect(withDevRunnerMigrationTarget(env, async () => { spawned = true; }, () => target()))
      .rejects.toThrow(/non-loopback DATABASE_URL/);
    expect(spawned).toBe(false);
  });

  it("pins the checked URL so a later config edit cannot redirect the migration child", async () => {
    let target = fromPaperclipEnv(LOOPBACK_URL);
    await withDevRunnerMigrationTarget({}, async (childEnv) => {
      target = fromPaperclipEnv(REMOTE_URL);
      expect(childEnv.DATABASE_URL).toBe(LOOPBACK_URL);
      expect(childEnv.PAPERCLIP_LOCAL_DEV_ENTRYPOINT).toBe("true");
    }, () => target());
  });

  it("pins an embedded target in a private disposable config and removes it after failure", async () => {
    let configPath = "";
    await expect(withDevRunnerMigrationTarget({}, async (childEnv) => {
      configPath = childEnv.PAPERCLIP_CONFIG!;
      expect(childEnv.DATABASE_URL).toBe("");
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).database).toEqual({
        mode: "embedded-postgres", embeddedPostgresDataDir: embedded().dataDir,
        embeddedPostgresPort: embedded().port,
      });
      process.env.PAPERCLIP_CONFIG = configPath;
      process.env.DATABASE_URL = childEnv.DATABASE_URL;
      expect(resolveDatabaseTarget()).toMatchObject({
        mode: "embedded-postgres", dataDir: embedded().dataDir,
        port: embedded().port, configPath,
      });
      throw new Error("synthetic child failure");
    }, embedded)).rejects.toThrow("synthetic child failure");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("refuses an unvetted migration URL before constructing a child environment", async () => {
    let spawned = false;
    await expect(withDevRunnerMigrationTarget({ DATABASE_MIGRATION_URL: REMOTE_URL }, async () => {
      spawned = true;
    }, embedded)).rejects.toThrow(/non-loopback DATABASE_MIGRATION_URL/);
    expect(spawned).toBe(false);
  });

  it("preserves explicit remote override while pinning its actual checked target", async () => {
    await withDevRunnerMigrationTarget({ PAPERCLIP_ALLOW_REMOTE_DEV_DATABASE: "true" }, async (childEnv) => {
      expect(childEnv.DATABASE_URL).toBe(REMOTE_URL);
    }, fromPaperclipEnv(REMOTE_URL));
  });
});

describe("dev runner migration prompt call site", () => {
  it("rechecks the database after the actual interactive prompt before spawning", async () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/dev-runner.ts"), "utf8");
    const start = source.indexOf("async function maybePreflightMigrations(");
    const end = source.indexOf("\nasync function ", start + 1);
    const code = stripTypeScriptTypes(source.slice(start, end));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction("enforceDevDatabaseIsolation", "mode", "env",
      "refreshPendingMigrations", "pendingMigrations", "stdin", "stdout", "createInterface",
      "formatPendingMigrationSummary", "runPnpm", "repoRoot", "exitForSignal",
      "withDevRunnerMigrationTarget", code + ";return maybePreflightMigrations({interactive:true,autoApply:false})");
    let target = fromPaperclipEnv(LOOPBACK_URL);
    let spawned = false;
    const env: NodeJS.ProcessEnv = {};
    await expect(run(() => assertDevRunnerDatabaseIsolation(env, () => target()), "watch", env,
      async () => ({ status: "needsMigrations" }), ["001"], { isTTY: true }, { isTTY: true },
      () => ({ question: async () => { target = fromPaperclipEnv(REMOTE_URL); return "y"; }, close() {} }),
      () => "001", async () => { spawned = true; return { code: 0, signal: null }; }, REPO_ROOT, () => {},
      (childEnv: NodeJS.ProcessEnv, callback: (pinned: NodeJS.ProcessEnv) => Promise<unknown>) =>
        withDevRunnerMigrationTarget(childEnv, callback, () => target())))
      .rejects.toThrow(/non-loopback DATABASE_URL/);
    expect(spawned).toBe(false);
  });
});
