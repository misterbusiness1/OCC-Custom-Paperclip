import { describe, expect, it } from "vitest";
import { redactSensitive } from "../middleware/redact-sensitive.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import express from "express";
import request from "supertest";
import pino from "pino";
import { PassThrough } from "node:stream";
import { createHttpLogger } from "../middleware/logger.js";

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
