#!/usr/bin/env node
// ACP fixture that deliberately creates a terminal without forwarding any
// environment entries. The host runtime's terminalEnv option must supply the
// active Paperclip run variables to this host-side child shell.
import { createInterface } from "node:readline";

let nextRequestId = 100;
const pending = new Map();

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requestHost(method, params) {
  const id = nextRequestId++;
  writeMessage({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      agentInfo: { name: "paperclip-acp-terminal-env-agent", version: "1.0.0" },
    };
  }
  if (request.method === "session/new") return { sessionId: "terminal-env-session" };
  if (request.method === "session/prompt") {
    const created = await requestHost("terminal/create", {
      sessionId: request.params.sessionId,
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.PAPERCLIP_RUN_ID ?? 'missing')"],
      cwd: process.cwd(),
      env: [],
    });
    await requestHost("terminal/wait_for_exit", { sessionId: request.params.sessionId, terminalId: created.terminalId });
    const output = await requestHost("terminal/output", { sessionId: request.params.sessionId, terminalId: created.terminalId });
    await requestHost("terminal/release", { sessionId: request.params.sessionId, terminalId: created.terminalId });
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output.output } },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (request.method === "session/close" || request.method === "session/set_mode" || request.method === "session/set_config_option") return {};
  if (request.method === "session/cancel") return null;
  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id !== undefined && !request.method) {
      const waiter = pending.get(request.id);
      if (!waiter) return;
      pending.delete(request.id);
      if (request.error) waiter.reject(new Error(request.error.message ?? "ACP request failed"));
      else waiter.resolve(request.result);
      return;
    }
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null) writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined && request.method) {
      writeMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
});
