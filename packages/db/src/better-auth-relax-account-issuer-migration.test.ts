import { createHash } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

/**
 * Migration 9100 relaxes "account"."issuer" NOT NULL, and nothing else, so one
 * migration serves both database lineages:
 *
 * - master lineage (Better Auth 1.6.x): there is no issuer column, so the
 *   migration must be a no-op;
 * - Better Auth 1.7.0-1.7.2 lineage: upstream Paperclip's
 *   0230_better_auth_account_issuer added "issuer" text NOT NULL plus the
 *   unique index "account_issuer_account_id_uq". Better Auth 1.7.3+ never
 *   writes issuer, so the column must accept NULL.
 *
 * The fixtures are byte-for-byte copies of migrations that live on other lines:
 * upstream Paperclip's 0230 (also on the fork's occ/v2026.1010-* and deploy/*
 * lines) and release-line 9009 from fork PR #214, whose unguarded DROP INDEX
 * must keep working if both ever reach the same database.
 */

const MIGRATION_FILE = "9100_better_auth_relax_account_issuer.sql";
const migrationSql = fs.readFileSync(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const upstream0230Sql = fs.readFileSync(
  new URL("./__fixtures__/better-auth-issuer/upstream-0230-better-auth-account-issuer.sql", import.meta.url),
  "utf8",
);
const release9009Sql = fs.readFileSync(
  new URL("./__fixtures__/better-auth-issuer/release-9009-hesitant-mockingbird.sql", import.meta.url),
  "utf8",
);

const ISSUER_INDEX = "account_issuer_account_id_uq";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const cleanups: Array<() => Promise<void>> = [];

type Sql = ReturnType<typeof postgres>;

/** Runs a migration file the way client.ts does: one transaction, split on breakpoints. */
async function runMigrationFile(sql: Sql, content: string) {
  const statements = content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

async function startDatabase(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  return { database, sql };
}

/** Forgets that 9100 ran, so the next applyPendingMigrations applies it again. */
async function forgetMigration(sql: Sql) {
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`;
}

async function migrationHistoryCount(sql: Sql) {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}
  `;
  return row?.count ?? 0;
}

async function issuerColumn(sql: Sql) {
  const rows = await sql<{ is_nullable: string; data_type: string }[]>`
    SELECT is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'
  `;
  return rows[0] ?? null;
}

async function accountColumns(sql: Sql) {
  return sql`
    SELECT column_name, is_nullable, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account'
    ORDER BY column_name
  `;
}

async function accountIndexes(sql: Sql) {
  return sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'account'
    ORDER BY indexname
  `;
}

async function accountRows(sql: Sql) {
  return sql`SELECT * FROM "account" ORDER BY "id"`;
}

/** A user plus credential account exactly as Better Auth 1.6.x sign-up wrote them. */
async function insertCredentialUser(sql: Sql, userId: string) {
  await sql`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
    VALUES (${userId}, 'Legacy', ${`${userId}@example.test`}, false, now(), now())
  `;
  await sql`
    INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "password", "created_at", "updated_at")
    VALUES (${`${userId}-account`}, ${userId}, 'credential', ${userId}, 'unchanged-password-hash', now(), now())
  `;
}

/**
 * Rebuilds the Better Auth 1.7.0-1.7.2 lineage on a fully migrated database:
 * forget 9100, then run upstream 0230 over an existing 1.6-shaped account row,
 * which backfills issuer, sets NOT NULL and creates the unique index.
 */
async function startIssuerLineageDatabase(prefix: string) {
  const handle = await startDatabase(prefix);
  await forgetMigration(handle.sql);
  await insertCredentialUser(handle.sql, "legacy-user");
  await runMigrationFile(handle.sql, upstream0230Sql);
  expect(await issuerColumn(handle.sql)).toMatchObject({ is_nullable: "NO", data_type: "text" });
  expect((await accountIndexes(handle.sql)).map((row) => row.indexname)).toContain(ISSUER_INDEX);
  return handle;
}

describeEmbeddedPostgres("migration 9100_better_auth_relax_account_issuer", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("is a recorded no-op on a master-lineage database that has no issuer column", async () => {
    const { database, sql } = await startDatabase("paperclip-issuer-relax-master-");
    await insertCredentialUser(sql, "master-user");
    expect(await issuerColumn(sql)).toBeNull();
    expect(await migrationHistoryCount(sql)).toBe(1);

    await forgetMigration(sql);
    const columnsBefore = await accountColumns(sql);
    const indexesBefore = await accountIndexes(sql);
    const rowsBefore = await accountRows(sql);

    await applyPendingMigrations(database.connectionString);

    expect(await migrationHistoryCount(sql)).toBe(1);
    expect(await issuerColumn(sql)).toBeNull();
    expect(await accountColumns(sql)).toEqual(columnsBefore);
    expect(await accountIndexes(sql)).toEqual(indexesBefore);
    expect(await accountRows(sql)).toEqual(rowsBefore);

    // Idempotent: a second pass records nothing new, and the body itself can run again.
    await applyPendingMigrations(database.connectionString);
    await runMigrationFile(sql, migrationSql);
    expect(await migrationHistoryCount(sql)).toBe(1);
    expect(await accountColumns(sql)).toEqual(columnsBefore);
  }, 60_000);

  it("relaxes issuer NOT NULL on a 1.7.2-lineage database, keeping values and the unique index", async () => {
    const { database, sql } = await startIssuerLineageDatabase("paperclip-issuer-relax-172-");
    const legacyBefore = await accountRows(sql);
    expect(legacyBefore).toHaveLength(1);
    expect(legacyBefore[0]).toMatchObject({ issuer: "local:credential", password: "unchanged-password-hash" });
    const indexesBefore = await accountIndexes(sql);

    // Control: this is the insert Better Auth 1.7.3+ sign-up performs (no issuer).
    await expect(sql`
      INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at")
      VALUES ('before-relax', 'before-relax', 'credential', 'legacy-user', now(), now())
    `).rejects.toMatchObject({ code: "23502" });

    await applyPendingMigrations(database.connectionString);

    expect(await migrationHistoryCount(sql)).toBe(1);
    expect(await issuerColumn(sql)).toMatchObject({ is_nullable: "YES", data_type: "text" });
    expect(await accountIndexes(sql)).toEqual(indexesBefore);
    expect(await accountRows(sql)).toEqual(legacyBefore);

    // NULL issuers never collide under account_issuer_account_id_uq, even for
    // the same account_id under two providers.
    await sql`
      INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at")
      VALUES
        ('new-credential', 'shared-account-id', 'credential', 'legacy-user', now(), now()),
        ('new-github', 'shared-account-id', 'github', 'legacy-user', now(), now())
    `;
    const created = await sql<{ issuer: string | null }[]>`
      SELECT "issuer" FROM "account" WHERE "id" IN ('new-credential', 'new-github')
    `;
    expect(created.map((row) => row.issuer)).toEqual([null, null]);

    // Idempotent: rerunning the runner is a no-op, and so is replaying the body
    // or applying it again after its history row is gone.
    await applyPendingMigrations(database.connectionString);
    expect(await migrationHistoryCount(sql)).toBe(1);
    await runMigrationFile(sql, migrationSql);
    await forgetMigration(sql);
    await applyPendingMigrations(database.connectionString);
    expect(await migrationHistoryCount(sql)).toBe(1);
    expect(await issuerColumn(sql)).toMatchObject({ is_nullable: "YES" });
    expect(await accountIndexes(sql)).toEqual(indexesBefore);
    expect(await accountRows(sql)).toHaveLength(3);
  }, 60_000);

  it("leaves release migration 9009 able to run afterwards", async () => {
    const { database, sql } = await startIssuerLineageDatabase("paperclip-issuer-relax-9009-after-");
    await applyPendingMigrations(database.connectionString);
    expect(await issuerColumn(sql)).toMatchObject({ is_nullable: "YES" });
    const rowsBefore = await accountRows(sql);

    // 9009 runs DROP INDEX without IF EXISTS and an unguarded DROP NOT NULL.
    await runMigrationFile(sql, release9009Sql);

    expect((await accountIndexes(sql)).map((row) => row.indexname)).not.toContain(ISSUER_INDEX);
    expect(await issuerColumn(sql)).toMatchObject({ is_nullable: "YES" });
    expect(await accountRows(sql)).toEqual(rowsBefore);
  }, 60_000);

  it("is a no-op where release migration 9009 already ran", async () => {
    const { database, sql } = await startIssuerLineageDatabase("paperclip-issuer-relax-9009-before-");
    await runMigrationFile(sql, release9009Sql);
    const columnsBefore = await accountColumns(sql);
    const indexesBefore = await accountIndexes(sql);
    const rowsBefore = await accountRows(sql);

    await applyPendingMigrations(database.connectionString);

    expect(await migrationHistoryCount(sql)).toBe(1);
    expect(await accountColumns(sql)).toEqual(columnsBefore);
    expect(await accountIndexes(sql)).toEqual(indexesBefore);
    expect(await accountRows(sql)).toEqual(rowsBefore);
  }, 60_000);

  it("succeeds for both of two instances applying it at the same time", async () => {
    const { database, sql } = await startIssuerLineageDatabase("paperclip-issuer-relax-concurrent-");
    const first = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const second = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await first.end();
      await second.end();
    });

    // Deterministic interleaving: the first applier holds the ALTER lock
    // uncommitted while the second one, which has already seen NOT NULL, queues
    // behind it.
    await first.unsafe("BEGIN");
    await first.unsafe(migrationSql);
    await second.unsafe("BEGIN");
    // `.then` sends the query now; the outcome is collected after the first commit.
    const secondBody = second.unsafe(migrationSql).then(
      () => "applied",
      (error: unknown) => error,
    );
    let secondWaited = false;
    for (let attempt = 0; attempt < 100 && !secondWaited; attempt += 1) {
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%DROP NOT NULL%'
      `;
      secondWaited = (row?.count ?? 0) > 0;
      if (!secondWaited) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(secondWaited).toBe(true);
    await first.unsafe("COMMIT");
    expect(await secondBody).toBe("applied");
    await second.unsafe("COMMIT");
    expect(await issuerColumn(sql)).toMatchObject({ is_nullable: "YES" });

    // The real runner, twice at once, on a database where 9100 is still pending.
    await sql`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`;
    await Promise.all([
      applyPendingMigrations(database.connectionString),
      applyPendingMigrations(database.connectionString),
    ]);
    expect(await issuerColumn(sql)).toMatchObject({ is_nullable: "YES" });
    expect(await migrationHistoryCount(sql)).toBeGreaterThanOrEqual(1);
    expect((await accountIndexes(sql)).map((row) => row.indexname)).toContain(ISSUER_INDEX);
  }, 60_000);
});
