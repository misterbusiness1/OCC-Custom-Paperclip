import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { execute, TOOL_MARKUP_PATTERN } from "./execute.js";

// fetch is stubbed for every test: the MiniMax API is never called. Tool
// commands run for real through the local execution target.

function chatResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function assistantTextTurn(text: string) {
  return chatResponse({
    id: "resp_text",
    object: "chat.completion",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function assistantToolTurn(command: string, callId = "call_1") {
  return chatResponse({
    id: "resp_tool",
    object: "chat.completion",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  });
}

function makeContext(configOverrides: Record<string, unknown> = {}): {
  ctx: AdapterExecutionContext;
  logs: Array<{ stream: string; text: string }>;
} {
  const logs: Array<{ stream: string; text: string }> = [];
  const ctx = {
    runId: "run-test",
    agent: { id: "agent-test", companyId: "company-test" },
    // No executionTarget => local execution in the configured cwd.
    config: {
      env: { MINIMAX_API_KEY: "test-key" },
      cwd: os.tmpdir(),
      toolsEnabled: true,
      ...configOverrides,
    },
    // Carry an issue so the contentless-wake short-circuit does not fire.
    context: { paperclipWake: { issue: { id: "ISS-1", identifier: "ISS-1", title: "Test task" } } },
    onLog: async (stream: string, text: string) => {
      logs.push({ stream, text });
    },
    onMeta: async () => {},
  } as unknown as AdapterExecutionContext;
  return { ctx, logs };
}

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

function requestBody(callIndex: number) {
  return JSON.parse(fetchMock().mock.calls[callIndex]![1].body as string);
}

function toolMessage(callIndex: number) {
  return requestBody(callIndex).messages.find((m: Record<string, unknown>) => m.role === "tool");
}

describe("TOOL_MARKUP_PATTERN", () => {
  it("matches the observed failure signatures", () => {
    expect(TOOL_MARKUP_PATTERN.test('<tool_call>{"name": "bash"}')).toBe(true);
    expect(TOOL_MARKUP_PATTERN.test('<invoke name="shell_command">')).toBe(true);
    expect(TOOL_MARKUP_PATTERN.test("done]<]minimax[>[<tool_call>")).toBe(true);
  });

  it("does not match ordinary prose", () => {
    expect(TOOL_MARKUP_PATTERN.test("I ran the command and it succeeded.")).toBe(false);
  });
});

describe("execute tool loop", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_LOCAL_TOOLS_ENABLED;
    delete process.env.MINIMAX_LOCAL_MAX_TOOL_ITERATIONS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.MINIMAX_LOCAL_TOOLS_ENABLED;
    delete process.env.MINIMAX_LOCAL_MAX_TOOL_ITERATIONS;
  });

  it.each(["explicit", "default", "operator"])("refuses unsolicited bash calls with tools disabled by %s", async (mode) => {
    const shell = vi.spyOn(executionTarget, "runAdapterExecutionTargetShellCommand");
    const prepare = vi.spyOn(executionTarget, "prepareAdapterExecutionTargetRuntime");
    fetchMock().mockResolvedValueOnce(assistantToolTurn("echo must-never-run"));
    const { ctx } = makeContext({ toolsEnabled: mode === "operator" });
    if (mode === "default") delete (ctx.config as Record<string, unknown>).toolsEnabled;
    if (mode === "operator") process.env.MINIMAX_LOCAL_TOOLS_ENABLED = "false";

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("minimax_tools_disabled");
    expect(shell).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(requestBody(0).tools).toBeUndefined();
  });

  it("includes a malformed second turn's usage after an executed tool turn, exactly once", async () => {
    fetchMock()
      .mockResolvedValueOnce(assistantToolTurn("echo accounted-tool"))
      .mockResolvedValueOnce(chatResponse({
        choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 },
      }));
    const { ctx } = makeContext();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("minimax_empty_completion");
    expect(result.usage).toEqual({ inputTokens: 32, outputTokens: 15, cachedInputTokens: 0 });
    expect(result.costUsd).toBeCloseTo((32 * 0.3 + 15 * 1.2) / 1_000_000, 12);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("executes a tool round trip and returns the final text with accumulated usage", async () => {
    fetchMock()
      .mockResolvedValueOnce(assistantToolTurn("echo tool-was-executed"))
      .mockResolvedValueOnce(assistantTextTurn("Done: the file check passed."));

    const { ctx, logs } = makeContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Done: the file check passed.");
    expect(result.usage?.inputTokens).toBe(30);
    expect(result.usage?.outputTokens).toBe(13);
    expect((result.resultJson as Record<string, unknown>).toolCallCount).toBe(1);

    const stdout = logs.filter((l) => l.stream === "stdout").map((l) => l.text).join("");
    expect(stdout).toContain("[tool] $ echo tool-was-executed");
    expect(stdout).toContain("tool-was-executed");
    expect(stdout).toContain("[tool] exit 0");

    // The first request offers the bash tool; the second carries its result back.
    expect(requestBody(0).tools).toHaveLength(1);
    expect(requestBody(0).tools[0].function.name).toBe("bash");
    const tool = toolMessage(1);
    expect(tool).toBeTruthy();
    expect(tool.tool_call_id).toBe("call_1");
    expect(String(tool.content)).toContain("exit code: 0");
    expect(String(tool.content)).toContain("tool-was-executed");
    expect(requestBody(1).tools).toHaveLength(1);
  });

  it("does not expose the MiniMax credential to tool commands", async () => {
    process.env.MINIMAX_API_KEY = "host-secret-should-not-leak";
    fetchMock()
      .mockResolvedValueOnce(assistantToolTurn('echo "K=[$MINIMAX_API_KEY] F=[$MINIMAX_API_KEY_FILE]"'))
      .mockResolvedValueOnce(assistantTextTurn("checked"));

    const { ctx } = makeContext({ env: { MINIMAX_API_KEY: "company-secret" } });
    const result = await execute(ctx);

    const content = String(toolMessage(1).content);
    expect(content).toContain("K=[] F=[]");
    expect(content).not.toContain("company-secret");
    expect(content).not.toContain("host-secret-should-not-leak");
    expect(result.exitCode).toBe(0);
  });

  it("truncates oversized tool output before returning it to the model", async () => {
    fetchMock()
      .mockResolvedValueOnce(assistantToolTurn("head -c 100000 /dev/zero | tr '\\0' 'x'"))
      .mockResolvedValueOnce(assistantTextTurn("done"));

    const { ctx } = makeContext({ toolOutputLimitBytes: 1024 });
    await execute(ctx);

    const content = String(toolMessage(1).content);
    expect(content).toContain("[output truncated]");
    expect(content.length).toBeLessThan(2048);
  });

  it("fails with minimax_iteration_cap when the cap is reached, still recording usage", async () => {
    fetchMock().mockImplementation(() => Promise.resolve(assistantToolTurn("echo again")));

    const { ctx, logs } = makeContext({ maxToolIterations: 3 });
    const result = await execute(ctx);

    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("minimax_iteration_cap");
    expect(result.errorFamily).toBeNull();
    expect(result.errorMessage).toContain("3-iteration tool cap");
    expect((result.resultJson as Record<string, unknown> | undefined)?.stopReason).toBe("iteration_cap");
    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(result.usage?.inputTokens).toBe(60);
    expect(result.billingType).toBe("metered_api");
    expect(typeof result.costUsd).toBe("number");
    expect(logs.some((l) => l.text.startsWith("[paperclip] Reached the 3-iteration tool cap"))).toBe(true);
  });

  it("defaults the iteration cap to 25", async () => {
    fetchMock().mockImplementation(() => Promise.resolve(assistantToolTurn("true")));
    const { ctx } = makeContext();
    const result = await execute(ctx);
    expect(result.errorCode).toBe("minimax_iteration_cap");
    expect(fetchMock()).toHaveBeenCalledTimes(25);
  }, 30_000);

  it("fails with minimax_tool_markup when the final text narrates tool-call markup", async () => {
    fetchMock().mockResolvedValueOnce(
      assistantTextTurn('I will check the state.\n<tool_call>{"name": "bash", "arguments": {"command": "ls"}}'),
    );

    const { ctx } = makeContext();
    const result = await execute(ctx);

    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("minimax_tool_markup");
    expect((result.resultJson as Record<string, unknown> | undefined)?.stopReason).toBe("tool_markup_in_text");
    expect(result.usage?.inputTokens).toBe(10);
  });

  it("fails with minimax_repeated_command_failure when the same command fails three times", async () => {
    fetchMock().mockImplementation(() => Promise.resolve(assistantToolTurn("exit 7")));

    const { ctx, logs } = makeContext();
    const result = await execute(ctx);

    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("minimax_repeated_command_failure");
    expect((result.resultJson as Record<string, unknown> | undefined)?.stopReason).toBe("repeated_command_failure");
    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(logs.filter((l) => l.text === "[tool] exit 7\n")).toHaveLength(3);
  });

  it("resets the repeated-failure counter when the command succeeds in between", async () => {
    fetchMock()
      .mockResolvedValueOnce(assistantToolTurn("test -f flag-file"))
      .mockResolvedValueOnce(assistantToolTurn("test -f flag-file"))
      .mockResolvedValueOnce(assistantToolTurn("true"))
      .mockResolvedValueOnce(assistantTextTurn("finished"));
    const { ctx } = makeContext();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("finished");
  });

  it("returns unknown-tool errors to the model instead of executing", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        chatResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "c1", type: "function", function: { name: "rm_rf_everything", arguments: "{}" } }],
              },
            },
          ],
          usage: {},
        }),
      )
      .mockResolvedValueOnce(assistantTextTurn("Understood, bash only."));

    const { ctx } = makeContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(String(toolMessage(1).content)).toContain("Unknown tool");
    expect((result.resultJson as Record<string, unknown>).toolCallCount).toBe(0);
  });

  it("runs bash tool commands in the execution-workspace worktree (paperclipWorkspace.cwd)", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-worktree-"));
    try {
      fetchMock()
        .mockResolvedValueOnce(assistantToolTurn("echo PAPERCLIP_OK > marker.txt"))
        .mockResolvedValueOnce(assistantTextTurn("wrote it"));

      const { ctx } = makeContext({ cwd: "/definitely/not/used" });
      (ctx as unknown as { context: Record<string, unknown> }).context = {
        paperclipWorkspace: { cwd: worktree },
        paperclipWake: { issue: { id: "ISS-1", identifier: "ISS-1", title: "Test task" } },
      };

      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);
      const marker = await fs.readFile(path.join(worktree, "marker.txt"), "utf8");
      expect(marker.trim()).toBe("PAPERCLIP_OK");
    } finally {
      await fs.rm(worktree, { recursive: true, force: true });
    }
  });

  it("sanitizes malformed tool-call arguments so the next request stays valid JSON", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        chatResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "call_bad", type: "function", function: { name: "bash", arguments: "command: ls (not json" } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(assistantTextTurn("recovered"));

    const { ctx } = makeContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const assistantMsg = requestBody(1).messages.find(
      (m: Record<string, unknown>) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls[0].function.arguments).toBe("{}");
    expect(String(toolMessage(1).content)).toContain("Invalid bash tool arguments");
  });

  it("exposes the Paperclip API env and the run authToken to the bash tool", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        assistantToolTurn(
          'echo "PCURL=[$PAPERCLIP_API_URL] PCKEY=[$PAPERCLIP_API_KEY] AID=[$PAPERCLIP_AGENT_ID] CID=[$PAPERCLIP_COMPANY_ID] TID=[$PAPERCLIP_TASK_ID]"',
        ),
      )
      .mockResolvedValueOnce(assistantTextTurn("done"));

    const { ctx, logs } = makeContext();
    (ctx as unknown as { authToken?: string }).authToken = "run-token-xyz";
    (ctx as unknown as { context: Record<string, unknown> }).context.taskId = "ISS-1";
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const stdout = logs.filter((l) => l.stream === "stdout").map((l) => l.text).join("");
    expect(stdout).toMatch(/PCURL=\[https?:\/\//);
    expect(stdout).toContain("PCKEY=[run-token-xyz]");
    expect(stdout).toContain("AID=[agent-test]");
    expect(stdout).toContain("CID=[company-test]");
    expect(stdout).toContain("TID=[ISS-1]");
    expect(stdout).toContain("PAPERCLIP_API_KEY=set");
  });

  it("uses the server-minted authToken even if adapter env carries a PAPERCLIP_API_KEY", async () => {
    // The heartbeat strips that binding before execute(); this guards the
    // adapter side too.
    fetchMock()
      .mockResolvedValueOnce(assistantToolTurn('echo "PCKEY=[$PAPERCLIP_API_KEY]"'))
      .mockResolvedValueOnce(assistantTextTurn("done"));

    const { ctx, logs } = makeContext({ env: { MINIMAX_API_KEY: "test-key", PAPERCLIP_API_KEY: "pinned-key" } });
    (ctx as unknown as { authToken?: string }).authToken = "run-token-xyz";
    await execute(ctx);

    const stdout = logs.filter((l) => l.stream === "stdout").map((l) => l.text).join("");
    expect(stdout).toContain("PCKEY=[run-token-xyz]");
    expect(stdout).not.toContain("pinned-key");
  });

  it("keeps server-minted run identity immutable across configured env merges", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        assistantToolTurn('echo "A=[$PAPERCLIP_AGENT_ID] C=[$PAPERCLIP_COMPANY_ID] R=[$PAPERCLIP_RUN_ID]"'),
      )
      .mockResolvedValueOnce(assistantTextTurn("done"));

    const { ctx, logs } = makeContext({
      env: {
        MINIMAX_API_KEY: "test-key",
        PAPERCLIP_AGENT_ID: "spoof-agent",
        PAPERCLIP_COMPANY_ID: "spoof-company",
        PAPERCLIP_RUN_ID: "spoof-run",
      },
    });
    await execute(ctx);

    const stdout = logs.filter((l) => l.stream === "stdout").map((l) => l.text).join("");
    expect(stdout).toContain("A=[agent-test] C=[company-test] R=[run-test]");
    expect(stdout).not.toContain("spoof-");
  });

  it("omits tools and skips the loop when toolsEnabled=false", async () => {
    fetchMock().mockResolvedValueOnce(assistantTextTurn("Plain chat answer."));

    const { ctx } = makeContext({ toolsEnabled: false });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Plain chat answer.");
    expect(requestBody(0).tools).toBeUndefined();
    expect(String(requestBody(0).messages[0].content)).not.toContain("Paperclip API access");
  });

  it("omits tools when toolsEnabled is not set (default off)", async () => {
    fetchMock().mockResolvedValueOnce(assistantTextTurn("Plain chat answer."));

    const { ctx } = makeContext();
    delete (ctx.config as Record<string, unknown>).toolsEnabled;
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(requestBody(0).tools).toBeUndefined();
  });

  it("lets the operator force tools on or off fleet-wide with MINIMAX_LOCAL_TOOLS_ENABLED", async () => {
    process.env.MINIMAX_LOCAL_TOOLS_ENABLED = "false";
    fetchMock().mockResolvedValueOnce(assistantTextTurn("chat"));
    const { ctx } = makeContext({ toolsEnabled: true });
    await execute(ctx);
    expect(requestBody(0).tools).toBeUndefined();
  });
});
