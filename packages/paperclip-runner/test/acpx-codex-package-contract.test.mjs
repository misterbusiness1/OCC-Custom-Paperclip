import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const runnerPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
const workspace = await readFile(
  new URL("../../../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);
const acpxPatch = await readFile(
  new URL("../../../patches/acpx@0.21.1.patch", import.meta.url),
  "utf8",
);
const codexPatch = await readFile(
  new URL(
    "../../../patches/@agentclientprotocol__codex-acp@2.5.0.patch",
    import.meta.url,
  ),
  "utf8",
);
const claudePatch = await readFile(
  new URL(
    "../../../patches/@agentclientprotocol__claude-agent-acp@0.100.0.patch",
    import.meta.url,
  ),
  "utf8",
);
const qualifiedProfiles = await readFile(
  new URL("../src/drivers/acpx/qualified-profiles.ts", import.meta.url),
  "utf8",
);
const runnerdAcpxBackend = await readFile(
  new URL(
    "../runner/crates/runner-core/src/acpx_provider_backend.rs",
    import.meta.url,
  ),
  "utf8",
);
const providerPackBuilder = await readFile(
  new URL("../scripts/build-provider-pack.mjs", import.meta.url),
  "utf8",
);
const codexRuntimeAdapter = await readFile(
  new URL("../src/drivers/acpx/codex-runtime-adapter.ts", import.meta.url),
  "utf8",
);
const nativeSessionExecutor = await readFile(
  new URL(
    "../../../server/src/services/native-runtime/native-session-executor.ts",
    import.meta.url,
  ),
  "utf8",
);

test("the runner pins every qualified ACPX production dependency", () => {
  assert.equal(runnerPackage.dependencies["@openai/codex"], "0.166.0");
  assert.equal(runnerPackage.dependencies["@anthropic-ai/claude-agent-sdk"], undefined);
  assert.equal(rootPackage.pnpm.overrides["@agentclientprotocol/codex-acp@2.5.0>@openai/codex"], runnerPackage.dependencies["@openai/codex"]);
  assert.equal(rootPackage.pnpm.overrides["@agentclientprotocol/claude-agent-acp@0.100.0>@anthropic-ai/claude-agent-sdk"], "0.3.317");
  assert.match(workspace, /"@agentclientprotocol\/codex-acp@2\.5\.0>@openai\/codex": "0\.166\.0"/);
  assert.match(workspace, /"@agentclientprotocol\/claude-agent-acp@0\.100\.0>@anthropic-ai\/claude-agent-sdk": "0\.3\.317"/);
  assert.equal(runnerPackage.optionalDependencies, undefined);
  assert.equal(runnerPackage.dependencies.node, undefined);
  assert.equal(runnerPackage.dependencies.acpx, "0.21.1");
  assert.equal(
    runnerPackage.dependencies["@agentclientprotocol/codex-acp"],
    "2.5.0",
  );
  assert.equal(
    runnerPackage.dependencies["@agentclientprotocol/claude-agent-acp"],
    "0.100.0",
  );
});

test("the patched Codex ACP executable digest stays aligned across launch boundaries", async () => {
  const profileMatch =
    /agent: "codex"[\s\S]*?commandDigest:\s*"(sha256:[a-f0-9]{64})"/.exec(
      qualifiedProfiles,
    );
  assert.ok(profileMatch, "qualified Codex ACPX profile digest");
  const digest = profileMatch[1];
  const packagePath = createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp/package.json");
  const installed = JSON.parse(await readFile(packagePath, "utf8"));
  const executable = await readFile(resolve(dirname(packagePath), installed.bin["codex-acp"]));
  assert.equal(digest, `sha256:${createHash("sha256").update(executable).digest("hex")}`,
    "the identity binds installed executable bytes, not the patch file");

  assert.match(runnerdAcpxBackend, new RegExp(`"codex"[\\s\\S]*?${digest}`));
  assert.match(
    providerPackBuilder,
    new RegExp(`acpxProfileDigests:[\\s\\S]*?codex:[\\s\\S]*?${digest}`),
  );
  assert.match(
    nativeSessionExecutor,
    new RegExp(
      `REMOTE_PROVIDER_PACK_PROFILE_DIGESTS[\\s\\S]*?codex:[\\s\\S]*?${digest}`,
    ),
  );
});

test("the package exposes only the reviewed runner CLI binaries", () => {
  assert.deepEqual(runnerPackage.bin, {
    "paperclip-runner-eval-session": "./dist/cli/eval-session.js",
    "paperclip-runner-codex-proxy": "./dist/cli/codex-app-server-unix-proxy.js",
    "paperclip-runner-acpx-sidecar": "./dist/cli/acpx-runtime-sidecar.js",
    "paperclip-runner-opencode-proxy":
      "./dist/cli/opencode-app-server-proxy.js",
  });
});

test("old and new pnpm configuration both apply the exact runtime patches", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["acpx@0.21.1"],
    "patches/acpx@0.21.1.patch",
  );
  assert.equal(
    rootPackage.pnpm.patchedDependencies[
      "@agentclientprotocol/claude-agent-acp@0.100.0"
    ],
    "patches/@agentclientprotocol__claude-agent-acp@0.100.0.patch",
  );
  assert.equal(
    rootPackage.pnpm.patchedDependencies[
      "@agentclientprotocol/codex-acp@2.5.0"
    ],
    "patches/@agentclientprotocol__codex-acp@2.5.0.patch",
  );
  assert.match(workspace, /acpx@0\.21\.1: patches\/acpx@0\.21\.1\.patch/);
  assert.match(
    workspace,
    /codex-acp@2\.5\.0["']: patches\/@agentclientprotocol__codex-acp@2\.5\.0\.patch/,
  );
  assert.match(
    workspace,
    /claude-agent-acp@0\.100\.0["']: patches\/@agentclientprotocol__claude-agent-acp@0\.100\.0\.patch/,
  );
  assert.equal(rootPackage.pnpm.patchedDependencies["node@24.11.0"], undefined);
  assert.doesNotMatch(workspace, /node@24\.11\.0:/);
  assert.match(
    providerPackBuilder,
    /copyFileSync\(process\.execPath, stableNodeCommand\)/,
  );
  // The runner shares one ACPX / ACP-server lane with the production adapters;
  // the previously separate runner copies must not come back.
  for (const retired of ["acpx@0.13.1", "@agentclientprotocol/codex-acp@1.6.2", "@agentclientprotocol/claude-agent-acp@0.73.0"]) {
    assert.equal(rootPackage.pnpm.patchedDependencies[retired], undefined);
    assert.doesNotMatch(workspace, new RegExp(retired.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // The pinned Codex runtime comes from the override, not a patched manifest.
  assert.doesNotMatch(codexPatch, /"@openai\/codex":/);
});

test("the ACPX patch preserves launch-only state and verified spawning", () => {
  for (const token of [
    "spawnEnvironment",
    "spawnCwd",
    "spawnAgent",
    "SpawnOptionsWithoutStdio",
    "this.options.spawnAgent",
  ]) {
    assert.match(acpxPatch, new RegExp(token));
  }
});

test("the ACPX patch fails closed on an invalid spawn environment", () => {
  for (const token of [
    "isPlainStringEnvironment",
    "Object.getPrototypeOf(value)",
    'Object.values(value).every((entry) => typeof entry === "string")',
    "spawnEnvironment !== void 0",
    "sourceEnvironment = spawnEnvironment()",
    "ACPX spawn environment must be a plain record of string values",
  ]) {
    assert.match(
      acpxPatch,
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.doesNotMatch(acpxPatch, /spawnEnvironment\?\.\(\)/);
  assert.doesNotMatch(
    acpxPatch,
    /spawnEnvironment \? \{ \.\.\.spawnEnvironment \} : \{ \.\.\.process\.env \}/,
  );
});

test("authentication rejects invalid isolated environments without host fallback", () => {
  const addedSource = acpxPatch.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1)).join("\n");
  const start = addedSource.indexOf("function isPlainStringEnvironment(value)");
  const end = addedSource.indexOf("function buildAgentEnvironment(", start);
  assert.ok(start >= 0 && end > start);
  const hostEnvironment = { XAI_API_KEY: "host-credential-must-not-leak" };
  const resolveEnvironment = new Function(
    "process", `${addedSource.slice(start, end)}; return resolveAgentEnvironment;`,
  )({ env: hostEnvironment });
  for (const invalid of [undefined, null, [], "invalid", { XAI_API_KEY: 1 }]) {
    assert.throws(() => resolveEnvironment(() => invalid), TypeError);
  }
  const isolated = {};
  assert.equal(resolveEnvironment(() => isolated), isolated);
  assert.equal(resolveEnvironment(() => isolated).XAI_API_KEY, undefined);
  assert.equal(resolveEnvironment(undefined), hostEnvironment);
  assert.match(addedSource, /readEnvCredential\(method\.id, resolveAgentEnvironment\(this\.options\.spawnEnvironment\)\)/);
  assert.match(addedSource, /resolveAgentEnvironment\(this\.options\.spawnEnvironment\)\)\.XAI_API_KEY/);
});

test("the Codex patch enforces isolated instructions, tools, and skills", () => {
  for (const token of [
    "PAPERCLIP_ACPX_ISOLATED_CONTEXT",
    "baseInstructions",
    "rawInput: { ...toolCall.rawInput, serverName: params.serverName }",
    '"features.apps": false',
    "process.env.CODEX_HOME",
  ]) {
    assert.match(
      codexPatch,
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("the Codex patch keeps MCP tool approvals on the governed permission channel", () => {
  assert.match(
    codexPatch,
    /!context\.isToolApproval && this\.shouldUseAcpElicitation\(params\)/,
  );
});

test("the Claude patch removes ambient project and local configuration", () => {
  for (const token of [
    "PAPERCLIP_ACPX_ISOLATED_CONTEXT",
    'settingSources: ["user"]',
    "userProvidedOptions?.mcpServers",
  ]) {
    assert.match(
      claudePatch,
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

async function installedCodexAcpEntrypoint() {
  const packagePath = createRequire(import.meta.url).resolve(
    "@agentclientprotocol/codex-acp/package.json",
  );
  const installed = JSON.parse(await readFile(packagePath, "utf8"));
  return resolve(dirname(packagePath), installed.bin["codex-acp"]);
}

// Initialize the installed codex-acp bundle over stdio and return the result.
// Initialize does not need credentials or a model turn.
async function initializeInstalledCodexAcp(environment, clientCapabilities = {}) {
  const entrypoint = await installedCodexAcpEntrypoint();
  const home = await mkdtemp(join(tmpdir(), "paperclip-codex-acp-goal-"));
  const child = spawn(process.execPath, [entrypoint], {
    env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, ...environment },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    return await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error("codex-acp initialize timed out")), 20_000);
      let buffered = "";
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`codex-acp exited (${code}) before initialize`)));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            clearTimeout(timer);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolveResult(message.result);
          }
        }
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities },
      })}\n`);
    });
  } finally {
    child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
}

const EXPECTED_GOAL_CAPABILITY = {
  version: 1,
  controlMethod: "_session/goal",
  actions: ["set", "pause", "resume", "clear"],
};

test("the patched Codex ACP advertises the top-level goal extension to the runner's plain client", { timeout: 60_000 }, async () => {
  // codex-acp 2.5.0 moved goal behind AIR (`_meta.jetbrains.air.goal`). The
  // runner never declares AIR for Codex, and reads `_meta.goal` (as acpx's
  // persistedGoalCapability does), so the runner lane opts back in.
  const runner = await initializeInstalledCodexAcp({ PAPERCLIP_CODEX_ACP_GOAL_META: "1" });
  assert.deepEqual(runner._meta.goal, EXPECTED_GOAL_CAPABILITY);
  assert.equal(runner._meta.jetbrains, undefined);

  // Production adapters leave the flag unset and keep upstream 2.5.0 output.
  const production = await initializeInstalledCodexAcp({});
  assert.equal(production._meta.goal, undefined);
  assert.equal(production._meta.jetbrains, undefined);

  // An AIR client keeps the upstream AIR form only, never a duplicate.
  const air = await initializeInstalledCodexAcp(
    { PAPERCLIP_CODEX_ACP_GOAL_META: "1" },
    { _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } } },
  );
  assert.equal(air._meta.goal, undefined);
  assert.deepEqual(air._meta.jetbrains.air.goal, EXPECTED_GOAL_CAPABILITY);
});

test("the patched Codex ACP publishes top-level goal snapshots to the runner's plain client", async () => {
  const source = await readFile(await installedCodexAcpEntrypoint(), "utf8");
  const start = source.indexOf("function goalSessionInfoUpdate(goal, airClient) {");
  assert.ok(start >= 0, "installed bundle defines goalSessionInfoUpdate");
  const end = source.indexOf("\n}\n", start);
  const goalSessionInfoUpdate = (env) => new Function(
    "process", "withAirMeta", "AIR_GOAL_KEY",
    `${source.slice(start, end + 2)}; return goalSessionInfoUpdate;`,
  )({ env }, (_meta, key, value) => ({ jetbrains: { air: { version: 1, [key]: value } } }), "goal");
  const snapshot = { objective: "Ship", status: "active", controlMethod: "_session/goal" };

  assert.deepEqual(goalSessionInfoUpdate({ PAPERCLIP_CODEX_ACP_GOAL_META: "1" })(snapshot, false), {
    sessionUpdate: "session_info_update",
    _meta: { goal: snapshot },
  });
  assert.deepEqual(goalSessionInfoUpdate({ PAPERCLIP_CODEX_ACP_GOAL_META: "1" })(null, false), {
    sessionUpdate: "session_info_update",
    _meta: { goal: null },
  });
  assert.equal(goalSessionInfoUpdate({})(snapshot, false), null);
  assert.deepEqual(goalSessionInfoUpdate({ PAPERCLIP_CODEX_ACP_GOAL_META: "1" })(snapshot, true), {
    sessionUpdate: "session_info_update",
    _meta: { jetbrains: { air: { version: 1, goal: snapshot } } },
  });
});

test("the runner's Codex mode keeps sandbox escalations on the client permission channel", async () => {
  // codex-acp 2.5.0 defaults to the "agent" (Auto review) mode, whose
  // approvalsReviewer "auto_review" lets Codex's guardian subagent answer
  // escalations instead of session/request_permission.
  const source = await readFile(await installedCodexAcpEntrypoint(), "utf8");
  const start = source.indexOf("var AgentMode = class _AgentMode {");
  assert.ok(start >= 0, "installed bundle defines AgentMode");
  const end = source.indexOf("\n};\n", start);
  const agentMode = (env) => new Function(
    "process", "airOnlyMeta", "AIR_KIND_KEY", "MODE_CONFIG_ID",
    `${source.slice(start, end + 3)}; return AgentMode;`,
  )({ env }, () => undefined, "kind", "mode");

  const upstreamDefault = agentMode({}).getInitialAgentMode();
  assert.equal(upstreamDefault.id, "agent");
  assert.equal(upstreamDefault.approvalsReviewer, "auto_review");

  const runnerMode = /INITIAL_AGENT_MODE: "([a-z-]+)"/.exec(codexRuntimeAdapter)?.[1];
  assert.equal(runnerMode, "workspace-write");
  const selected = agentMode({ INITIAL_AGENT_MODE: runnerMode }).getInitialAgentMode();
  assert.equal(selected.id, runnerMode);
  assert.equal(selected.approvalPolicy, "on-request");
  assert.equal(selected.approvalsReviewer, "user");
  assert.equal(selected.sandboxPolicy.type, "workspaceWrite");
  assert.match(codexRuntimeAdapter, /PAPERCLIP_CODEX_ACP_GOAL_META: "1"/);
});
