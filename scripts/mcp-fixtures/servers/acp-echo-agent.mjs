#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let supportsTypedSessionFailure = false;
let airClient = false;

// A JSON-RPC error carrying its own `data`, as codex-acp's RequestError does.
class AcpRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.rpc = { code, message, ...(data === undefined ? {} : { data }) };
  }
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    const air = request.params?.clientCapabilities?._meta?.jetbrains?.air;
    // codex-acp 2.5.0 treats any `_meta.jetbrains.air` object as an AIR client.
    airClient = air !== null && typeof air === "object" && !Array.isArray(air);
    supportsTypedSessionFailure =
      Number.isInteger(air?.version) &&
      air.version >= 1 &&
      Array.isArray(air?.capabilities) &&
      air.capabilities.includes("sessionFailure");
    process.stderr.write(
      "Error handling request { method: 'nes/close' } { code: -32601 }\n",
    );
    process.stderr.write("paperclip-acp-echo-agent started\n");
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "paperclip-acp-echo-agent", version: "1.0.0" },
    };
  }
  if (request.method === "session/new") return { sessionId: randomUUID() };
  if (request.method === "session/prompt") {
    // Mirrors the patched codex-acp 2.5.0 provider-error path for a client that
    // is not an AIR client: the provider sentence streams as the turn's output
    // and the prompt rejects with a JSON-RPC internal error whose data carries
    // `codexErrorInfo`. An AIR client gets no output text (codex records a
    // typed failure instead), which is why the codex lane must not advertise AIR.
    const codexError = process.env.PAPERCLIP_ACPX_CODEX_ERROR_FILE
      ? JSON.parse(await readFile(process.env.PAPERCLIP_ACPX_CODEX_ERROR_FILE, "utf8"))
      : null;
    if (codexError) {
      if (!airClient) {
        writeMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: request.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `${codexError.message}\n\n` },
            },
          },
        });
      }
      throw new AcpRpcError(-32603, "Internal error", {
        message: codexError.message,
        ...(codexError.codexErrorInfo === undefined ? {} : { codexErrorInfo: codexError.codexErrorInfo }),
      });
    }
    const typedFailure = process.env.PAPERCLIP_ACPX_TYPED_FAILURE_FILE
      ? JSON.parse(await readFile(process.env.PAPERCLIP_ACPX_TYPED_FAILURE_FILE, "utf8"))
      : {};
    const typedFailureCanary = typedFailure.title ?? process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CANARY;
    if (typedFailureCanary) {
      if (!supportsTypedSessionFailure) {
        throw new Error(
          "client did not advertise typed session-failure support",
        );
      }
      const configuredCategory = typedFailure.category ?? process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CATEGORY;
      const category = ["connection", "access", "limit", "service", "request", "unknown"].includes(configuredCategory)
        ? configuredCategory
        : "request";
      const sessionFailure = {
        id: `${request.params.sessionId}:error`,
        revision: 1,
        category,
        severity: "error",
        title: typedFailureCanary,
        ...(typedFailure.details
          ? { details: typedFailure.details }
          : {}),
        actions: [],
      };
      writeMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            _meta: { jetbrains: { air: { version: 1, sessionFailure } } },
          },
        },
      });
      return {
        stopReason: "end_turn",
        _meta: { jetbrains: { air: { version: 1, sessionFailure } } },
      };
    }
    const typedWarningCanary = process.env.PAPERCLIP_ACPX_TYPED_WARNING_CANARY;
    let responseMeta;
    if (typedWarningCanary) {
      if (!supportsTypedSessionFailure) {
        throw new Error(
          "client did not advertise typed session-failure support",
        );
      }
      const sessionFailure = {
        id: `${request.params.sessionId}:warning`,
        revision: 1,
        category: "connection",
        severity: "warning",
        title: typedWarningCanary,
        actions: [],
      };
      responseMeta = { jetbrains: { air: { version: 1, sessionFailure } } };
      writeMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: "session_info_update", _meta: responseMeta },
        },
      });
    }
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: process.env.PAPERCLIP_ACPX_SPAWN_SMOKE ?? "missing",
          },
        },
      },
    });
    return {
      stopReason: "end_turn",
      ...(responseMeta ? { _meta: responseMeta } : {}),
    };
  }
  if (
    request.method === "session/close" ||
    request.method === "session/set_mode" ||
    request.method === "session/set_config_option"
  )
    return {};
  if (request.method === "session/cancel") return null;
  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null)
      writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: error instanceof AcpRpcError ? error.rpc : { code: -32603, message: String(error?.message ?? error) },
      });
    }
  }
});
