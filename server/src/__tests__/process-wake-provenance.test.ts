import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "../adapters/process/execute.js";

async function captureWakeReason(wakeReason: unknown) {
  const result = await execute({
    runId: "synthetic-run",
    agent: { id: "synthetic-agent", companyId: "synthetic-company", name: "Synthetic", adapterType: "process", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    context: { wakeReason },
    config: {
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({wakeReason: process.env.PAPERCLIP_WAKE_REASON ?? null}))"],
      env: { PAPERCLIP_WAKE_REASON: "configured-spoof" },
    },
    onLog: async () => {},
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(String(result.resultJson?.stdout).trim());
}

afterEach(() => vi.unstubAllEnvs());

describe("process adapter wake provenance", () => {
  it.each(["heartbeat_timer", "issue_continuation_needed"])("injects runtime %s over configuration and inherited values", async (reason) => {
    vi.stubEnv("PAPERCLIP_WAKE_REASON", "inherited-spoof");
    expect(await captureWakeReason(reason)).toEqual({ wakeReason: reason });
  });

  it.each([undefined, null, "", "  ", 123])("does not fabricate provenance when runtime reason is %s", async (reason) => {
    vi.stubEnv("PAPERCLIP_WAKE_REASON", "inherited-spoof");
    expect(await captureWakeReason(reason)).toEqual({ wakeReason: null });
  });
});
