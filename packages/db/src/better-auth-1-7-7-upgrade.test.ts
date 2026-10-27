import { createHash } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
const migration = fs.readFileSync(
  new URL("./migrations/9009_hesitant_mockingbird.sql", import.meta.url),
  "utf8",
);
const migrationHash = createHash("sha256").update(migration).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const integration = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function legacyDatabase(duplicate = false) {
  const database = await startEmbeddedPostgresTestDatabase(
    "paperclip-auth-177-upgrade-",
  );
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1 });
  cleanups.push(async () => sql.end());
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = ${migrationHash}`;
  await sql`INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ('legacy-user','Legacy','legacy@example.test',now(),now())`;
  await sql`INSERT INTO "account" (id,issuer,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ('legacy-account','local:credential','legacy-user','credential','legacy-user','unchanged-password-hash',now(),now())`;
  await sql`ALTER TABLE "account" ALTER COLUMN issuer SET NOT NULL`;
  await sql`CREATE UNIQUE INDEX account_issuer_account_id_uq ON "account" (issuer,account_id)`;
  if (duplicate)
    await sql`INSERT INTO "account" (id,issuer,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ('ambiguous-account','different-legacy-issuer','legacy-user','credential','legacy-user','second-unchanged-hash',now(),now())`;
  return { database, sql };
}
integration("Better Auth 1.7.2 to 1.7.7 account migration", () => {
  it("preserves legacy fields and permits new accounts without issuer, including different providers sharing an account ID", async () => {
    const { database, sql } = await legacyDatabase();
    const before = await sql`SELECT * FROM "account" ORDER BY id`;
    await applyPendingMigrations(database.connectionString);
    expect(await sql`SELECT * FROM "account" ORDER BY id`).toEqual(before);
    const [column] =
      await sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='account' AND column_name='issuer'`;
    expect(column.is_nullable).toBe("YES");
    expect(
      await sql`SELECT indexname FROM pg_indexes WHERE tablename='account' AND indexname='account_issuer_account_id_uq'`,
    ).toHaveLength(0);
    await sql`INSERT INTO "account" (id,account_id,provider_id,user_id,created_at,updated_at) VALUES ('new-account','shared-account-id','credential','legacy-user',now(),now()),('other-provider','shared-account-id','github','legacy-user',now(),now())`;
    const created =
      await sql`SELECT issuer FROM "account" WHERE id IN ('new-account','other-provider')`;
    expect(created.map((row) => row.issuer)).toEqual([null, null]);
    await applyPendingMigrations(database.connectionString);
    expect(await sql`SELECT id FROM "account"`).toHaveLength(3);
  }, 30000);
  it("refuses ambiguous provider/account pairs before any constraint or data changes", async () => {
    const { database, sql } = await legacyDatabase(true);
    const before = await sql`SELECT * FROM "account" ORDER BY id`;
    await expect(
      applyPendingMigrations(database.connectionString),
    ).rejects.toThrow(/Duplicate Better Auth provider\/account keys/);
    expect(await sql`SELECT * FROM "account" ORDER BY id`).toEqual(before);
    const [column] =
      await sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='account' AND column_name='issuer'`;
    expect(column.is_nullable).toBe("NO");
    expect(
      await sql`SELECT indexname FROM pg_indexes WHERE tablename='account' AND indexname='account_issuer_account_id_uq'`,
    ).toHaveLength(1);
  }, 30000);
});
