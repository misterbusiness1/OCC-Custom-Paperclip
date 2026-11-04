import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackHostname,
  isNonPublicIpLiteral,
  resolveBaseUrl,
  validateBaseUrlForCredential,
} from "./base-url.js";

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

  it("refuses private, link-local and other non-public IP literals when no allowlist is set", () => {
    for (const baseUrl of [
      "https://10.0.0.5/v1",
      "https://169.254.169.254/v1",
      "https://172.16.4.2/v1",
      "https://192.168.1.10/v1",
      "https://100.64.0.1/v1",
      "https://0.0.0.0/v1",
      "https://[fd00::1]/v1",
      "https://[fe80::1]/v1",
      "https://[::]/v1",
      "https://[::ffff:169.254.169.254]/v1",
      "https://[::ffff:10.0.0.5]/v1",
      "https://[::ffff:127.0.0.1]/v1",
    ]) {
      expect(check(baseUrl, "company"), baseUrl).toMatch(/non-public/);
    }
    // Public literals and DNS names are still accepted (DNS is not resolved).
    expect(check("https://8.8.8.8/v1", "company")).toBeNull();
    expect(check("https://internal.corp/v1", "company")).toBeNull();
    // Loopback stays the documented on-box exception.
    expect(check("http://127.0.0.1:5432/x", "company")).toBeNull();
  });

  it("lets the operator allowlist a private host explicitly", () => {
    process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS = "10.0.0.5";
    expect(check("https://10.0.0.5/v1", "company")).toBeNull();
    expect(check("https://10.0.0.6/v1", "company")).toMatch(/not permitted/);
  });

  it("classifies IP literals for the non-public check", () => {
    expect(isNonPublicIpLiteral("169.254.169.254")).toBe(true);
    expect(isNonPublicIpLiteral("[fe80::1]")).toBe(true);
    expect(isNonPublicIpLiteral("8.8.8.8")).toBe(false);
    expect(isNonPublicIpLiteral("api.minimax.io")).toBe(false);
    expect(isNonPublicIpLiteral("127.0.0.1")).toBe(false);
  });
});
