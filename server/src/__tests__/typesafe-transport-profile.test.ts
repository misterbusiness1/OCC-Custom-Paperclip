import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadTypeSafeTransportPolicy, typeSafeWorkerTransportEnv, TYPESAFE_TRANSPORT_ENV } from "../services/typesafe-transport-profile.js";

const root = mkdtempSync(path.join(tmpdir(), "typesafe-policy-"));
const uid = process.getuid!();
const profileFile = path.join(root, "profile.json");
const caFile = path.join(root, "ca.pem");
const fixture = { origin: "https://qa-typesafe.example", address: "172.30.0.3" };
const env = { PAPERCLIP_TYPESAFE_TRANSPORT_PROFILE: profileFile, PAPERCLIP_TYPESAFE_QUALIFICATION_FIXTURE: JSON.stringify(fixture),
  PAPERCLIP_TYPESAFE_TRANSPORT_MODE: "isolated_qualification", PAPERCLIP_DEPLOYMENT_EXPOSURE: "private" };
function load(profile: unknown, override: Record<string, string> = {}) {
  writeFileSync(profileFile, JSON.stringify(profile), { mode: 0o600 });
  return loadTypeSafeTransportPolicy({ ...env, ...override }, root, uid);
}
beforeAll(() => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(root, "key.pem"), "-out", caFile,
    "-days", "1", "-subj", "/CN=qa-typesafe.example", "-addext", "subjectAltName=DNS:qa-typesafe.example"], { stdio: "ignore" });
  chmodSync(caFile, 0o644);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("operator TypeSafe profile", () => {
  it("defaults to official origin without inheriting arbitrary environment", () => {
    expect(loadTypeSafeTransportPolicy({ NODE_EXTRA_CA_CERTS: "/bad", TYPESAFE_BASE_URL: "http://bad" })).toEqual({ baseURL: "https://api.typesafe.ai" });
  });
  it("accepts an exact host qualification policy with validated public CA material", () => {
    expect(load({ baseURL: fixture.origin, caBundlePath: caFile })).toEqual({ baseURL: fixture.origin, fixtureAddress: fixture.address, caPem: readFileSync(caFile, "utf8") });
  });
  it.each(["http://qa-typesafe.example", "https://user:pass@qa-typesafe.example", "https://qa-typesafe.example?q=x", "https://qa-typesafe.example#x",
    "https://qa-typesafe.example/v1", "https://127.0.0.1", "https://localhost", "https://169.254.169.254", "https://other.example", "unix:///run/socket"])('rejects URL %s', (baseURL) => {
    expect(() => load({ baseURL })).toThrow("Invalid operator TypeSafe transport profile");
  });
  it.each(["127.0.0.1", "169.254.169.254", "::1", "fe80::1", "0.0.0.0", "100.100.100.200", "::ffff:127.0.0.1", "not-an-ip"])("rejects forbidden fixture address %s", (address) => {
    expect(() => load({ baseURL: fixture.origin }, { PAPERCLIP_TYPESAFE_QUALIFICATION_FIXTURE: JSON.stringify({ ...fixture, address }) })).toThrow();
  });
  it("does not permit qualification controls in public deployment or ordinary production mode", () => {
    expect(() => load({ baseURL: fixture.origin }, { PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" })).toThrow();
    expect(() => load({ baseURL: fixture.origin }, { PAPERCLIP_TYPESAFE_TRANSPORT_MODE: "production" })).toThrow();
    expect(() => load({ baseURL: fixture.origin, env: { NODE_EXTRA_CA_CERTS: caFile } })).toThrow();
  });
  it("rejects outside, relative, symlinked, oversized, writable, and non-CA files", () => {
    const link = path.join(root, "link.pem"); symlinkSync(caFile, link);
    const pipe = path.join(root, "pipe.pem"); execFileSync("mkfifo", [pipe]);
    const linkedDir = path.join(root, "linked-dir"); symlinkSync(root, linkedDir);
    const directory = path.join(root, "directory"); mkdirSync(directory);
    const bad = path.join(root, "bad.pem"); writeFileSync(bad, "not a certificate");
    const expired = path.join(root, "expired.pem");
    execFileSync("openssl", ["x509", "-in", caFile, "-signkey", path.join(root, "key.pem"), "-days", "-1", "-out", expired], { stdio: "ignore" });
    chmodSync(expired, 0o644);
    const huge = path.join(root, "huge.pem"); writeFileSync(huge, "x".repeat(65537));
    const writable = path.join(root, "writable.pem"); writeFileSync(writable, readFileSync(caFile)); chmodSync(writable, 0o666);
    for (const caBundlePath of ["ca.pem", "/etc/passwd", link, pipe, directory, path.join(linkedDir, "ca.pem"), bad, expired, huge, writable, root, path.join(root, "key.pem")]) {
      expect(() => load({ baseURL: fixture.origin, caBundlePath })).toThrow("Invalid operator TypeSafe transport profile");
    }
  });
  it("rejects files owned by another identity and incomplete policies", () => {
    writeFileSync(profileFile, JSON.stringify({ baseURL: fixture.origin }));
    expect(() => loadTypeSafeTransportPolicy(env, root, uid + 1)).toThrow("Invalid operator TypeSafe transport profile");
    expect(() => loadTypeSafeTransportPolicy({ ...env, PAPERCLIP_TYPESAFE_TRANSPORT_PROFILE: undefined }, root, uid)).toThrow();
    expect(() => loadTypeSafeTransportPolicy({ ...env, PAPERCLIP_TYPESAFE_QUALIFICATION_FIXTURE: undefined }, root, uid)).toThrow();
  });
  it("pins public DNS answers and denies mixed/private answers", async () => {
    const bundle = path.join(root, "bundle"); mkdirSync(bundle);
    const identity = { manifestId: "oxford.typesafe-skill-suggestion", packageName: "@paperclipai/plugin-typesafe-skill-suggestion", packagePath: bundle, trustedPackagePath: bundle };
    const good = await typeSafeWorkerTransportEnv({ baseURL: "https://api.typesafe.ai" }, identity, async () => [{ address: "1.1.1.1", family: 4 }]);
    expect(JSON.parse(good[TYPESAFE_TRANSPORT_ENV]!)).toEqual({ baseURL: "https://api.typesafe.ai", addresses: ["1.1.1.1"], caPem: null });
    await expect(typeSafeWorkerTransportEnv({ baseURL: "https://api.typesafe.ai" }, identity,
      async () => [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }])).rejects.toThrow("TypeSafe transport destination denied");
    expect(await typeSafeWorkerTransportEnv({ baseURL: fixture.origin, fixtureAddress: fixture.address, caPem: "public" },
      { ...identity, manifestId: "lookalike" })).toEqual({});
    const outsider = path.join(root, "outsider"); mkdirSync(outsider);
    expect(await typeSafeWorkerTransportEnv({ baseURL: fixture.origin }, { ...identity, packagePath: outsider })).toEqual({});
    const linked = path.join(root, "linked-bundle"); symlinkSync(bundle, linked);
    expect(await typeSafeWorkerTransportEnv({ baseURL: fixture.origin }, { ...identity, packagePath: linked })).toEqual({});
    expect(await typeSafeWorkerTransportEnv({ baseURL: fixture.origin }, { ...identity, packagePath: null })).toEqual({});
  });
});
