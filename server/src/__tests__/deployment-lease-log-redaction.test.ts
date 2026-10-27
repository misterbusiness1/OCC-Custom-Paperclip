import { describe, expect, it } from "vitest";
import { redactSensitive } from "../middleware/redact-sensitive.js";
import { isSecretSensitiveHttpRequest, isDeploymentControlHttpRequest, deploymentControlHttpLogUrl } from "../middleware/http-log-policy.js";
import express from "express";
import request from "supertest";
import pino from "pino";
import { PassThrough } from "node:stream";
import { request as rawHttpRequest } from "node:http";
import { once } from "node:events";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { startupWorkBarrierHttpGate } from "../routes/startup-work-barrier.js";
import { createStartupWorkBarrier } from "../services/startup-work-barrier.js";

const operatorRoutes = [
  "/api/instance/deployment-lease",
  "/api/instance/task-drain",
  "/api/startup-work-barrier/release",
] as const;
const routeVariants = [
  ["lowercase", (path: string) => path],
  ["uppercase", (path: string) => path.toUpperCase()],
  ["mixed case", (path: string) => path.replace(/api|instance|startup|lease|drain|release/g, x => x.toUpperCase())],
  ["mixed case trailing slash", (path: string) => `${path.toUpperCase()}/`],
  ["mixed case query", (path: string) => `${path.toUpperCase()}?copy=${"f".repeat(64)}`],
  ["mixed case trailing slash and query", (path: string) => `${path.toUpperCase()}/?copy=${"f".repeat(64)}`],
] as const;

describe("deployment capability log privacy", () => {
  it("redacts capabilities at every request envelope depth", () => {
    const secret = "fixture-capability-do-not-log";
    const value = redactSensitive({ ownerToken: secret, deploymentLease: { ownerToken: secret },
      details: { nested: { owner_token: secret } } });
    expect(JSON.stringify(value)).not.toContain(secret);
  });
  it.each(["GET", "POST", "DELETE", "PUT", "PATCH"])("uses content-free errors for %s operator requests", method => {
    for (const path of ["/api/instance/deployment-lease", "/api/instance/deployment-lease/adopt",
      "/api/instance/task-drain", "/api/startup-work-barrier/release"]) {
      expect(isSecretSensitiveHttpRequest(method, path)).toBe(true);
    }
  });
  it("classifies the full case-insensitive control namespaces without changing adjacent routes", () => {
    for (const method of ["GET", "POST", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"]) {
      for (const base of operatorRoutes) {
        for (const [, variant] of routeVariants) {
          expect(isDeploymentControlHttpRequest(method, variant(base))).toBe(true);
          expect(isSecretSensitiveHttpRequest(method, variant(base))).toBe(true);
          expect(deploymentControlHttpLogUrl(method, variant(base))).toBe(base);
        }
        expect(isDeploymentControlHttpRequest(method, `HTTPS://host.invalid${base.toUpperCase()}/unknown`)).toBe(true);
        expect(deploymentControlHttpLogUrl(method, `${base.toUpperCase()}/unknown/instance/task-drain`)).toBe(base);
        expect(deploymentControlHttpLogUrl(method, `${base.toUpperCase()}#private`)).toBe(base);
        expect(isDeploymentControlHttpRequest(method, `${base.toUpperCase()}-extra`)).toBe(false);
      }
    }
    expect(isDeploymentControlHttpRequest("POST", "/api/other/instance/deployment-lease")).toBe(false);
  });
  const routeCases = operatorRoutes.flatMap(path => routeVariants.flatMap(([variant, transform]) =>
    [200, 400, 500].map(status => ({ path, variant, requestPath: transform(path), status }))));
  it.each(routeCases)("keeps real Express $variant $path HTTP $status logs content-free", async ({ path, requestPath, status }) => {
    const token = "f".repeat(64); const stream = new PassThrough(); const chunks: string[] = [];
    stream.on("data", data => chunks.push(String(data)));
    const app = express(); app.use(createHttpLogger(pino({ level: "info", redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
    app.use(express.json());
    const router = express.Router(); let reached = false;
    // Match production's default case-insensitive /api mount and route registration.
    router.post(path.slice("/api".length), (req, res) => {
      reached = true;
      (res as any).__errorContext = { error: { name: token, message: token, stack: token },
        reqBody: req.body, reqParams: { copied: token } };
      if (status === 500) (res as any).err = new Error(token);
      res.setHeader("x-copied-response", token);
      res.status(status).json({ accepted: status === 200 });
    });
    app.use("/api", router);
    const response = await request(app).post(requestPath).set("x-copied-capability", token)
      .send({ ownerToken: token, arbitraryDuplicate: token, nested: { arbitrary: token } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(response.status).toBe(status); expect(reached).toBe(true);
    const logs = chunks.join(""); expect(logs).not.toContain(token);
    const lines = chunks.map(chunk => JSON.parse(chunk)); expect(lines).toHaveLength(1);
    expect(lines[0].req).toMatchObject({ method: "POST", url: path });
    expect(Object.keys(lines[0].req).sort()).toEqual(["id", "method", "url"]);
    expect(lines[0].res).toEqual({ statusCode: status });
    expect(lines[0].msg).toContain(`POST ${path} ${status}`);
    stream.end();
  });
  it.each(operatorRoutes)("keeps held-gate mixed-case %s rejections private before route handling", async path => {
    const token = "f".repeat(64); const chunks: string[] = []; const stream = new PassThrough();
    stream.on("data", data => chunks.push(String(data)));
    const app = express(); app.use(createHttpLogger(pino({ level: "info" }, stream))); app.use(express.json());
    app.use(startupWorkBarrierHttpGate(createStartupWorkBarrier({ PAPERCLIP_STARTUP_WORK_HELD: "true" })));
    let reached = false; app.post(path, (_req, res) => { reached = true; res.json({ reached }); });
    const response = await request(app).post(`${path.toUpperCase()}/?copy=${token}`)
      .set("x-copied-capability", token).send({ duplicate: token });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(response.status).toBe(503); expect(response.body.code).toBe("startup_work_held"); expect(reached).toBe(false);
    expect(chunks.join("")).not.toContain(token); expect(JSON.parse(chunks[0]).req.url).toBe(path);
    stream.end();
  });
  it.each(operatorRoutes)("keeps raw fragment-bearing %s request targets private when Express accepts them", async path => {
    const token = "f".repeat(64); const chunks: string[] = []; const stream = new PassThrough();
    stream.on("data", data => chunks.push(String(data)));
    const app = express(); app.use(createHttpLogger(pino({ level: "info" }, stream))); app.use(express.json());
    let observedUrl: string | undefined;
    app.post(path, (req, res) => { observedUrl = req.originalUrl; res.status(400).json({ error: "fixture rejection" }); });
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
      // Browsers/superagent remove fragments. Send the raw HTTP target to check
      // Express's actual parseurl semantics before the logger serializes it.
      const requestPath = `${path.toUpperCase()}#copy=${token}`;
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const pending = rawHttpRequest({ host: "127.0.0.1", port: address.port, path: requestPath, method: "POST",
          headers: { "content-type": "application/json", "x-copied-capability": token }, timeout: 3000 }, res => {
          res.resume(); res.on("end", () => resolve(res.statusCode)); res.on("error", reject);
        });
        pending.on("error", reject); pending.on("timeout", () => pending.destroy(new Error("HTTP fixture timed out")));
        pending.end(JSON.stringify({ ownerToken: token, arbitraryDuplicate: token }));
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(status).toBe(400); expect(observedUrl).toBe(requestPath);
      expect(chunks.join("")).not.toContain(token); expect(JSON.parse(chunks[0]).req.url).toBe(path);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      stream.end();
    }
  });
  it.each([400, 500])("does not log copied capability values in operator request/error envelopes (%s)", async status => {
    const token = "f".repeat(64); const stream = new PassThrough(); const chunks: string[] = [];
    stream.on("data", data => chunks.push(String(data)));
    const app = express(); app.use(createHttpLogger(pino({ level: "info" }, stream))); app.use(express.json());
    app.all("/{*path}", (req, res) => {
      (res as any).__errorContext = { error: { name: token, message: token, stack: token },
        reqBody: req.body, reqParams: { copied: token } };
      if (status === 500) (res as any).err = new Error(token);
      res.status(status).json({ error: "fixture rejection" });
    });
    await request(app).post(`/api/instance/deployment-lease/${token}`).set("x-copied-capability", token)
      .send({ ownerToken: token, arbitraryDuplicate: token, nested: { arbitrary: token } });
    await new Promise<void>(resolve => setImmediate(resolve));
    const log = chunks.join("");
    expect(log).not.toContain(token);
    expect(log).toContain("/api/instance/deployment-lease");
    expect(log).toContain("[REDACTED]");
    stream.end();
  });
});
