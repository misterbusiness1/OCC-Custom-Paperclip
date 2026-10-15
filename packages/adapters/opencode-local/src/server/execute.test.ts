import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { sessionCodec } from "./index.js";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it.each([
    { label: "fresh", previous: null, qualified: false, matching: true },
    { label: "legacy", previous: "legacy-session", qualified: false, matching: true },
    { label: "qualified", previous: "existing-session", qualified: true, matching: true },
    { label: "different workspace", previous: "other-session", qualified: true, matching: false },
  ])("reads the selected workspace with stale PWD ($label)", async ({ previous, qualified, matching }) => {
    const workspace = path.join(configHome, "selected workspace");
    const staleCwd = path.join(configHome, "server");
    await fs.mkdir(workspace);
    await fs.mkdir(staleCwd);
    await fs.writeFile(path.join(workspace, "workspace-marker.txt"), "selected project");
    await fs.writeFile(path.join(staleCwd, "workspace-marker.txt"), "server project");
    vi.stubEnv("PWD", staleCwd);
    const commandPath = path.join(configHome, "fake-opencode");
    // OpenCode 1.19.0 run.ts resolves PWD before cwd unless --dir is supplied.
    // Exercise that CLI boundary in a real child, without a model or network.
    await fs.writeFile(commandPath, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = path.resolve(process.env.PWD ?? process.cwd());
const index = args.indexOf("--dir");
const directory = index < 0 ? root : path.resolve(root, args[index + 1]);
const text = JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD,
  marker: fs.readFileSync(path.join(directory, "workspace-marker.txt"), "utf8"),
  session: args.includes("--session") ? args[args.indexOf("--session") + 1] : null,
  prompt: fs.readFileSync(0, "utf8") });
console.log(JSON.stringify({ type: "text", sessionID: "cwd-session", part: { text } }));
`, { mode: 0o755 });
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
      "@paperclipai/adapter-utils/execution-target",
    );
    runProcessMock.mockReset();
    runProcessMock.mockImplementationOnce(actual.runAdapterExecutionTargetProcess);
    const result = await execute({
      runId: "cwd-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: previous,
        sessionParams: previous ? { sessionId: previous, cwd: matching ? workspace : staleCwd, explicitDirectory: qualified } : null,
        sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: staleCwd, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {
        paperclipWorkspace: { cwd: workspace, source: "project_primary" },
        paperclipSessionHandoffMarkdown: "Prior work: retain the approved design.",
        paperclipWake: { reason: "issue_commented", issue: { id: "task-1", status: "in_progress" },
          executionContinuation: { version: 1, checkpoint: "Keep the verified test results." } },
      },
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.summary!);
    expect(observed).toMatchObject({
      cwd: workspace, pwd: staleCwd, marker: "selected project", session: qualified && matching ? previous : null,
    });
    expect(observed.prompt).toContain("Prior work: retain the approved design.");
    expect(observed.prompt).toContain("Keep the verified test results.");
    if (previous && !qualified) expect(observed.prompt).toContain(previous);
    expect(result.sessionParams).toMatchObject({ cwd: workspace, explicitDirectory: true });
    expect(sessionCodec.deserialize(sessionCodec.serialize(result.sessionParams!))).toMatchObject({
      cwd: workspace, explicitDirectory: true,
    });
  });

  it("does not qualify an old session when the fresh attempt emits no session ID", async () => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({ stdout: "" }));
    const result = await execute({
      runId: "no-session-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "legacy-session", sessionParams: { sessionId: "legacy-session", cwd: configHome },
        sessionDisplayId: "legacy-session", taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {},
      onLog: async () => {},
    });
    expect(runProcessMock.mock.calls[0]?.[3]).not.toContain("--session");
    expect(result).toMatchObject({ sessionId: null, sessionParams: null, clearSession: true });
  });

  it.each([undefined, false, "true", 1])("does not qualify legacy codec metadata (%s)", (marker) => {
    const params = { sessionId: "legacy-session", cwd: configHome, explicitDirectory: marker };
    expect(sessionCodec.deserialize(params)).not.toHaveProperty("explicitDirectory");
    expect(sessionCodec.serialize(params)).not.toHaveProperty("explicitDirectory");
  });

  it.each([
    "--dir", "--dir=/elsewhere", "--session", "--session=old", "-s", "-sold",
    "--continue", "--continue=true", "-c", "-csold", "-yc", "--fork", "--fork=true",
    "--attach", "--attach=http://elsewhere", "--no-dir", "--no-session",
  ])("rejects routing override %s before command or model launch", async (flag) => {
    runProcessMock.mockReset();
    await expect(execute({
      runId: "invalid-args-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "/not-installed-opencode", cwd: configHome, model: "openai/gpt-5", extraArgs: [flag] },
      context: {},
      onLog: async () => {},
    })).rejects.toThrow("OpenCode extraArgs/args must not override Paperclip workspace or session routing");
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        paperclipTaskMarkdown: directive,
        paperclipWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "Continue your Paperclip conversation");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  // Fork 7ed62ed3a: runtime skills are mounted through an isolated per-run
  // skills directory (OpenCode `skills.paths` in the per-run XDG config), never
  // written into the configured child HOME or the server's own HOME.
  it("mounts runtime skills through the per-run skills dir without touching any HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    let mountedSkillsPaths: string[] = [];
    let mountedSkillTarget: string | null = null;
    let childEnv: Record<string, string> = {};
    runProcessMock.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
      childEnv = { ...(options.env as Record<string, string>) };
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(childEnv.XDG_CONFIG_HOME!, "opencode", "opencode.json"), "utf8"),
      ) as { skills?: { paths?: string[] } };
      mountedSkillsPaths = runtimeConfig.skills?.paths ?? [];
      if (mountedSkillsPaths[0]) {
        mountedSkillTarget = await fs.realpath(path.join(mountedSkillsPaths[0], "paperclip"));
      }
      return probeResult({
        stdout: JSON.stringify({
          type: "text",
          sessionID: "session-configured-home",
          part: { text: "done" },
        }),
      });
    });

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(childEnv.HOME).toBe(configuredHome);
      expect(childEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
      expect(mountedSkillsPaths).toHaveLength(1);
      expect(mountedSkillTarget).toBe(await fs.realpath(skillSource));
      // The per-run skills dir is removed once the run ends.
      await expect(fs.lstat(mountedSkillsPaths[0]!)).rejects.toThrow();
      await expect(fs.lstat(path.join(configuredHome, ".claude", "skills"))).rejects.toThrow();
      await expect(fs.lstat(path.join(processHome, ".claude", "skills"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes an OpenRouter key and complete model to OpenCode without logging the key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-openrouter",
        part: { text: "done" },
      }),
    }));
    const logs: string[] = [];
    const metadata: unknown[] = [];

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model,
          extraArgs: ["--agent", "build", "--variant", "high", "-mcustom/model"],
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.model).toBe(model);
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect(executionCall[3]).toEqual(expect.arrayContaining(["--agent", "build", "--variant", "high", "-mcustom/model"]));
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});
