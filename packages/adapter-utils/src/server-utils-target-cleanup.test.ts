import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildLocalProcessSandboxSpawnTargetMock } = vi.hoisted(() => ({
  buildLocalProcessSandboxSpawnTargetMock: vi.fn(),
}));

vi.mock("./local-process-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-process-sandbox.js")>()),
  buildLocalProcessSandboxSpawnTarget: buildLocalProcessSandboxSpawnTargetMock,
}));

import { runChildProcess } from "./server-utils.js";

// paperclipai/paperclip#15567: a rejected sandbox cleanup used to become an
// unhandled rejection that exits the server.
describe("runChildProcess sandbox target cleanup", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    buildLocalProcessSandboxSpawnTargetMock.mockReset();
  });

  async function settleRejections(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  it("still resolves and logs when cleanup rejects after the child closes", async () => {
    const cleanupError = new Error("sandbox cleanup failed");
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });
    buildLocalProcessSandboxSpawnTargetMock.mockResolvedValue({
      command: "bwrap",
      args: ["-e", "process.stdout.write('done')"],
      cwd: process.cwd(),
      env: {},
      cleanup,
    });
    const onLogError = vi.fn();

    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
      onLogError,
      localProcessSandbox: {
        workspaceDir: process.cwd(),
        networkScope: "deny",
        command: process.execPath,
      },
    });
    await settleRejections();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onLogError).toHaveBeenCalledWith(
      cleanupError,
      expect.any(String),
      "failed to clean up execution target",
    );
    expect(unhandled).toEqual([]);
  });

  it("still rejects with the start error and logs when cleanup rejects after a spawn error", async () => {
    const cleanupError = new Error("sandbox cleanup failed");
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });
    buildLocalProcessSandboxSpawnTargetMock.mockResolvedValue({
      command: "bwrap",
      args: ["-e", "process.exit(0)"],
      // A missing working directory makes spawn emit "error".
      cwd: path.join(os.tmpdir(), `paperclip-missing-cwd-${randomUUID()}`),
      env: {},
      cleanup,
    });
    const onLogError = vi.fn();

    await expect(
      runChildProcess(randomUUID(), process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        onLogError,
        localProcessSandbox: {
          workspaceDir: process.cwd(),
          networkScope: "deny",
          command: process.execPath,
        },
      }),
    ).rejects.toThrow("Failed to start command");
    await settleRejections();

    // Node may also emit "close" after a spawn error, so cleanup can run on
    // both paths; every rejection must still be handled.
    expect(cleanup).toHaveBeenCalled();
    expect(onLogError).toHaveBeenCalledWith(
      cleanupError,
      expect.any(String),
      "failed to clean up execution target",
    );
    expect(unhandled).toEqual([]);
  });
});
