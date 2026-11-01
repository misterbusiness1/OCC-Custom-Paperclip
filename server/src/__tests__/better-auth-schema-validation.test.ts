/**
 * Better Auth 1.7.3+ validates the Drizzle schema it is given before every
 * auth.api call and every request through its handler, and throws
 * SchemaMismatchError (code SCHEMA_MISMATCH) when a table is missing a column
 * Better Auth writes, or has a NOT NULL column without a default that Better
 * Auth never writes. The check reads only the Drizzle table objects, so no
 * database is needed here.
 *
 * The second test is the guard for future merges: upstream Paperclip's schema
 * for Better Auth 1.7.0-1.7.2 declares `issuer: text("issuer").notNull()` on
 * the account table. If that (or any other required column Better Auth does
 * not write) lands in packages/db/src/schema/auth.ts, every sign-in, sign-up
 * and session lookup fails.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";

// postgres.js connects lazily; nothing here should reach it.
const UNREACHABLE_DATABASE_URL = "postgres://paperclip:paperclip@127.0.0.1:9/paperclip";
const ORIGIN = "http://127.0.0.1:41999";

const config = {
  deploymentMode: "authenticated",
  deploymentExposure: "private",
  authBaseUrlMode: "explicit",
  authPublicBaseUrl: ORIGIN,
  authDisableSignUp: false,
  allowedHostnames: ["127.0.0.1"],
  port: 41999,
} as unknown as Config;

const originalSecret = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-schema-validation-tests";
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalSecret;
});

async function getSessionWithoutCookie() {
  const { createDb } = await import("@paperclipai/db");
  const { createBetterAuthInstance } = await import("../auth/better-auth.js");
  const auth = createBetterAuthInstance(createDb(UNREACHABLE_DATABASE_URL), config, [ORIGIN]);
  const getSession = auth.api?.getSession;
  if (!getSession) throw new Error("Better Auth instance has no api.getSession");
  return getSession({ headers: new Headers() });
}

describe("Better Auth 1.7.10 runtime schema validation", () => {
  afterEach(() => {
    vi.doUnmock("@paperclipai/db");
    vi.resetModules();
  });

  it("accepts Paperclip's Drizzle auth schema", async () => {
    await expect(getSessionWithoutCookie()).resolves.toBeNull();
  });

  it("rejects auth calls once the account table has a required issuer column", async () => {
    vi.resetModules();
    vi.doMock("@paperclipai/db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@paperclipai/db")>();
      const { pgTable, text, timestamp, uniqueIndex } = await import("drizzle-orm/pg-core");
      // The account table as upstream migration 0230's schema declares it.
      const authAccounts = pgTable(
        "account",
        {
          id: text("id").primaryKey(),
          issuer: text("issuer").notNull(),
          accountId: text("account_id").notNull(),
          providerId: text("provider_id").notNull(),
          userId: text("user_id").notNull().references(() => actual.authUsers.id, { onDelete: "cascade" }),
          accessToken: text("access_token"),
          refreshToken: text("refresh_token"),
          idToken: text("id_token"),
          accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
          refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
          scope: text("scope"),
          password: text("password"),
          createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
          updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
        },
        (table) => ({
          issuerAccountIdUq: uniqueIndex("account_issuer_account_id_uq").on(table.issuer, table.accountId),
        }),
      );
      return { ...actual, authAccounts };
    });

    await expect(getSessionWithoutCookie()).rejects.toMatchObject({
      code: "SCHEMA_MISMATCH",
      message: expect.stringContaining("account.issuer"),
    });
  });
});
