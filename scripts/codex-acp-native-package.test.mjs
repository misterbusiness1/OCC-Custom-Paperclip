import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const requireAdapter = createRequire(new URL("../packages/adapters/codex-local/package.json", import.meta.url));
const bridgeManifestPath = requireAdapter.resolve("@agentclientprotocol/codex-acp/package.json");
const requireBridge = createRequire(bridgeManifestPath);
const nativeManifestPath = requireBridge.resolve("@openai/codex/package.json");
const requireNative = createRequire(nativeManifestPath);

test("the local ACP bridge resolves and launches its qualified native package", async (t) => {
  const bridge = JSON.parse(await readFile(bridgeManifestPath, "utf8"));
  const native = JSON.parse(await readFile(nativeManifestPath, "utf8"));
  assert.equal(bridge.version, "2.5.0", "the production ACP bridge is the patched codex-acp 2.5.0");
  assert.equal(native.version, "0.166.0", "resolve the native override from the actual bridge package");

  const home = await mkdtemp(join(tmpdir(), "paperclip-codex-package-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // --version performs no turn or login. Resolve the normal published launcher,
  // without CODEX_PATH or the operator's home, auth, preload, or proxy settings.
  const version = execFileSync(process.execPath, [requireBridge.resolve("@openai/codex/bin/codex.js"), "--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
  }).trim();
  assert.equal(version, "codex-cli 0.166.0");
});

test("the Linux x64 native package includes the matching tool host and sandbox resource", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, async () => {
  const native = JSON.parse(await readFile(nativeManifestPath, "utf8"));
  assert.equal(native.optionalDependencies["@openai/codex-linux-x64"], "npm:@openai/codex@0.166.0-linux-x64");
  const platformManifestPath = requireNative.resolve("@openai/codex-linux-x64/package.json");
  const platform = JSON.parse(await readFile(platformManifestPath, "utf8"));
  assert.equal(platform.version, "0.166.0-linux-x64");

  // These digests come from the integrity-verified official 0.166.0-linux-x64
  // archive. A copied main executable alone cannot satisfy this contract.
  const qualifiedFiles = {
    "bin/codex": "b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8",
    "bin/codex-code-mode-host": "657f4e902726e05867c937b583049d5997e057f8cd0ab40450633c9c9ef8d630",
    "codex-resources/bwrap": "77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c",
  };
  const root = join(dirname(platformManifestPath), "vendor", "x86_64-unknown-linux-musl");
  for (const [relativePath, expectedDigest] of Object.entries(qualifiedFiles)) {
    const file = join(root, relativePath);
    const metadata = await stat(file);
    assert.ok(metadata.isFile(), `${relativePath} is a packaged regular file`);
    assert.ok((metadata.mode & 0o111) !== 0, `${relativePath} is executable`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.equal(hash.digest("hex"), expectedDigest, `${relativePath} belongs to the qualified platform release`);
  }
});
