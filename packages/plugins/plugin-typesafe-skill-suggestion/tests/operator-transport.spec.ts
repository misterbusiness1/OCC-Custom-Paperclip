import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { operatorTransportOptions } from "../src/operator-transport.js";

const root = mkdtempSync(path.join(tmpdir(), "typesafe-tls-"));
let server: Server;
let origin: string;
let certificate: string;
let attempts = 0;
let mode = "ok";
beforeAll(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "ca.pem"), "-days", "1", "-subj", "/CN=controlled.example", "-addext", "subjectAltName=DNS:controlled.example"], { stdio: "ignore" });
  certificate = readFileSync(path.join(root, "ca.pem"), "utf8");
  server = createServer({ key: readFileSync(path.join(root, "key.pem")), cert: certificate }, (req, res) => {
    attempts++;
    if (mode === "typed") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        if (req.headers.authorization !== "Bearer owned-synthetic-test") { res.writeHead(401); res.end("{}"); return; }
        const body = JSON.parse(raw);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: body.model, answers: {
          skill: { type: "choice", choice: "one", probabilities: { one: 1, two: 0 }, confidence: 1 },
          needed: { type: "noul", noul: 0.9 },
        }, usage: { input_tokens: 12, output_tokens: 3 } }));
      });
      return;
    }
    req.resume();
    if (mode === "redirect") { res.writeHead(307, { location: "https://metadata.example/v1/systemone" }); res.end(); }
    else if (mode === "large") { res.end("x".repeat(1024 * 1024 + 1)); }
    else if (mode === "delay") { setTimeout(() => res.end("{}"), 100); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, authority: req.headers.host })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `https://controlled.example:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
// This unit seam tests TLS on loopback; the host parser separately rejects
// loopback for installed worker profiles. No operator policy is relaxed here.
function transport(overrides: Record<string, unknown> = {}) {
  return operatorTransportOptions(JSON.stringify({ baseURL: origin, addresses: ["127.0.0.1"], caPem: certificate, ...overrides }));
}
function post(t = transport(), url = `${origin}/v1/systemone`, options: RequestInit = {}) {
  return t.fetch(url, { method: "POST", body: "{}", ...options });
}
describe("plugin-local pinned TLS transport", () => {
  it("uses pinned address while retaining TLS name verification and HTTP authority", async () => {
    mode = "ok";
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, authority: new URL(origin).host });
  });
  it("supports an authenticated real SDK typed request with bounded usage", async () => {
    mode = "typed";
    const client = new TypeSafeClient({ ...transport(), apiKey: "owned-synthetic-test", retry: { maxRetries: 0 }, timeout: 1000, logLevel: "off" });
    const before = attempts;
    const answer = await client.systemOne({ model: "jev-1.13.0", state: { request: "Synthetic qualification" }, questions: {
      skill: choice("Choose", { one: "First", two: "Second" }),
      needed: noul("Needed", { true: "Yes", false: "No" }),
    } });
    expect(answer.answers.skill.choice).toBe("one");
    expect(answer.answers.needed.noul).toBe(0.9);
    expect(answer.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(attempts).toBe(before + 1);
    mode = "ok";
  });
  it("rejects untrusted certificates without sending HTTP credentials", async () => {
    const before = attempts;
    await expect(post(transport({ caPem: null }))).rejects.toThrow("TypeSafe transport connection failed");
    expect(attempts).toBe(before);
  });
  it("rejects TLS hostname mismatch even with the fixture CA", async () => {
    const before = attempts;
    const wrong = origin.replace("controlled.example", "wrong.example");
    await expect(post(transport({ baseURL: wrong }), `${wrong}/v1/systemone`)).rejects.toThrow("TypeSafe transport connection failed");
    expect(attempts).toBe(before);
  });
  it("rejects redirect responses without following them", async () => {
    mode = "redirect";
    const before = attempts;
    await expect(post()).rejects.toThrow("TypeSafe transport request denied");
    expect(attempts).toBe(before + 1);
    mode = "ok";
  });
  it("rejects origin, path, query, method and request size changes before egress", async () => {
    const before = attempts;
    for (const url of ["https://evil.example/v1/systemone", `${origin}/other`, `${origin}/v1/systemone?q=x`, `${origin}/v1/systemone#x`]) {
      await expect(post(transport(), url)).rejects.toThrow("TypeSafe transport request denied");
    }
    await expect(post(transport(), undefined, { method: "PUT" })).rejects.toThrow("TypeSafe transport request denied");
    await expect(post(transport(), undefined, { body: "x".repeat(1024 * 1024 + 1) })).rejects.toThrow("TypeSafe transport request denied");
    expect(attempts).toBe(before);
  });
  it("bounds provider response size", async () => {
    mode = "large";
    await expect(post()).rejects.toThrow();
    mode = "ok";
  });
  it("preserves abort identity and rejects pre-aborted requests before egress", async () => {
    const before = attempts;
    const controller = new AbortController(); controller.abort();
    await expect(post(transport(), undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(before);
    mode = "delay";
    await expect(post(transport(), undefined, { signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ name: "AbortError" });
    mode = "ok";
  });
  it("rejects malformed or arbitrary environment-shaped profiles", () => {
    for (const raw of ["", "null", "{}", "[]", "not-json", JSON.stringify({ baseURL: origin, addresses: ["not-ip"], caPem: null }), JSON.stringify({ baseURL: origin, addresses: ["127.0.0.1"], caPem: null, NODE_TLS_REJECT_UNAUTHORIZED: "0" })]) {
      expect(() => operatorTransportOptions(raw)).toThrow("TypeSafe transport request denied");
    }
  });
});
