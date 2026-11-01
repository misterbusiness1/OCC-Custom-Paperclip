import { randomUUID } from "node:crypto";
import express from "express";
import type request from "supertest";
import { afterAll, beforeAll, expect } from "vitest";
import { authAccounts, authUsers, type createDb } from "@paperclipai/db";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  deriveAuthCookiePrefix,
  resolveBetterAuthSession,
} from "../../auth/better-auth.js";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/index.js";
import { authRoutes } from "../../routes/auth.js";
import type { Config } from "../../config.js";

export type TestDb = ReturnType<typeof createDb>;

export const BETTER_AUTH_TEST_ORIGIN = "http://127.0.0.1:41999";
export const BETTER_AUTH_TEST_SECRET = "better-auth-secret-for-auth-route-tests";

export function betterAuthTestConfig(overrides: Partial<Config> = {}): Config {
  // createBetterAuthInstance reads only the auth fields of Config.
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: BETTER_AUTH_TEST_ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41999,
    ...overrides,
  } as unknown as Config;
}

/**
 * Paperclip's authenticated-mode auth chain, mounted in createApp's order:
 * body parser, actorMiddleware (session cookie -> board actor), Paperclip's
 * own /api/auth routes (get-session, profile), then Better Auth's catch-all
 * for sign-up, sign-in and sign-out.
 */
export function buildBetterAuthTestApp(
  db: TestDb,
  config = betterAuthTestConfig(),
  trustedOrigins = [BETTER_AUTH_TEST_ORIGIN],
) {
  const auth = createBetterAuthInstance(db, config, trustedOrigins);
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: (req) => resolveBetterAuthSession(auth, req),
    }),
  );
  app.use("/api/auth", authRoutes(db));
  app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  app.use(errorHandler);
  return app;
}

/** Sets the env createBetterAuthInstance reads for the duration of a test file. */
export function useBetterAuthTestEnv() {
  const keys = [
    "BETTER_AUTH_SECRET",
    "PAPERCLIP_AUTH_RATE_LIMIT_ENABLED",
    "PAPERCLIP_PUBLIC_URL",
    "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
  ] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = BETTER_AUTH_TEST_SECRET;
    // Authenticated mode enables Better Auth's rate limiter, which would score
    // back-to-back requests from one test.
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    delete process.env.PAPERCLIP_PUBLIC_URL;
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  });
  afterAll(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * Better Auth's session cookie name. Local http origins keep the cookie
 * non-secure, with no prefix; an https base URL makes it secure, which adds
 * the __Secure- prefix.
 */
export function sessionCookieName(opts: { secure?: boolean } = {}) {
  return `${opts.secure ? "__Secure-" : ""}${deriveAuthCookiePrefix()}.session_token`;
}

export function setCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** The session cookie a browser would send back, as `name=value`. */
export function sessionCookie(response: request.Response, name = sessionCookieName()): string {
  const cookie = setCookies(response).find((value) => value.startsWith(`${name}=`));
  expect(cookie, `no ${name} in ${JSON.stringify(setCookies(response))}`).toBeTruthy();
  return cookie!.split(";")[0]!;
}

/** A user plus credential account in the exact shape Better Auth 1.6.23 sign-up wrote. */
export async function insertLegacyCredentialUser(db: TestDb, input: { email: string; passwordHash: string }) {
  const userId = `legacy-${randomUUID()}`;
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: "Legacy User",
    email: input.email,
    emailVerified: false,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(authAccounts).values({
    id: `account-${randomUUID()}`,
    accountId: userId,
    providerId: "credential",
    userId,
    password: input.passwordHash,
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}
