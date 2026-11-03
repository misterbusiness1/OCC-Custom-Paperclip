import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { classifyCodexTerminalSessionFailure, createCodexAcpExecutor } from "./acp.js";
import type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const fixture = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-echo-agent.mjs");
const roots: string[] = [];
const now = new Date("2026-07-15T20:00:00.000Z");
// Exercise both pinned dependency patches through the same real ACP child.
const runnerRequire = createRequire(path.join(repoRoot, "packages/paperclip-runner/package.json"));
const runnerAcpx = await import(runnerRequire.resolve("acpx/runtime"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function executeFailure(
  title: string,
  category = "limit",
  mode = "oneshot",
  createRuntime?: AcpxEngineExecutorOptions["createRuntime"],
  codexError?: { message: string; codexErrorInfo?: unknown },
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-acp-quota-"));
  roots.push(root);
  const codexErrorFile = path.join(root, "codex-error.json");
  if (codexError) await fs.writeFile(codexErrorFile, JSON.stringify(codexError));
  const logs: string[] = [];
  const execute = createCodexAcpExecutor({ now: () => now.getTime(), createRuntime });
  const result = await execute({
    runId: "typed-quota",
    agent: { id: "quota-agent", companyId: "quota-company" },
    runtime: {},
    config: {
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixture.replaceAll("\\", "/"))}`,
      mode,
      warmHandleIdleMs: 0,
      cwd: repoRoot,
      stateDir: path.join(root, "state"),
      env: {
        CODEX_HOME: path.join(root, "codex-home"),
        ...(codexError
          ? { PAPERCLIP_ACPX_CODEX_ERROR_FILE: codexErrorFile }
          : {
              PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: title,
              PAPERCLIP_ACPX_TYPED_FAILURE_CATEGORY: category,
            }),
      },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);
  return { result, logs: logs.join("\n") };
}

// Typed AIR session failures reach the codex classifier only on the runner's
// ACPX 0.13.1 lane, which advertises AIR to every agent. The production engine
// (ACPX 0.21.1) deliberately does not advertise AIR to codex-acp 2.5.0; its
// provider failures are covered by the JSON-RPC rows below.
it.each([
  ["0.13.1", "oneshot"],
  ["0.13.1", "persistent"],
])("waits for a typed Codex quota reset with ACPX %s in %s mode without exposing provider text", async (_version, mode) => {
  const title = "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:30 PM (America/Chicago).";
  const { result, logs } = await executeFailure(
    title, "limit", mode, runnerAcpx.createAcpRuntime,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: "2026-07-15T21:30:00.000Z",
    resultJson: {
      errorFamily: "provider_quota",
      retryNotBefore: "2026-07-15T21:30:00.000Z",
      providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
    },
  });
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it("classifies quota without a reset time for the existing recovery backoff", async () => {
  const title = "You've hit your usage limit. Visit https://example.invalid/usage for account details.";
  const { result, logs } = await executeFailure(title, "limit", "oneshot", runnerAcpx.createAcpRuntime);
  expect(result).toMatchObject({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  expect(result.retryNotBefore).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it.each([
  ["Context window limit exceeded", "limit"],
  ["Maximum number of turns reached", "limit"],
  ["Configured budget limit reached", "limit"],
  ["Rate limit exceeded; retry later", "limit"],
  ["You've hit your usage limit", "request"],
  ["Context window capacity limit reached", "limit"],
  ["Workspace storage capacity limit reached", "limit"],
  ["The account has available quota", "limit"],
  ["The worker connection closed", "connection"],
])("keeps a non-quota typed failure out of quota recovery: %s", async (title, category) => {
  const { result, logs } = await executeFailure(title, category, "oneshot", runnerAcpx.createAcpRuntime);
  expect(result).toMatchObject({ exitCode: 1, errorCode: "acpx_turn_failed" });
  expect(result.errorFamily).not.toBe("provider_quota");
  expect(result.retryNotBefore).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

// The production codex lane: ACPX 0.21.1 with a fixture that answers exactly
// as patched codex-acp 2.5.0 does for a non-AIR client (provider sentence as
// output, then a JSON-RPC internal error with `codexErrorInfo`).
it.each(["oneshot", "persistent"])(
  "classifies a codex-acp 2.5.0 usage-limit error as provider quota with its reset on ACPX 0.21.1 (%s)",
  async (mode) => {
    const message = "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:30 PM (America/Chicago).";
    const { result } = await executeFailure(message, "limit", mode, undefined, {
      message,
      codexErrorInfo: "usageLimitExceeded",
    });
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      resultJson: { errorFamily: "provider_quota" },
    });
    // The whole-output provider sentence path reads Codex's local reset clock
    // against the real clock (not the injected test clock): 4:30 PM Chicago is
    // 21:30Z in daylight time and 22:30Z in standard time.
    expect(result.retryNotBefore).toMatch(/T2[12]:30:00\.000Z$/);
    expect(Date.parse(result.retryNotBefore ?? "")).toBeGreaterThan(Date.now());
    expect((result.resultJson as Record<string, unknown>).providerQuotaRetryNotBefore).toBe(result.retryNotBefore);
  },
);

it.each([
  [
    "a 429 retry exhaustion",
    { message: "exceeded retry limit, last status: 429 Too Many Requests", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } },
    { errorCode: "acpx_transient_upstream", errorFamily: "transient_upstream", providerHttpStatus: 429 },
  ],
  [
    "a 502 stream disconnect",
    { message: "stream disconnected before completion: 502 Bad Gateway", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } },
    { errorCode: "acpx_transient_upstream", errorFamily: "transient_upstream", providerHttpStatus: 502 },
  ],
  [
    "a 503 connection failure",
    { message: "exceeded retry limit, last status: 503 Service Unavailable", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
    { errorCode: "acpx_transient_upstream", errorFamily: "transient_upstream", providerHttpStatus: 503 },
  ],
  [
    "an overloaded model without a status",
    { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded" },
    { errorCode: "codex_transient_upstream", errorFamily: "transient_upstream" },
  ],
  [
    "a configured-auth 401",
    { message: "unexpected status 401 Unauthorized", codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } },
    { errorCode: "acpx_auth_required", providerHttpStatus: 401 },
  ],
])("classifies %s from codex-acp 2.5.0 on ACPX 0.21.1 and never as quota", async (_label, codexError, expected) => {
  const { result } = await executeFailure(codexError.message, "limit", "oneshot", undefined, codexError);
  const { providerHttpStatus, ...fields } = expected as Record<string, unknown>;
  expect(result).toMatchObject({ exitCode: 1, ...fields });
  expect(result.errorFamily).not.toBe("provider_quota");
  expect(result.errorCode).not.toBe("provider_quota");
  const resultJson = result.resultJson as Record<string, unknown>;
  if (providerHttpStatus !== undefined) expect(resultJson.providerHttpStatus).toBe(providerHttpStatus);
  else expect(resultJson.providerHttpStatus).toBeUndefined();
});

it("does not infer quota from the historical generic terminal-limit error", () => {
  expect(classifyCodexTerminalSessionFailure({
    category: "limit",
    title: "ACP agent reported a terminal limit failure.",
  }, now)).toBeNull();
});

it("reads usage exhaustion and its reset clock from terminal details", () => {
  expect(classifyCodexTerminalSessionFailure({
    category: "limit",
    title: "Codex could not complete the turn",
    details: "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:30 PM (America/Chicago).",
  }, now)).toEqual({
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: "2026-07-15T21:30:00.000Z",
  });
});

it.each(["Usage limit reached", "Usage limit exceeded", "You’ve hit your usage limit"])(
  "classifies explicit usage exhaustion without a reset clock: %s", (title) => {
    expect(classifyCodexTerminalSessionFailure({ category: "limit", title }, now))
      .toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  },
);
