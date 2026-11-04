import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeManagedWorkerEnv } from "./remote-execution-env.js";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";

const result = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  pid: 1,
  startedAt: "fixture",
};
afterEach(() => vi.unstubAllEnvs());
function fixture(managed = true) {
  vi.stubEnv("ONECLI_API_KEY", "synthetic-control-plane-admin");
  vi.stubEnv("DATABASE_URL", "synthetic-control-plane-database");
  vi.stubEnv("HOME", "/host/operator");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-assigned-subscription");
  const execute = vi.fn(async () => result);
  const target = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "kubernetes",
    environmentId: "environment",
    leaseId: "lease",
    remoteCwd: "/worker",
    runner: { execute },
    ...(managed
      ? {
          trustedRuntimeEnvKeys: [
            "ONECLI_AGENT_TOKEN",
            "ONECLI_API_HOST",
            "CLAUDE_CODE_OAUTH_TOKEN",
          ],
        }
      : {}),
  } as unknown as AdapterSandboxExecutionTarget;
  const env = {
    ONECLI_API_KEY: process.env.ONECLI_API_KEY!,
    DATABASE_URL: process.env.DATABASE_URL!,
    HOME: process.env.HOME!,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
    ONECLI_AGENT_TOKEN: "aoc_synthetic_assigned",
    ONECLI_API_HOST: "https://onecli.internal",
    PAPERCLIP_API_KEY: "synthetic-run-jwt",
  };
  return { execute, target, env };
}
describe("managed worker native environment boundary", () => {
  it("drops ambient parent admin and homes but retains explicit subscription and run credentials", () => {
    const f = fixture();
    expect(
      sanitizeManagedWorkerEnv(f.env, f.target.trustedRuntimeEnvKeys),
    ).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-assigned-subscription",
      ONECLI_AGENT_TOKEN: "aoc_synthetic_assigned",
      ONECLI_API_HOST: "https://onecli.internal",
      PAPERCLIP_API_KEY: "synthetic-run-jwt",
    });
  });
  it("keeps nonmanaged behavior unchanged", () => {
    const f = fixture(false);
    const actual = sanitizeManagedWorkerEnv(f.env, undefined);
    expect(actual.ONECLI_API_KEY).toBe(f.env.ONECLI_API_KEY);
    expect(actual.DATABASE_URL).toBe(f.env.DATABASE_URL);
    expect(actual.HOME).toBeUndefined();
  });
  for (const operation of [
    "codex",
    "claude",
    "opencode",
    "shell",
    "probe",
  ] as const) {
    it(`filters actual native ${operation} provider params.env before execute`, async () => {
      const f = fixture();
      const options = {
        cwd: "/worker",
        env: f.env,
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
      };
      if (operation === "shell")
        await runAdapterExecutionTargetShellCommand(
          "run",
          f.target,
          "true",
          options,
        );
      else if (operation === "probe")
        await ensureAdapterExecutionTargetCommandResolvable(
          "fixture",
          f.target,
          "/worker",
          f.env,
        );
      else
        await runAdapterExecutionTargetProcess(
          "run",
          f.target,
          operation,
          ["--version"],
          options,
        );
      expect(f.execute).toHaveBeenCalled();
      for (const [params] of f.execute.mock.calls as unknown as Array<
        [{ env?: Record<string, string> }]
      >) {
        expect(params.env).toMatchObject({
          ONECLI_AGENT_TOKEN: "aoc_synthetic_assigned",
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic-assigned-subscription",
          PAPERCLIP_API_KEY: "synthetic-run-jwt",
        });
        expect(params.env).not.toHaveProperty("ONECLI_API_KEY");
        expect(params.env).not.toHaveProperty("DATABASE_URL");
        expect(params.env).not.toHaveProperty("HOME");
      }
    });
  }
});
