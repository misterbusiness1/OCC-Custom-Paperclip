import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("@paperclipai/adapter-utils/execution-target", async (original) => ({
  ...await original<Record<string, unknown>>(), runAdapterExecutionTargetProcess: vi.fn(),
}));
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "./execute.js";
import { parseOpenCodeJsonl } from "./parse.js";
const processMock = vi.mocked(runAdapterExecutionTargetProcess);
const event = (statusCode: number, retryAfter?: string) => ({ type: "error", error: { name: "APIError", data: {
  message: "Synthetic provider failure", statusCode, isRetryable: statusCode === 429,
  responseHeaders: retryAfter ? { "Retry-After": retryAfter, authorization: "synthetic-private-header" } : {},
  responseBody: "synthetic-private-body", metadata: { url: "https://synthetic.invalid/private" },
} } });
const proc = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode, signal: null, timedOut: false,
  pid: 123, startedAt: new Date().toISOString() });
const sdkEvent = (status: number, retryable: unknown, hint?: string) => {
  const failure = event(status, hint);
  return { ...failure, error: { ...failure.error, data: { ...failure.error.data, isRetryable: retryable } } };
};
async function executeEvents(events: unknown[], disposition: { errorCode?: string; timedOut?: boolean; exitCode?: number } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-upstream-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  const command = path.join(home, "synthetic-opencode");
  await fs.writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  processMock.mockReset();
  processMock.mockResolvedValueOnce({ ...proc(events.map(value => JSON.stringify(value)).join("\n"), 1), ...disposition } as never);
  try {
    return await execute({ runId: "synthetic", agent: { id: "agent-1", companyId: "company-1", name: "Synthetic", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command, cwd: home, model: "nvidia-glm/z-ai/glm-5.3" }, context: {}, onLog: async () => {} });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("OpenCode provider failure contract", () => {
  it("recovers a structured SDK-retryable 502 without inventing a reset time", async () => {
    const result = await executeEvents([sdkEvent(502, true)]);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "opencode_transient_upstream", errorFamily: "transient_upstream",
      resultJson: { providerHttpStatus: 502, errorFamily: "transient_upstream" } });
    expect(result.retryNotBefore).toBeUndefined();
  });
  it.each([408, 409, 500, 501, 503, 504, 599])("recovers SDK-qualified transient HTTP %s", async (status) => {
    const result = await executeEvents([sdkEvent(status, true)]);
    expect(result).toMatchObject({ errorCode: "opencode_transient_upstream", errorFamily: "transient_upstream",
      resultJson: { providerHttpStatus: status, errorFamily: "transient_upstream" } });
    expect(result.retryNotBefore).toBeUndefined();
  });
  it.each([[400, true], [401, true], [402, true], [403, true], [404, true], [422, true], [499, true],
    [500, false], [502, false], [503, undefined], [504, "true"], [502, 1], [600, true]] as const)(
    "does not classify HTTP %s with SDK flag %s as provider-transient", async (status, flag) => {
      const result = await executeEvents([sdkEvent(status, flag, "600")]);
      expect(result.errorCode).toBeNull();
      expect(result.errorFamily).toBeUndefined();
      expect(result.retryNotBefore).toBeUndefined();
      expect(result.resultJson).not.toHaveProperty("errorFamily");
    });
  it.each([false, undefined, "true"])("preserves structured429 recovery with SDK flag %s", async (flag) => {
    expect(await executeEvents([sdkEvent(429, flag)])).toMatchObject({ errorCode: "opencode_transient_upstream", errorFamily: "transient_upstream" });
  });
  it.each([["12", "2030-01-01T00:00:12.000Z"], ["Tue, 01 Jan 2030 00:01:00 GMT", "2030-01-01T00:01:00.000Z"],
    [undefined, undefined], ["invalid", undefined], ["-1", undefined], ["999999999999999999999999", undefined]] as const)(
    "honors only a valid future Retry-After %s for retryable503", async (hint, expected) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00.000Z"));
      const result = await executeEvents([sdkEvent(503, true, hint)]);
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.retryNotBefore).toBe(expected);
    });
  it.each([
    { last: sdkEvent(502, false), expectedSdkFlag: false },
    { last: sdkEvent(401, true), expectedSdkFlag: true },
    { last: { type: "error", error: { message: "Fatal 502" } }, expectedSdkFlag: false },
  ])("resets prior SDK retryability and hint on the final error", async ({ last, expectedSdkFlag }) => {
    const stream = [sdkEvent(502, true, "600"), last];
    expect(parseOpenCodeJsonl(stream.map(value => JSON.stringify(value)).join("\n")).providerRetryable)
      .toBe(expectedSdkFlag);
    const result = await executeEvents(stream);
    expect(result.errorFamily).toBeUndefined();
    expect(result.retryNotBefore).toBeUndefined();
  });
  it("never treats model/tool/unrelated error metadata as SDK retryability", async () => {
    for (const value of [
      { type: "text", part: { text: "502 isRetryable:true" } },
      { type: "tool_use", part: { state: { status: "error", error: "502", isRetryable: true } } },
      { type: "error", error: { name: "OtherError", data: { statusCode: 502, isRetryable: true } } },
      { type: "error", error: { name: "APIError", data: { statusCode: "502", isRetryable: true } } },
    ]) {
      expect(parseOpenCodeJsonl(JSON.stringify(value))).toMatchObject({ providerHttpStatus: null, providerRetryable: false });
      expect((await executeEvents([value])).errorFamily).toBeUndefined();
    }
  });
  it("projects retryability without copying private SDK response metadata", () => {
    const parsed = parseOpenCodeJsonl(JSON.stringify(sdkEvent(502, true, "600")));
    expect(parsed).toMatchObject({ providerHttpStatus: 502, providerRetryable: true, retryAfter: "600" });
    for (const secret of ["synthetic-private-header", "synthetic-private-body", "synthetic.invalid"])
      expect(JSON.stringify(parsed)).not.toContain(secret);
  });
  it("preserves duplex transport failure precedence over retryable502", async () => {
    const result = await executeEvents([sdkEvent(502, true, "600")], { errorCode: "duplex_channel_lost" });
    expect(result.errorCode).toBe("duplex_channel_lost");
    expect(result.errorFamily).toBeUndefined();
    expect(result.retryNotBefore).toBeUndefined();
  });
  it("preserves process timeout precedence over retryable502", async () => {
    const result = await executeEvents([sdkEvent(502, true, "600")], { timedOut: true });
    expect(result.timedOut).toBe(true);
    expect(result.errorFamily).toBeUndefined();
    expect(result.retryNotBefore).toBeUndefined();
  });
  it("synthesizes failure when the SDK reports retryable502 but the CLI exits zero", async () => {
    expect(await executeEvents([sdkEvent(502, true)], { exitCode: 0 })).toMatchObject({ exitCode: 1, errorFamily: "transient_upstream" });
  });
  it.each([429, 401, 402, 500])("retains only safe structured fields for APIError %s", (status) => {
    const parsed = parseOpenCodeJsonl(JSON.stringify(event(status, "12")));
    expect(parsed).toMatchObject({ providerHttpStatus: status, retryAfter: "12" });
    for (const secret of ["synthetic-private-header", "synthetic-private-body", "synthetic.invalid"])
      expect(JSON.stringify(parsed)).not.toContain(secret);
  });
  it("never infers status from text, tool errors or unrelated structured errors", () => {
    for (const value of [
      { type: "error", error: { message: "429 Too Many Requests" } },
      { type: "error", error: { name: "OtherError", data: { statusCode: 429 } } },
      { type: "tool_use", part: { state: { status: "error", error: "429" } } },
      { type: "text", part: { text: "429 Too Many Requests" } },
    ]) expect(parseOpenCodeJsonl(JSON.stringify(value)).providerHttpStatus).toBeNull();
  });
  it("does not reuse an earlier 429 after a fatal error", () => {
    const parsed = parseOpenCodeJsonl([event(429, "12"), event(401)].map(x => JSON.stringify(x)).join("\n"));
    expect(parsed.providerHttpStatus).toBe(401);
    expect(parsed.retryAfter).toBeNull();
  });
  it.each([
    [429, "12", "2030-01-01T00:00:12.000Z"],
    [429, "Tue, 01 Jan 2030 00:01:00 GMT", "2030-01-01T00:01:00.000Z"],
    [429, undefined, null], [429, "invalid", null], [429, "-1", null], [429, "999999999999999999999999", null], [401, "12", null], [402, "12", null], [500, "12", null],
  ])("propagates status %s / retry hint %s through actual execute", async (status, hint, due) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-provider-test-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00.000Z"));
    const command = path.join(home, "synthetic-opencode");
    await fs.writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    processMock.mockReset();
    processMock.mockResolvedValueOnce(proc(JSON.stringify(event(status as number, hint as string | undefined)), 1) as never);
    try {
      const result = await execute({ runId: "synthetic", agent: { id: "agent-1", companyId: "company-1", name: "Synthetic", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command, cwd: home, model: "nvidia-glm/z-ai/glm-5.3" }, context: {}, onLog: async () => {} });
      expect(result.exitCode).toBe(1);
      expect(result.resultJson).toMatchObject({ providerHttpStatus: status });
      expect(result.errorFamily ?? null).toBe(status === 429 ? "transient_upstream" : null);
      expect(result.errorCode ?? null).toBe(status === 429 ? "opencode_transient_upstream" : null);
      expect(result.retryNotBefore ?? null).toBe(due);
      if (status === 429) expect(result.resultJson).toMatchObject({ errorFamily: "transient_upstream" });
      expect(result.provider).toBe("nvidia-glm");
      expect(result.model).toBe("nvidia-glm/z-ai/glm-5.3");
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
});
