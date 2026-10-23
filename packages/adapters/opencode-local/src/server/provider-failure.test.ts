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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("OpenCode provider failure contract", () => {
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
