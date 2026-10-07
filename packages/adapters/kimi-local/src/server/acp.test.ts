import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const engine = vi.hoisted(() => ({ received: [] as AdapterExecutionContext[] }));
vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => ({
  createAcpxEngineExecutor: () => async (ctx: AdapterExecutionContext) => {
    engine.received.push(ctx);
    return { exitCode: 0, signal: null, timedOut: false };
  },
}));

import {
  buildKimiAcpConfig,
  createKimiAcpExecutor,
  nodeVersionMeetsKimiAcpMinimum,
  prepareKimiRunContext,
  prepareKimiRuntimeMcpContext,
  resolveKimiExecutionEngine,
} from "./acp.js";

describe("createKimiAcpExecutor", () => {
  it("hands the shared engine a task run with a cleared session and the run's runtime-tools server", async () => {
    engine.received.length = 0;
    await createKimiAcpExecutor()({
      config: {},
      context: {},
      runtime: { sessionId: "saved-session", sessionParams: { acpSessionId: "saved-session" } },
      runtimeTools: { mcpEndpoint: "https://paperclip.test/mcp/runtime-tools", bearerToken: "run-token-6" },
    } as unknown as AdapterExecutionContext);

    const received = engine.received[0]!;
    expect(received.config.agent).toBe("kimi");
    expect(received.runtime.sessionId).toBeNull();
    expect(received.runtimeMcp?.getServers()).toEqual([
      { name: "Paperclip connections", url: "https://paperclip.test/mcp/runtime-tools", token: "run-token-6", connectionId: "paperclip-runtime-tools" },
    ]);
    // The environment delivery stays available to the agent's shell.
    expect(received.runtimeTools?.bearerToken).toBe("run-token-6");
  });
});

describe("prepareKimiRunContext", () => {
  it("clears a saved ACP session for a task heartbeat", () => {
    const ctx = {
      context: { conversationMode: false },
      runtime: {
        sessionId: "session-from-an-earlier-run",
        sessionParams: { sessionId: "session-from-an-earlier-run", cwd: "/work" },
      },
    } as unknown as AdapterExecutionContext;

    const prepared = prepareKimiRunContext(ctx);

    expect(prepared.runtime?.sessionId).toBeNull();
    expect(prepared.runtime?.sessionParams).toBeNull();
    expect(ctx.runtime?.sessionId).toBe("session-from-an-earlier-run");
  });

  it("preserves the ACP session for an external conversation", () => {
    const ctx = {
      context: { conversationMode: true },
      runtime: {
        sessionId: "conversation-session",
        sessionParams: { sessionId: "conversation-session" },
      },
    } as unknown as AdapterExecutionContext;

    expect(prepareKimiRunContext(ctx)).toBe(ctx);
  });
});

describe("prepareKimiRuntimeMcpContext", () => {
  it("adds the run's runtime-tools server alongside the servers already registered", () => {
    const ctx = {
      context: {},
      runtimeTools: {
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        bearerToken: "run-token-1",
      },
      runtimeMcp: {
        getServers: () => [
          { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", token: "project-token", connectionId: "paperclip-project-tools" },
        ],
      },
    } as unknown as AdapterExecutionContext;

    const prepared = prepareKimiRuntimeMcpContext(ctx);

    expect(prepared.runtimeMcp?.getServers()).toEqual([
      { name: "Paperclip connections", url: "https://paperclip.test/mcp/runtime-tools", token: "run-token-1", connectionId: "paperclip-runtime-tools" },
      { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", token: "project-token", connectionId: "paperclip-project-tools" },
    ]);
    // The environment delivery stays on the context: the agent's shell still
    // gets PAPERCLIP_RUNTIME_TOOLS_* for this run.
    expect(prepared.runtimeTools).toBe(ctx.runtimeTools);
    // The input context is never mutated.
    expect(ctx.runtimeMcp?.getServers()).toHaveLength(1);
  });

  it("replaces a configured server carrying the reserved connectionId instead of duplicating it", () => {
    const ctx = {
      context: {},
      runtimeTools: {
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        bearerToken: "run-token-2",
      },
      runtimeMcp: {
        getServers: () => [
          { name: "Operator override", url: "https://override.test/mcp", token: "stale-token", connectionId: "paperclip-runtime-tools" },
          { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", token: "project-token", connectionId: "paperclip-project-tools" },
        ],
      },
    } as unknown as AdapterExecutionContext;

    const servers = prepareKimiRuntimeMcpContext(ctx).runtimeMcp?.getServers() ?? [];

    expect(servers.filter((server) => server.connectionId === "paperclip-runtime-tools")).toHaveLength(1);
    expect(servers[0]).toEqual({
      name: "Paperclip connections",
      url: "https://paperclip.test/mcp/runtime-tools",
      token: "run-token-2",
      connectionId: "paperclip-runtime-tools",
    });
  });

  it("leaves runtimeMcp exactly as it was when the run has no runtime-tools capability", () => {
    const withoutMcp = { context: {}, runtimeTools: undefined } as unknown as AdapterExecutionContext;
    expect(prepareKimiRuntimeMcpContext(withoutMcp).runtimeMcp).toBeUndefined();

    const runtimeMcp = {
      getServers: () => [
        { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", token: "project-token", connectionId: "paperclip-project-tools" },
      ],
    };
    const withMcp = { context: {}, runtimeTools: undefined, runtimeMcp } as unknown as AdapterExecutionContext;
    expect(prepareKimiRuntimeMcpContext(withMcp).runtimeMcp).toBe(runtimeMcp);
  });

  it("leaves the context unchanged for a remote execution target", () => {
    const ctx = {
      context: {},
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
      runtimeTools: {
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        bearerToken: "run-token-3",
      },
      runtimeMcp: {
        getServers: () => [
          { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", token: "project-token", connectionId: "paperclip-project-tools" },
        ],
      },
    } as unknown as AdapterExecutionContext;

    expect(prepareKimiRuntimeMcpContext(ctx)).toBe(ctx);
  });
  it("registers the bearer only on a run that starts a fresh session", () => {
    const base = {
      runtime: { sessionId: "saved-session", sessionParams: { acpSessionId: "saved-session" } },
      runtimeTools: {
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        bearerToken: "run-token-5",
      },
    };
    const taskRun = prepareKimiRuntimeMcpContext(
      prepareKimiRunContext({ ...base, context: {} } as unknown as AdapterExecutionContext),
    );
    const conversationTurn = prepareKimiRuntimeMcpContext(
      prepareKimiRunContext({ ...base, context: { conversationMode: true } } as unknown as AdapterExecutionContext),
    );

    // An ACP session keeps the MCP registrations it was created with. A task
    // run registers its bearer and never resumes; a conversation turn resumes
    // and never registers one.
    expect(taskRun.runtime.sessionId).toBeNull();
    expect(taskRun.runtime.sessionParams).toBeNull();
    expect(taskRun.runtimeMcp?.getServers().map((server) => server.connectionId)).toEqual(["paperclip-runtime-tools"]);
    expect(conversationTurn.runtime.sessionId).toBe("saved-session");
    expect(conversationTurn.runtimeMcp).toBeUndefined();
  });

  it("keeps a conversation turn on the environment delivery so its session can resume", () => {
    const ctx = {
      context: { conversationMode: true },
      runtimeTools: {
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        bearerToken: "run-token-4",
      },
      runtimeMcp: {
        getServers: () => [
          { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", token: "project-token", connectionId: "paperclip-project-tools" },
        ],
      },
    } as unknown as AdapterExecutionContext;

    const prepared = prepareKimiRuntimeMcpContext(ctx);

    expect(prepared).toBe(ctx);
    expect(prepared.runtimeTools).toBe(ctx.runtimeTools);
  });
});

describe("resolveKimiExecutionEngine", () => {
  it("defaults to ACP (non-explicit) when engine is unset", () => {
    expect(resolveKimiExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
  });

  it("honors an explicit engine=acp", () => {
    expect(resolveKimiExecutionEngine({ engine: "acp" })).toEqual({ engine: "acp", explicit: true });
  });

  it("honors an explicit engine=cli", () => {
    expect(resolveKimiExecutionEngine({ engine: "CLI" })).toEqual({ engine: "cli", explicit: true });
  });

  it("treats unknown values as the non-explicit ACP default", () => {
    expect(resolveKimiExecutionEngine({ engine: "nonsense" })).toEqual({ engine: "acp", explicit: false });
  });
});

describe("buildKimiAcpConfig", () => {
  it("targets the kimi agent and derives the `kimi acp` server command from `command`", () => {
    const out = buildKimiAcpConfig({ command: "kimi", cwd: "/work" });
    expect(out.agent).toBe("kimi");
    expect(out.agentCommand).toBe("kimi acp");
    expect(out.mode).toBe("persistent");
    expect(out.cwd).toBe("/work");
  });

  it("prefers an explicit agentCommand override", () => {
    const out = buildKimiAcpConfig({ command: "kimi", agentCommand: "/opt/kimi acp --foo" });
    expect(out.agentCommand).toBe("/opt/kimi acp --foo");
  });

  it("drops the model when it equals the default so ACP uses the agent default", () => {
    const out = buildKimiAcpConfig({ model: "kimi-code/kimi-for-coding" });
    expect("model" in out).toBe(false);
  });

  it("keeps a non-default model", () => {
    const out = buildKimiAcpConfig({ model: "kimi-code/k3" });
    expect(out.model).toBe("kimi-code/k3");
  });

  it("strips CLI-lane effort so ACP is not sent the unsupported `effort` control", () => {
    const out = buildKimiAcpConfig({ model: "kimi-code/k3", effort: "high", thinkingEffort: "high" });
    expect("effort" in out).toBe(false);
    expect("thinkingEffort" in out).toBe(false);
  });

  it("opts into the shared engine's verbose-backend handling", () => {
    const out = buildKimiAcpConfig({ command: "kimi" });
    expect(out.summaryStrategy).toBe("lastOutputSegment");
    expect(out.coalescePlaceholderToolUpdates).toBe(true);
  });
});

describe("nodeVersionMeetsKimiAcpMinimum", () => {
  it("accepts Node >= 20", () => {
    expect(nodeVersionMeetsKimiAcpMinimum("v22.0.0")).toBe(true);
    expect(nodeVersionMeetsKimiAcpMinimum("v20.0.0")).toBe(true);
  });
  it("rejects Node < 20", () => {
    expect(nodeVersionMeetsKimiAcpMinimum("v18.19.0")).toBe(false);
  });
});
