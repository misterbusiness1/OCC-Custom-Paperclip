import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type * as runtimeTypes from "acpx/runtime";
import { createCodexAcpExecutor } from "../../../packages/adapters/codex-local/src/server/acp.js";
import { createClaudeAcpExecutor } from "../../../packages/adapters/claude-local/src/server/acp.js";

const adapterRequire = createRequire(new URL("../../../packages/adapter-utils/package.json", import.meta.url));
const serverRequire = createRequire(new URL("../../package.json", import.meta.url));
const adapterRuntimeUrl = pathToFileURL(adapterRequire.resolve("acpx/runtime")).href;
const serverRuntimeUrl = pathToFileURL(serverRequire.resolve("acpx/runtime")).href;
const adapterRuntime = await import(/* @vite-ignore */ adapterRuntimeUrl) as typeof runtimeTypes;
const serverRuntime = await import(/* @vite-ignore */ serverRuntimeUrl) as typeof runtimeTypes;

const tempRoots: string[] = [];
const privateCanary = "private-provider-data-must-not-be-projected";

// This is a real local ACP child. Only its session/prompt outcome varies; the
// public runtime, transport, error normalizer and terminal projections are real.
const childSource = `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const outcome = __FIXTURE_OUTCOME__;
if (outcome.pidFile) appendFileSync(outcome.pidFile, process.pid + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "provider-status-fixture", version: "1" } };
  if (request.method === "session/new") result = { sessionId: "fixture-session" };
  if (request.method === "session/prompt") {
    if (outcome.kind === "error") {
      write({ jsonrpc: "2.0", id: request.id, error: outcome.error });
      return;
    }
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: outcome.text } } } });
    result = { stopReason: "end_turn" };
  }
  if (request.id !== undefined) write({ jsonrpc: "2.0", id: request.id, result });
});
`;

async function runChild(api: typeof adapterRuntime, outcome: Record<string, unknown>, legacy = false) {
  const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = api;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-provider-http-status-"));
  tempRoots.push(root);
  const child = path.join(root, "fixture.mjs");
  await fs.writeFile(child, childSource.replace("__FIXTURE_OUTCOME__", JSON.stringify(outcome)));
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: createRuntimeStore({ stateDir: path.join(root, "state") }),
    agentRegistry: createAgentRegistry({ overrides: {
      provider_http_status_fixture: `${JSON.stringify(process.execPath)} ${JSON.stringify(child)}`,
    } }),
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    timeoutMs: 10_000,
  });
  const handle = await runtime.ensureSession({
    sessionKey: "provider-http-status-fixture",
    agent: "provider_http_status_fixture",
    mode: "oneshot",
    cwd: root,
    sessionOptions: { env: {} },
  });
  const input = { handle, text: "Synthetic test prompt", mode: "prompt" as const, requestId: "status-test" };
  const events: unknown[] = [];
  try {
    if (legacy) {
      for await (const event of runtime.runTurn(input)) events.push(event);
      return { result: undefined, events };
    }
    const turn = runtime.startTurn(input);
    for await (const event of turn.events) events.push(event);
    return { result: await turn.result, events };
  } finally {
    await runtime.close({ handle, reason: "provider HTTP status fixture complete", discardPersistentState: true });
  }
}

function rpcError(data: unknown, code = -32603) {
  return { kind: "error", error: { code, message: "Internal error", data } };
}

function trustedStatus(status: unknown) {
  return { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: status } } };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.each([
  { name: "adapter-utils acpx dependency", api: adapterRuntime },
  { name: "server acpx dependency", api: serverRuntime },
])("trusted provider HTTP status across the real $name boundary", ({ api }) => {
  it.each([429, 503, 401])("preserves only trusted integer HTTP status %i on terminal errors", async (status) => {
    const { result, events } = await runChild(api, rpcError({
      ...trustedStatus(status), headers: { authorization: privateCanary }, additionalDetails: privateCanary,
    }));
    expect(result?.status).toBe("failed");
    expect(result).toMatchObject({ error: { providerHttpStatus: status } });
    expect(JSON.stringify({ result, events })).not.toContain(privateCanary);
    expect(JSON.stringify(result)).not.toContain("codexErrorInfo");
  });

  it.each([
    "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts",
  ])("accepts the approved %s variant on server error code -32000", async (variant) => {
    const { result } = await runChild(api, rpcError({ codexErrorInfo: { [variant]: { httpStatusCode: 429 } } }, -32000));
    expect(result).toMatchObject({ status: "failed", error: { providerHttpStatus: 429 } });
  });

  it("preserves the same safe primitive on compatibility error events", async () => {
    const { events } = await runChild(api, rpcError(trustedStatus(429)), true);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", providerHttpStatus: 429 }));
  });

  it.each([
    ["string", trustedStatus("429")],
    ["noninteger", trustedStatus(429.5)],
    ["out of range", trustedStatus(600)],
    ["array", { codexErrorInfo: [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }] }],
    ["unknown variant", { codexErrorInfo: { quotedExample: { httpStatusCode: 429 } } }],
    ["untrusted top-level field", { providerHttpStatus: 429 }],
    ["ambiguous variants", { codexErrorInfo: {
      responseTooManyFailedAttempts: { httpStatusCode: 429 },
      httpConnectionFailed: { httpStatusCode: 429 },
    } }],
  ])("does not project %s status metadata", async (_name, data) => {
    const { result, events } = await runChild(api, rpcError(data));
    expect(result?.status).toBe("failed");
    expect(result).not.toHaveProperty("error.providerHttpStatus");
    expect(JSON.stringify(events)).not.toContain("providerHttpStatus");
  });

  it("does not project a provider status from an unrelated ACP error code", async () => {
    const { result } = await runChild(api, rpcError(trustedStatus(429), -32602));
    expect(result?.status).toBe("failed");
    expect(result).not.toHaveProperty("error.providerHttpStatus");
  });

  it("keeps quoted status-shaped assistant content successful", async () => {
    const text = `Quoted example: ${JSON.stringify(trustedStatus(429))}`;
    const { result, events } = await runChild(api, { kind: "answer", text });
    expect(result).toMatchObject({ status: "completed" });
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text }));
    expect(result).not.toHaveProperty("providerHttpStatus");
  });
});

describe.each([
  { name: "Codex", create: createCodexAcpExecutor },
  { name: "Claude", create: createClaudeAcpExecutor },
])("$name adapter finalization with a real local ACP child", ({ name, create }) => {
  it.each([
    { status: 429, message: "Internal error", family: "transient_upstream", code: "acpx_transient_upstream" },
    { status: 503, message: "Internal error", family: "transient_upstream", code: "acpx_transient_upstream" },
    { status: 401, message: "Internal error", family: null, code: "acpx_auth_required" },
    { status: 429, message: "Authorization failed: missing API key", family: null, code: "acpx_auth_required" },
  ])("projects $status / $message and reaps the runtime child", async ({ status, message, family, code }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-provider-status-engine-"));
    tempRoots.push(root);
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(codexHome);
    const accountCanary = "synthetic-account-not-an-actual-provider-account";
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
      tokens: { account_id: accountCanary, access_token: "synthetic-noncredential" },
    }));
    const child = path.join(root, "fixture.mjs");
    const pidFile = path.join(root, "child-pids");
    const outcome = rpcError({ ...trustedStatus(status), additionalDetails: privateCanary });
    outcome.error.message = message;
    await fs.writeFile(child, childSource.replace("__FIXTURE_OUTCOME__", JSON.stringify({ ...outcome, pidFile })));
    const logs: string[] = [];
    const accountKeys: Array<string | null> = [];
    const execute = create();
    const result = await execute({
      runId: "provider-status-engine",
      agent: { id: "fixture-agent", companyId: "fixture-company" },
      runtime: {},
      config: {
        mode: "oneshot", warmHandleIdleMs: 0, cwd: root, stateDir: path.join(root, "state"),
        agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(child)}`,
        env: {
          HOME: root, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: path.join(root, "claude-home"),
          OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "",
        },
        promptTemplate: "Synthetic provider status fixture",
      },
      context: { paperclipWorkspace: { cwd: root, agentHome: root } },
      onLog: async (_stream: string, text: string) => { logs.push(text); },
      onMeta: async () => {},
      onProviderAccount: async (key: string | null) => { accountKeys.push(key); },
    } as never);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe(name === "Claude" && code === "acpx_auth_required" ? "claude_auth_required" : code);
    expect(result.errorFamily).toBe(family);
    expect(result.resultJson).toMatchObject({ providerHttpStatus: status });
    expect(JSON.stringify({ result, logs })).not.toContain(privateCanary);
    expect(JSON.stringify({ result, logs })).not.toContain(accountCanary);
    if (name === "Codex") expect(accountKeys).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    const pids = (await fs.readFile(pidFile, "utf8")).trim().split("\n").map(Number);
    expect(pids.length).toBeGreaterThan(0);
    await expect.poll(() => pids.some((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }), { timeout: 2_000, interval: 20 }).toBe(false);
  });
});
