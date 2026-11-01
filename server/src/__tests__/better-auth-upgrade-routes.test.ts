/**
 * Better Auth 1.7.10 upgrade coverage, driven through Paperclip's real auth
 * chain against migrated embedded Postgres databases:
 *
 *   express.json -> actorMiddleware -> /api/auth (Paperclip's get-session)
 *   -> /api/auth/{*authPath} (Better Auth: sign-up, sign-in, sign-out)
 *
 * mounted in the same order as createApp. Sign-in, sign-up and sign-out are
 * Better Auth endpoints; /api/auth/get-session is Paperclip's own route, which
 * resolves the session cookie through actorMiddleware and Better Auth's
 * getSession.
 *
 * Every request also passes Better Auth 1.7's runtime schema validation
 * against Paperclip's Drizzle auth schema (the router awaits it before any
 * endpoint runs), so a merge that adds a NOT NULL column Better Auth never
 * writes fails these requests.
 *
 * Vitest runs with NODE_ENV=test, under which Better Auth skips its Origin
 * check, so the Origin headers below only mirror what the UI sends.
 * better-auth-origin-routes.test.ts runs the same chain with that check on.
 */

import { createHash, createHmac, randomBytes, randomUUID, scrypt } from "node:crypto";
import fs from "node:fs";
import type express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, authAccounts, authSessions, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  BETTER_AUTH_TEST_ORIGIN as ORIGIN,
  BETTER_AUTH_TEST_SECRET as SECRET,
  buildBetterAuthTestApp as buildApp,
  insertLegacyCredentialUser,
  sessionCookie,
  sessionCookieName,
  setCookies,
  type TestDb as Db,
  useBetterAuthTestEnv,
} from "./helpers/better-auth-app.js";

const RELAX_ISSUER_MIGRATION = "9100_better_auth_relax_account_issuer.sql";

const dbSourceDir = new URL("../../../packages/db/src/", import.meta.url);
const upstream0230Sql = fs.readFileSync(
  new URL("__fixtures__/better-auth-issuer/upstream-0230-better-auth-account-issuer.sql", dbSourceDir),
  "utf8",
);
const release9009Sql = fs.readFileSync(
  new URL("__fixtures__/better-auth-issuer/release-9009-hesitant-mockingbird.sql", dbSourceDir),
  "utf8",
);
const relaxIssuerMigrationSql = fs.readFileSync(new URL(`migrations/${RELAX_ISSUER_MIGRATION}`, dbSourceDir), "utf8");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

useBetterAuthTestEnv();

/** Splits a migration like packages/db/src/client.ts and runs it in one transaction. */
async function runMigrationSql(db: Db, content: string) {
  const statements = content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  await db.transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}

/**
 * The Better Auth 1.6.x hash format, computed independently of the installed
 * Better Auth: scrypt N=16384 r=16 p=1 dkLen=64 over the NFKC password, with a
 * 16-byte hex salt, stored as `salt:key` (the @better-auth/utils 0.4.2
 * implementation that better-auth 1.6.23 used).
 */
async function betterAuth16ScryptHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      64,
      { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
  return `${salt}:${key.toString("hex")}`;
}

/**
 * A session cookie value signed the way better-call signs it in both the 1.6
 * and 1.7 lines, computed independently of the installed Better Auth:
 * `token.signature`, where the signature is base64 HMAC-SHA256 of the token
 * keyed with the auth secret, then URI-encoded.
 */
function betterAuth16SignedCookieValue(token: string, secret: string): string {
  return encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
}

async function rawAccountsForUser(db: Db, userId: string) {
  return (await db.execute(
    sql`SELECT * FROM "account" WHERE "user_id" = ${userId} ORDER BY "id"`,
  )) as unknown as Array<Record<string, unknown>>;
}

async function expectSignedInAs(app: express.Express, cookie: string, userId: string) {
  const session = await request(app).get("/api/auth/get-session").set("cookie", cookie);
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  expect(session.body.user?.id).toBe(userId);
  expect(session.body.session?.userId).toBe(userId);
}

async function signOut(app: express.Express, cookie: string) {
  const response = await request(app).post("/api/auth/sign-out").set("origin", ORIGIN).set("cookie", cookie).send({});
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({ success: true });
  // The session cookie is cleared, not just left to expire.
  expect(setCookies(response).find((value) => value.startsWith(`${sessionCookieName()}=;`))).toMatch(/Max-Age=0/i);
  const after = await request(app).get("/api/auth/get-session").set("cookie", cookie);
  expect(after.status).toBe(401);
}

describeEmbeddedPostgres("Better Auth 1.7.10 on a master-lineage database", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let app!: express.Express;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-upgrade-master-");
    db = createDb(database.connectionString);
    app = buildApp(db);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("has no issuer column, so migration 9100 had nothing to relax", async () => {
    const columns = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'account'
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name)).not.toContain("issuer");
  });

  it("signs up, resolves the session through Paperclip's get-session route, and signs out", async () => {
    const email = "founder@example.test";
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email, password: "correct-horse-battery-staple", name: "Founder" });
    expect(signUp.status, JSON.stringify(signUp.body)).toBe(200);
    const userId = signUp.body.user?.id as string;
    expect(signUp.body.user?.email).toBe(email);

    const accounts = await db.select().from(authAccounts);
    const account = accounts.find((row) => row.userId === userId);
    expect(account).toMatchObject({ providerId: "credential", accountId: userId });
    expect(account?.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);

    const cookie = sessionCookie(signUp);
    await expectSignedInAs(app, cookie, userId);
    await signOut(app, cookie);
    const sessions = await db.select().from(authSessions);
    expect(sessions.filter((row) => row.userId === userId)).toHaveLength(0);
  });

  it.each([
    ["Better Auth's own hashPassword", (password: string) => hashPassword(password)],
    ["an independent scrypt hash in the 1.6 format", betterAuth16ScryptHash],
  ])("signs in a user whose 1.6.23 credential account holds %s", async (_label, hash) => {
    const email = `legacy-${randomUUID()}@example.test`;
    const password = "legacy-password-from-1-6";
    const userId = await insertLegacyCredentialUser(db, { email, passwordHash: await hash(password) });
    const accountsBefore = await rawAccountsForUser(db, userId);

    const wrong = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email, password: "not-the-password" });
    expect(wrong.status).toBe(401);

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email, password });
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
    expect(signIn.body.user?.id).toBe(userId);
    // Signing in neither rewrites the password hash nor adds an account row.
    expect(await rawAccountsForUser(db, userId)).toEqual(accountsBefore);

    const cookie = sessionCookie(signIn);
    await expectSignedInAs(app, cookie, userId);
    await signOut(app, cookie);
  });

  it("keeps a session row and cookie issued before the upgrade", async () => {
    const userId = await insertLegacyCredentialUser(db, {
      email: `pre-upgrade-session-${randomUUID()}@example.test`,
      passwordHash: await hashPassword("unused-password"),
    });
    const token = randomBytes(24).toString("hex");
    const now = new Date();
    await db.insert(authSessions).values({
      id: `session-${randomUUID()}`,
      token,
      userId,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    });
    const signedValue = betterAuth16SignedCookieValue(token, SECRET);
    await expectSignedInAs(app, `${sessionCookieName()}=${signedValue}`, userId);

    const tampered = betterAuth16SignedCookieValue(token, "some-other-secret");
    const rejected = await request(app)
      .get("/api/auth/get-session")
      .set("cookie", `${sessionCookieName()}=${tampered}`);
    expect(rejected.status).toBe(401);
  });
});

describeEmbeddedPostgres("Better Auth 1.7.10 on a 1.7.2-lineage database (upstream migration 0230)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let app!: express.Express;
  let legacyUserId = "";
  const legacyEmail = "legacy-172@example.test";
  const legacyPassword = "legacy-password-from-1-7-2";

  async function issuerNullable() {
    const rows = (await db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'
    `)) as unknown as Array<{ is_nullable: string }>;
    return rows[0]?.is_nullable;
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-upgrade-172-");
    db = createDb(database.connectionString);
    // Rebuild the 1.7.2 lineage: forget 9100, keep a 1.6-shaped account row,
    // then run upstream 0230 verbatim (backfill, SET NOT NULL, unique index).
    const relaxIssuerMigrationHash = createHash("sha256").update(relaxIssuerMigrationSql).digest("hex");
    await db.execute(sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${relaxIssuerMigrationHash}`);
    legacyUserId = await insertLegacyCredentialUser(db, {
      email: legacyEmail,
      passwordHash: await hashPassword(legacyPassword),
    });
    await runMigrationSql(db, upstream0230Sql);
    app = buildApp(db);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("starts from issuer NOT NULL with the issuer unique index", async () => {
    expect(await issuerNullable()).toBe("NO");
    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'account'
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).toContain("account_issuer_account_id_uq");
    expect(await rawAccountsForUser(db, legacyUserId)).toEqual([
      expect.objectContaining({ issuer: "local:credential", provider_id: "credential" }),
    ]);
  });

  it("cannot sign up before migration 9100, because 1.7.10 never writes issuer", async () => {
    const blocked = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "blocked@example.test", password: "blocked-password-123", name: "Blocked" });
    // The NOT NULL violation on the account insert surfaces as a bare 500.
    expect(blocked.status).toBe(500);
    const accounts = (await db.execute(sql`
      SELECT a."id" FROM "account" a JOIN "user" u ON u."id" = a."user_id"
      WHERE u."email" = 'blocked@example.test'
    `)) as unknown as unknown[];
    expect(accounts).toHaveLength(0);
  });

  it("signs up after migration 9100 and stores a NULL issuer", async () => {
    await applyPendingMigrations(database!.connectionString);
    expect(await issuerNullable()).toBe("YES");

    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "after-relax@example.test", password: "after-relax-password", name: "After Relax" });
    expect(signUp.status, JSON.stringify(signUp.body)).toBe(200);
    const userId = signUp.body.user?.id as string;
    expect(await rawAccountsForUser(db, userId)).toEqual([
      expect.objectContaining({ provider_id: "credential", account_id: userId, issuer: null }),
    ]);
    const cookie = sessionCookie(signUp);
    await expectSignedInAs(app, cookie, userId);
    await signOut(app, cookie);
  });

  it("signs in an existing account that carries a 1.7.2 issuer value, and keeps that value", async () => {
    const before = await rawAccountsForUser(db, legacyUserId);
    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: legacyEmail, password: legacyPassword });
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
    expect(await rawAccountsForUser(db, legacyUserId)).toEqual(before);
    expect(before[0]).toMatchObject({ issuer: "local:credential" });
    const cookie = sessionCookie(signIn);
    await expectSignedInAs(app, cookie, legacyUserId);
    await signOut(app, cookie);
  });

  it("still accepts release migration 9009 afterwards, and sign-up keeps working", async () => {
    await runMigrationSql(db, release9009Sql);
    expect(await issuerNullable()).toBe("YES");
    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'account'
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).not.toContain("account_issuer_account_id_uq");

    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "after-9009@example.test", password: "after-9009-password", name: "After 9009" });
    expect(signUp.status, JSON.stringify(signUp.body)).toBe(200);
    expect(await rawAccountsForUser(db, signUp.body.user?.id as string)).toEqual([
      expect.objectContaining({ issuer: null }),
    ]);
  });
});
