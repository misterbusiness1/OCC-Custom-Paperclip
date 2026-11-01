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
 * advanced.trustedProxyHeaders is set, which Paperclip does not do). They also
 * pin the secure session cookie of an https deployment behind a
 * TLS-terminating proxy, and that Paperclip's own get-session route resolves
 * the session in each mode (actorMiddleware only logs resolveSession errors,
 * so a broken lookup would otherwise look like an anonymous request).
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
const { deriveAuthTrustedOrigins } = await import("../auth/better-auth.js");
const {
  BETTER_AUTH_TEST_ORIGIN: ORIGIN,
  betterAuthTestConfig,
  buildBetterAuthTestApp,
  insertLegacyCredentialUser,
  sessionCookie,
  sessionCookieName,
  setCookies,
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

  type App = Parameters<typeof request>[0];
  type Proxy = { host: string; proto: "http" | "https" };

  function viaProxy<T extends request.Test>(test: T, proxy?: Proxy): T {
    return proxy ? (test.set("host", proxy.host).set("x-forwarded-proto", proxy.proto) as T) : test;
  }

  async function signIn(app: App, origin: string, proxy?: Proxy) {
    const email = `origin-${randomUUID()}@example.test`;
    const password = "origin-check-password";
    const userId = await insertLegacyCredentialUser(db, { email, passwordHash: await hashPassword(password) });
    const response = await viaProxy(request(app).post("/api/auth/sign-in/email").set("origin", origin), proxy).send({
      email,
      password,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { response, userId };
  }

  async function signedInCookie(app: App, origin: string, proxy?: Proxy) {
    const { response, userId } = await signIn(app, origin, proxy);
    return { cookie: sessionCookie(response), userId };
  }

  /** Paperclip's own get-session route, which resolves the cookie through actorMiddleware. */
  async function getSession(app: App, cookie: string, proxy?: Proxy) {
    return viaProxy(request(app).get("/api/auth/get-session").set("cookie", cookie), proxy);
  }

  async function expectSessionFor(app: App, cookie: string, userId: string, proxy?: Proxy) {
    const session = await getSession(app, cookie, proxy);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    expect(session.body.user?.id).toBe(userId);
    expect(session.body.session?.userId).toBe(userId);
  }

  it("explicit mode: rejects cookie-bearing requests from untrusted or missing origins", async () => {
    const app = buildBetterAuthTestApp(db);
    const { cookie, userId } = await signedInCookie(app, ORIGIN);
    await expectSessionFor(app, cookie, userId);

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
    const proxy: Proxy = { host, proto: "http" };
    const { cookie, userId } = await signedInCookie(app, hostOrigin, proxy);
    // Paperclip's get-session resolves the session without a configured baseURL.
    await expectSessionFor(app, cookie, userId, proxy);

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
    expect((await getSession(app, cookie, proxy)).status).toBe(401);
  });

  it("public https behind a TLS-terminating proxy: secure session cookie, get-session and sign-out", async () => {
    const publicUrl = "https://pc.example.test";
    const config = betterAuthTestConfig({
      deploymentExposure: "public",
      authPublicBaseUrl: publicUrl,
      allowedHostnames: ["pc.example.test"],
    });
    const app = buildBetterAuthTestApp(db, config, deriveAuthTrustedOrigins(config));
    // The proxy forwards to the container's internal address over http.
    const proxy: Proxy = { host: "paperclip:3100", proto: "https" };
    const secureName = sessionCookieName({ secure: true });
    expect(secureName).toBe(`__Secure-${sessionCookieName()}`);

    const { response, userId } = await signIn(app, publicUrl, proxy);
    const setCookie = setCookies(response).find((value) => value.startsWith(`${secureName}=`));
    expect(setCookie, JSON.stringify(setCookies(response))).toBeTruthy();
    const attributes = setCookie!.split(";").slice(1).map((part) => part.trim().toLowerCase());
    expect(attributes).toEqual(
      expect.arrayContaining(["max-age=604800", "path=/", "httponly", "secure", "samesite=lax"]),
    );
    expect(setCookies(response).some((value) => value.startsWith(`${sessionCookieName()}=`))).toBe(false);

    const cookie = sessionCookie(response, secureName);
    await expectSessionFor(app, cookie, userId, proxy);

    const signOut = await viaProxy(
      request(app).post("/api/auth/sign-out").set("origin", publicUrl).set("cookie", cookie),
      proxy,
    ).send({});
    expect(signOut.status, JSON.stringify(signOut.body)).toBe(200);
    const cleared = setCookies(signOut).find((value) => value.startsWith(`${secureName}=;`));
    expect(cleared, JSON.stringify(setCookies(signOut))).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/;\s*Secure(;|$)/i);
    expect((await getSession(app, cookie, proxy)).status).toBe(401);
  });
});
