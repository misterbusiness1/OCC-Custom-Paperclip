import { afterEach, describe, expect, it } from "vitest";
import { isLoopbackHostname, resolveBaseUrl, validateBaseUrlForCredential } from "./base-url.js";

function check(baseUrl: string, source: "company" | "host") {
  return validateBaseUrlForCredential(resolveBaseUrl({ baseUrl }), source);
}

describe("minimax_local baseUrl guard", () => {
  afterEach(() => {
    delete process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS;
  });

  it("treats the canonical https URL (and an unset baseUrl) as default", () => {
    expect(resolveBaseUrl({}).isDefault).toBe(true);
    expect(resolveBaseUrl({ baseUrl: "https://api.minimax.io/v1" }).isDefault).toBe(true);
    expect(resolveBaseUrl({ baseUrl: "HTTPS://API.MINIMAX.IO/v1/" }).isDefault).toBe(true);
    expect(check("https://api.minimax.io/v1", "host")).toBeNull();
  });

  it("does not treat an http downgrade of the official host as default (host key never sent in cleartext)", () => {
    for (const baseUrl of ["http://api.minimax.io/v1", "HTTP://API.MINIMAX.IO/v1"]) {
      const resolved = resolveBaseUrl({ baseUrl });
      expect(resolved.isDefault).toBe(false);
      expect(validateBaseUrlForCredential(resolved, "host")).toMatch(/https/);
      expect(validateBaseUrlForCredential(resolved, "company")).toMatch(/https/);
    }
  });

  it("rejects a query string, fragment or userinfo even on the official host", () => {
    for (const baseUrl of [
      "https://api.minimax.io/v1?",
      "https://api.minimax.io/v1?x=1",
      "https://api.minimax.io/v1#",
      "https://user:pw@api.minimax.io/v1",
      "http://127.0.0.1:8080/secret?x=",
    ]) {
      const resolved = resolveBaseUrl({ baseUrl });
      expect(resolved.isDefault).toBe(false);
      expect(validateBaseUrlForCredential(resolved, "company")).not.toBeNull();
    }
  });

  it("matches loopback only for exact names and IP literals", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.5.6.7")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.attacker.example")).toBe(false);
    expect(isLoopbackHostname("127.0.0.1.nip.io")).toBe(false);
    expect(isLoopbackHostname("localhost.attacker.example")).toBe(false);
    expect(isLoopbackHostname("128.0.0.1")).toBe(false);
  });

  it("requires https for DNS names that merely start with 127.", () => {
    expect(check("http://127.attacker.example/v1", "company")).toMatch(/https/);
    expect(check("http://127.0.0.1.nip.io/v1", "company")).toMatch(/https/);
  });

  it("allows plain http to a loopback IP literal with a company key, never with the host key", () => {
    expect(check("http://127.0.0.1:9999/v1", "company")).toBeNull();
    expect(check("http://localhost:9999/v1", "company")).toBeNull();
    expect(check("http://[::1]:9999/v1", "company")).toBeNull();
    expect(check("http://127.0.0.1:9999/v1", "host")).toMatch(/Refusing/);
  });

  it("applies the operator allowlist to every custom host, loopback included", () => {
    process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS = "api.minimaxi.com";
    expect(check("https://api.minimaxi.com/v1", "company")).toBeNull();
    expect(check("https://evil.example/v1", "company")).toMatch(/not permitted/);
    expect(check("http://127.attacker.example/v1", "company")).not.toBeNull();
    expect(check("http://127.0.0.1:9999/v1", "company")).toMatch(/not permitted/);
    process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS = "api.minimaxi.com,127.0.0.1:9999";
    expect(check("http://127.0.0.1:9999/v1", "company")).toBeNull();
  });
});
