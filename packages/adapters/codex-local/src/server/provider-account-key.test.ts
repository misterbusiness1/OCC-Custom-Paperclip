import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexProviderAccountKey, readCodexProviderAccountKey } from "./codex-auth-cache.js";
import { resolveCodexAcpProviderAccountKey } from "./acp.js";
import { resolveManagedCodexHomeDir } from "./codex-home.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function home(accountId: string, token = "synthetic") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-account-key-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ tokens: { account_id: accountId, access_token: token } }), { mode: 0o600 });
  return root;
}

describe("Codex selected account metadata", () => {
  it("groups refreshed credentials and different homes by account while separating companies and account switches", async () => {
    const first = await home("account-a", "first-token");
    const refreshed = await home("account-a", "refreshed-token");
    const changed = await home("account-b");
    const key = createCodexProviderAccountKey("company-a", "account-a");
    expect(await readCodexProviderAccountKey("company-a", first)).toBe(key);
    expect(await readCodexProviderAccountKey("company-a", refreshed)).toBe(key);
    expect(await readCodexProviderAccountKey("company-b", first)).not.toBe(key);
    expect(await readCodexProviderAccountKey("company-a", changed)).not.toBe(key);
    expect(key).not.toContain("account-a");
  });
  it("uses configured ACP HOME without applying the CLI shared-home seed policy", async () => {
    const configured = await home("configured-account");
    const shared = await home("shared-account");
    vi.stubEnv("CODEX_HOME", shared);
    expect(await resolveCodexAcpProviderAccountKey("company", { env: { CODEX_HOME: configured, OPENAI_API_KEY: "" } }))
      .toBe(createCodexProviderAccountKey("company", "configured-account"));
  });
  it("uses the shared source that unconfigured ACP preparation would symlink over its managed target", async () => {
    const shared = await home("source-account");
    const instance = await home("unused");
    vi.stubEnv("PAPERCLIP_HOME", instance);
    vi.stubEnv("CODEX_HOME", shared);
    vi.stubEnv("OPENAI_API_KEY", "");
    const target = resolveManagedCodexHomeDir(process.env, "company");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "auth.json"), JSON.stringify({ tokens: { account_id: "prior-managed-account", access_token: "synthetic" } }));
    expect(await resolveCodexAcpProviderAccountKey("company", {})).toBe(createCodexProviderAccountKey("company", "source-account"));
    expect(JSON.parse(await fs.readFile(path.join(target, "auth.json"), "utf8")).tokens.account_id).toBe("prior-managed-account");
  });
  it("leaves API-key, missing and malformed credentials ungrouped", async () => {
    const selected = await home("account-a");
    expect(await readCodexProviderAccountKey("company", selected, "synthetic-api-key")).toBeNull();
    expect(await readCodexProviderAccountKey("company", path.join(selected, "missing"))).toBeNull();
    await fs.writeFile(path.join(selected, "auth.json"), "malformed");
    expect(await readCodexProviderAccountKey("company", selected)).toBeNull();
  });
});
