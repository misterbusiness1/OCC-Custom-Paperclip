import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HOST_RUN_JWT = "host-run-jwt-should-stay-on-host";

const grokStdout = [
  JSON.stringify({ type: "text", data: "done" }),
  JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "grok-session-1", requestId: "req-1" }),
].join("\n");

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  bridgeStop,
  startAdapterExecutionTargetPaperclipBridge,
  prepareAdapterExecutionTargetRuntime,
} = vi.hoisted(() => {
  const bridgeStop = vi.fn(async () => {});
  return {
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", data: "done" }),
        JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "grok-session-1", requestId: "req-1" }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: grok"),
    prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
    restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
    runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    syncDirectoryToSsh: vi.fn(async () => undefined),
    bridgeStop,
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
      env: {
        PAPERCLIP_API_URL: "http://127.0.0.1:4310",
        PAPERCLIP_API_KEY: "bridge-token",
        PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
      },
      runLogTail: null,
      stop: bridgeStop,
    })),
    // Wraps the real implementation; individual tests can override it once.
    prepareAdapterExecutionTargetRuntime: vi.fn(),
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  prepareAdapterExecutionTargetRuntime.mockImplementation(actual.prepareAdapterExecutionTargetRuntime);
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

const sshRemoteExecution = {
  host: "127.0.0.1",
  port: 2222,
  username: "fixture",
  remoteWorkspacePath: "/remote/workspace",
  remoteCwd: "/remote/workspace",
  privateKey: "PRIVATE KEY",
  knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
  strictHostKeyChecking: true,
};

const grokAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Grok Builder",
  adapterType: "grok_local",
  adapterConfig: {},
};

const freshRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};

type ChildProcessCall = [string, string, string[], { env: Record<string, string> }];

describe("grok remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    // clearAllMocks keeps implementations, so the real prepare wrapper survives.
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspace(prefix: string) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return { rootDir, workspaceDir };
  }

  it("routes Paperclip API access through the callback bridge and inlines host instructions over SSH", async () => {
    const { rootDir, workspaceDir } = await makeWorkspace("paperclip-grok-remote-");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    // The workspace already has its own Agents.md, so the managed instructions
    // file cannot be staged there and the adapter must fall back.
    await writeFile(path.join(workspaceDir, "Agents.md"), "Workspace rules.\n", "utf8");
    const instructionsPath = path.join(rootDir, "managed", "AGENTS.md");
    await mkdir(path.dirname(instructionsPath), { recursive: true });
    await writeFile(instructionsPath, "You are Grok on a remote host.\n", "utf8");

    const result = await execute({
      runId: "run-1",
      agent: grokAgent,
      runtime: freshRuntime,
      config: {
        command: "grok",
        instructionsFilePath: instructionsPath,
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: { remoteExecution: sshRemoteExecution },
      authToken: HOST_RUN_JWT,
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, errorMessage: null, sessionId: "grok-session-1" });
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      adapterKey: "grok",
      hostApiToken: HOST_RUN_JWT,
      runtimeRootDir: `${managedRemoteWorkspace}/.paperclip-runtime/grok`,
      target: expect.objectContaining({ kind: "remote", transport: "ssh", remoteCwd: managedRemoteWorkspace }),
    }));

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as ChildProcessCall;
    const [, command, args, options] = call;
    expect(command).toBe("grok");
    expect(options.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(options.env.PAPERCLIP_API_KEY).toBe("bridge-token");
    expect(options.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(Object.values(options.env)).not.toContain(HOST_RUN_JWT);
    expect(Object.values(options.env).some((value) => value.includes("localhost:3100"))).toBe(false);

    expect(args[args.indexOf("--cwd") + 1]).toBe(managedRemoteWorkspace);
    expect(args).not.toContain("--rules");
    const prompt = args[args.length - 1];
    expect(args[args.length - 2]).toBe("--single");
    expect(args.slice(0, -1).some((value) => value.includes(instructionsPath))).toBe(false);
    expect(prompt).toContain("You are Grok on a remote host.");

    expect(bridgeStop).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("stops the callback bridge and restores the workspace when the remote Grok process fails", async () => {
    const { workspaceDir } = await makeWorkspace("paperclip-grok-remote-fail-");
    runChildProcess.mockRejectedValueOnce(new Error("ssh connection dropped"));

    await expect(execute({
      runId: "run-fail",
      agent: grokAgent,
      runtime: freshRuntime,
      config: { command: "grok" },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: { remoteExecution: sshRemoteExecution },
      authToken: HOST_RUN_JWT,
      onLog: async () => {},
    })).rejects.toThrow("ssh connection dropped");

    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(bridgeStop).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("never sends the host run JWT to sandbox commands, including the runtime install probe", async () => {
    const { workspaceDir } = await makeWorkspace("paperclip-grok-sandbox-");
    const sandboxRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-sandbox-1/workspace";
    const restoreSandboxWorkspace = vi.fn(async () => {});
    // The sandbox workspace tar transfer is covered by adapter-utils; stub it so
    // this test only observes the commands the Grok adapter itself sends.
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async (input: { target: unknown }) => ({
      target: input.target,
      workspaceRemoteDir: sandboxRemoteWorkspace,
      runtimeRootDir: `${sandboxRemoteWorkspace}/.paperclip-runtime/grok`,
      assetDirs: {},
      restoreWorkspace: restoreSandboxWorkspace,
    }));
    const runnerExecute = vi.fn(async (input: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: input.command === "grok" ? grokStdout : "",
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute({
      runId: "run-sandbox-1",
      agent: grokAgent,
      runtime: freshRuntime,
      config: { command: "grok" },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fake-sandbox",
        remoteCwd: "/remote/workspace",
        runner: { execute: runnerExecute },
      },
      runtimeCommandSpec: {
        command: "grok",
        installCommand: "npm install -g grok-cli",
        detectCommand: "grok",
      },
      authToken: HOST_RUN_JWT,
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, errorMessage: null });
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(expect.objectContaining({
      adapterKey: "grok",
      hostApiToken: HOST_RUN_JWT,
      runtimeRootDir: `${sandboxRemoteWorkspace}/.paperclip-runtime/grok`,
    }));
    // The install probe ran through the sandbox runner.
    expect(runnerExecute.mock.calls.some(([input]) => JSON.stringify(input).includes("command -v"))).toBe(true);
    for (const [input] of runnerExecute.mock.calls) {
      expect(JSON.stringify(input)).not.toContain(HOST_RUN_JWT);
    }
    const grokCall = runnerExecute.mock.calls.find(([input]) => input.command === "grok");
    expect(grokCall?.[0].env).toMatchObject({
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    });
    expect(grokCall?.[0].cwd).toBe(sandboxRemoteWorkspace);
    expect(bridgeStop).toHaveBeenCalledTimes(1);
    expect(restoreSandboxWorkspace).toHaveBeenCalledTimes(1);
  });
});
