import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexExecutionBilling } from "../../../packages/adapters/codex-local/src/server/execute.js";
import { resolveClaudeExecutionBilling } from "../../../packages/adapters/claude-local/src/server/execute.js";
import { resolveOpenCodeBiller } from "../../../packages/adapters/opencode-local/src/server/execute.js";
import { sanitizeManagedWorkerEnv } from "../../../packages/adapter-utils/src/remote-execution-env.js";

const target = (keys: string[] | null = []) =>
  ({
    kind: "remote",
    transport: "sandbox",
    remoteCwd: "/worker",
    ...(keys !== null ? { trustedRuntimeEnvKeys: keys } : {}),
  }) as never;
afterEach(() => vi.unstubAllEnvs());
describe("managed native adapter accounting", () => {
  it("Codex subscription metadata ignores the parent API credential removed from the worker env", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-parent-api");
    const env = { OPENAI_API_KEY: "synthetic-parent-api" };
    expect(sanitizeManagedWorkerEnv(env, [])).toEqual({});
    expect(resolveCodexExecutionBilling(env, target())).toEqual({
      billingType: "subscription",
      biller: "chatgpt",
    });
  });
  it("Claude subscription metadata ignores parent API and Bedrock selectors removed from worker env", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-parent-api");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    const env = {
      ANTHROPIC_API_KEY: "synthetic-parent-api",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-assigned-subscription",
    };
    expect(sanitizeManagedWorkerEnv(env, ["CLAUDE_CODE_OAUTH_TOKEN"])).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-assigned-subscription",
    });
    expect(
      resolveClaudeExecutionBilling(env, target(["CLAUDE_CODE_OAUTH_TOKEN"])),
    ).toEqual({ billingType: "subscription", biller: "anthropic" });
  });
  for (const adapter of ["codex", "opencode"])
    it(`${adapter} biller ignores inherited OpenRouter routing removed from worker env`, () => {
      vi.stubEnv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1");
      const env = { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" };
      expect(sanitizeManagedWorkerEnv(env, [])).toEqual({});
      expect(
        adapter === "codex"
          ? resolveCodexExecutionBilling(env, target()).biller
          : resolveOpenCodeBiller(env, "openai", target()),
      ).toBe(adapter === "codex" ? "chatgpt" : "openai");
    });
  it("preserves explicitly bound API authentication even when equal to a parent value", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-bound-api");
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-bound-api");
    expect(
      resolveCodexExecutionBilling(
        { OPENAI_API_KEY: "synthetic-bound-api" },
        target(["OPENAI_API_KEY"]),
      ),
    ).toEqual({ billingType: "api", biller: "openai" });
    expect(
      resolveClaudeExecutionBilling(
        { ANTHROPIC_API_KEY: "synthetic-bound-api" },
        target(["ANTHROPIC_API_KEY"]),
      ),
    ).toEqual({ billingType: "api", biller: "anthropic" });
  });
  it("preserves explicitly bound Bedrock and OpenRouter metadata", () => {
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1");
    expect(
      resolveClaudeExecutionBilling(
        { CLAUDE_CODE_USE_BEDROCK: "1" },
        target(["CLAUDE_CODE_USE_BEDROCK"]),
      ),
    ).toEqual({ billingType: "metered_api", biller: "aws_bedrock" });
    expect(
      resolveOpenCodeBiller(
        { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" },
        "openai",
        target(["OPENAI_BASE_URL"]),
      ),
    ).toBe("openrouter");
  });
  it("leaves existing nonmanaged adapter classification unchanged", () => {
    const env = {
      OPENAI_API_KEY: "synthetic-api",
      ANTHROPIC_API_KEY: "synthetic-api",
      CLAUDE_CODE_USE_BEDROCK: "1",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect(resolveCodexExecutionBilling(env, target(null))).toEqual({
      billingType: "api",
      biller: "openrouter",
    });
    expect(resolveClaudeExecutionBilling(env, target(null))).toEqual({
      billingType: "metered_api",
      biller: "aws_bedrock",
    });
    expect(resolveOpenCodeBiller(env, "openai", target(null))).toBe(
      "openrouter",
    );
  });
});
