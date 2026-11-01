/**
 * Better Auth's Origin check and auth-origin derivation on 1.7.10, through
 * Paperclip's real auth chain (see helpers/better-auth-app.ts).
 *
 * Better Auth turns its Origin check off by default when NODE_ENV is "test"
 * or TEST is truthy, both of which Vitest sets. It reads NODE_ENV once, when
 * its core module loads, and TEST when an auth instance is created. This file
 * therefore switches NODE_ENV to "production" (what the shipped images run)
 * before it imports anything that loads Better Auth, clears TEST, and restores
 * both afterwards.
 *
 * 1.7 changed proxy-header trust only for dynamic baseURL ({ allowedHosts }),
 * which Paperclip never uses. These tests pin the two modes Paperclip does use:
 * explicit (static baseURL from PAPERCLIP_PUBLIC_URL / auth.publicBaseUrl) and
 * auto (no baseURL; the origin comes from the Host header and
 * X-Forwarded-Proto, never X-Forwarded-Host, unless
 * advanced.trustedProxyHeaders is set, which Paperclip does not do).
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalTestFlag = process.env.TEST;
process.env.NODE_ENV = "production";
delete process.env.TEST;
const { hashPassword } = await import("better-auth/crypto");
const {
  BETTER_AUTH_TEST_ORIGIN: ORIGIN,
  betterAuthTestConfig,
  buildBetterAuthTestApp,
  insertLegacyCredentialUser,
  sessionCookie,
  useBetterAuthTestEnv,
} = await import("./helpers/better-auth-app.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

useBetterAuthTestEnv();

afterAll(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalTestFlag === undefined) delete process.env.TEST;
  else process.env.TEST = originalTestFlag;
});

describeEmbeddedPostgres("Better Auth 1.7.10 origin handling in Paperclip's deployment modes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-origin-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function signedInCookie(app: Parameters<typeof request>[0], origin: string, host?: string) {
    const email = `origin-${randomUUID()}@example.test`;
    const password = "origin-check-password";
    await insertLegacyCredentialUser(db, { email, passwordHash: await hashPassword(password) });
    let signIn = request(app).post("/api/auth/sign-in/email").set("origin", origin);
    if (host) signIn = signIn.set("host", host).set("x-forwarded-proto", "http");
    const response = await signIn.send({ email, password });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return sessionCookie(response);
  }

  it("explicit mode: rejects cookie-bearing requests from untrusted or missing origins", async () => {
    const app = buildBetterAuthTestApp(db);
    const cookie = await signedInCookie(app, ORIGIN);

    const foreign = await request(app)
      .post("/api/auth/sign-out")
      .set("origin", "http://attacker.example")
      .set("x-forwarded-host", "attacker.example")
      .set("cookie", cookie)
      .send({});
    expect(foreign.status).toBe(403);

    const missing = await request(app).post("/api/auth/sign-out").set("cookie", cookie).send({});
    expect(missing.status).toBe(403);

    const trusted = await request(app)
      .post("/api/auth/sign-out")
      .set("origin", ORIGIN)
      .set("cookie", cookie)
      .send({});
    expect(trusted.status, JSON.stringify(trusted.body)).toBe(200);
  });

  it("auto mode: derives the trusted auth origin from Host and ignores X-Forwarded-Host", async () => {
    const app = buildBetterAuthTestApp(
      db,
      betterAuthTestConfig({ authBaseUrlMode: "auto", authPublicBaseUrl: undefined }),
      [ORIGIN],
    );
    const host = "paperclip.internal:3100";
    const hostOrigin = `http://${host}`;
    const cookie = await signedInCookie(app, hostOrigin, host);

    // Auto mode trusts the origin Better Auth derives from the request. If it
    // took X-Forwarded-Host, a client could choose that origin itself and this
    // request would pass.
    const spoofed = await request(app)
      .post("/api/auth/sign-out")
      .set("host", host)
      .set("x-forwarded-proto", "http")
      .set("x-forwarded-host", "attacker.example")
      .set("origin", "http://attacker.example")
      .set("cookie", cookie)
      .send({});
    expect(spoofed.status).toBe(403);

    const hostDerived = await request(app)
      .post("/api/auth/sign-out")
      .set("host", host)
      .set("x-forwarded-proto", "http")
      .set("x-forwarded-host", "attacker.example")
      .set("origin", hostOrigin)
      .set("cookie", cookie)
      .send({});
    expect(hostDerived.status, JSON.stringify(hostDerived.body)).toBe(200);
  });
});
