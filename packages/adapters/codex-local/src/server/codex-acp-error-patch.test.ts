import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Exercise the installed, patched codex-acp 2.5.0 bundle's own provider-error
// methods. codex-local's quota / 429 / 5xx / auth classification depends on the
// bridge failing every non-retryable turn with a JSON-RPC internal error that
// carries `codexErrorInfo` (and streaming the provider sentence as output for a
// non-AIR client), exactly as the old 1.1.7 patch did.
const bundle = await fs.readFile(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8");

function method(signature: string): string {
  const start = bundle.indexOf(`\n  ${signature} {`);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = bundle.indexOf("\n  }\n", start + 1);
  expect(end, signature).toBeGreaterThan(start);
  return bundle.slice(start, end + "\n  }\n".length);
}

class RequestError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
  static internalError(data?: unknown, additionalMessage?: string) {
    return new RequestError(-32603, `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  static authRequired(data?: unknown, additionalMessage?: string) {
    return new RequestError(-32000, `Authentication required${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
}

type Handler = {
  failure: RequestError | null;
  sessionState: Record<string, unknown>;
  supportsTypedSessionFailures: boolean;
  createErrorEvent(params: Record<string, unknown>): Promise<unknown>;
  handleFailedTurn(turn: Record<string, unknown>): Promise<void>;
};

const HandlerClass = new Function(
  "RequestError",
  "createAgentTextMessageChunk",
  "readableServiceErrorMessage",
  "failuresShownAsMessages",
  "logger",
  `return class {
    constructor(sessionState) {
      this.sessionState = sessionState;
      this.failure = null;
      this.pendingErrors = [];
      this.supportsTypedSessionFailures = false;
      this.terminalTurnError = null;
    }
    createCodexSessionInfoUpdate(value) { return { sessionInfo: value }; }
    ${method("async createErrorEvent(params)")}
    ${method("async handleFailedTurn(turn)")}
    ${method("isAuthenticationRequiredError(error62)")}
    ${method("getHttpStatusCode(error62)")}
    ${method("createTurnErrorData(error62)")}
  };`,
)(
  RequestError,
  (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
  (text: string) => text,
  new WeakSet(),
  { log: () => {} },
) as new (sessionState: Record<string, unknown>) => Handler;

function handler(authConfigured: boolean): Handler {
  return new HandlerClass({ sessionId: "session-1", currentTurnId: "turn-1", authConfigured });
}

function errorParams(error: Record<string, unknown>, willRetry = false) {
  return { threadId: "session-1", turnId: "turn-1", willRetry, error: { additionalDetails: null, ...error } };
}

describe("patched codex-acp 2.5.0 provider-error handling", () => {
  it.each([
    ["usage limit", { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" }],
    ["429 throttle", { message: "exceeded retry limit, last status: 429 Too Many Requests", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }],
    ["5xx upstream", { message: "stream disconnected before completion", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }],
    ["unstructured", { message: "provider rejected request", codexErrorInfo: null }],
  ])("fails a non-retryable %s error with an internal error carrying codexErrorInfo and streams its text", async (_label, error) => {
    const h = handler(true);
    const update = await h.createErrorEvent(errorParams(error));
    expect(h.failure?.code).toBe(-32603);
    expect(h.failure?.data).toEqual({
      message: error.message,
      ...(error.codexErrorInfo === null ? {} : { codexErrorInfo: error.codexErrorInfo }),
    });
    expect(update).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${error.message}\n\n` } });
    // The later turn/completed keeps the first failure.
    await h.handleFailedTurn({ id: "turn-1", status: "failed", error: { ...error, additionalDetails: null } });
    expect(h.failure?.code).toBe(-32603);
  });

  it("leaves a retrying error non-terminal", async () => {
    const h = handler(true);
    await h.createErrorEvent(errorParams({ message: "reconnecting", codexErrorInfo: null }, true));
    expect(h.failure).toBeNull();
  });

  it("keeps a configured-auth 401 as an internal error with its provider data (1.1.7 parity)", async () => {
    const error = { message: "unexpected status 401 Unauthorized", codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } };
    const h = handler(true);
    const update = await h.createErrorEvent(errorParams(error));
    expect(h.failure?.code).toBe(-32603);
    expect(h.failure?.data).toMatchObject({ codexErrorInfo: error.codexErrorInfo });
    expect(update).toMatchObject({ content: { text: `${error.message}\n\n` } });
    await h.handleFailedTurn({ id: "turn-1", status: "failed", error: { ...error, additionalDetails: null } });
    expect(h.failure?.code).toBe(-32603);
  });

  it("reports authentication required with the provider message when no auth is configured", async () => {
    const error = { message: "Not logged in", codexErrorInfo: "unauthorized" };
    const h = handler(false);
    await h.createErrorEvent(errorParams(error));
    expect(h.failure?.code).toBe(-32000);
    expect(h.failure?.message).toBe("Authentication required: Not logged in");
    expect(h.failure?.data).toEqual({ message: "Not logged in", codexErrorInfo: "unauthorized" });
  });

  it("fails a turn that completes as failed without an error notification", async () => {
    const configured = handler(true);
    await configured.handleFailedTurn({ id: "turn-1", status: "failed", error: { message: "denied", codexErrorInfo: "unauthorized", additionalDetails: null } });
    expect(configured.failure?.code).toBe(-32603);
    const unconfigured = handler(false);
    await unconfigured.handleFailedTurn({ id: "turn-1", status: "failed", error: { message: "denied", codexErrorInfo: "unauthorized", additionalDetails: null } });
    expect(unconfigured.failure?.code).toBe(-32000);
    const quota = handler(true);
    await quota.handleFailedTurn({ id: "turn-1", status: "failed", error: { message: "limit", codexErrorInfo: "usageLimitExceeded", additionalDetails: null } });
    expect(quota.failure?.data).toMatchObject({ codexErrorInfo: "usageLimitExceeded" });
    const completed = handler(true);
    await completed.handleFailedTurn({ id: "turn-1", status: "completed", error: null });
    expect(completed.failure).toBeNull();
  });

  it("does not start a billable title-generation turn unless explicitly enabled", () => {
    const onTurnCompleted = method("onTurnCompleted(userPromptText)");
    expect(onTurnCompleted).toMatch(/if \(process\.env\.PAPERCLIP_CODEX_ACP_TITLE_GENERATION !== "true"\) return;/);
    expect(onTurnCompleted.indexOf("PAPERCLIP_CODEX_ACP_TITLE_GENERATION")).toBeLessThan(onTurnCompleted.indexOf("generateAndPersist"));
  });
});
