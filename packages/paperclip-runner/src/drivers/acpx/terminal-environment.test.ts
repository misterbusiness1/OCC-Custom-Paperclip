import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import { afterEach, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const fixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-terminal-env-agent.mjs");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("forwards the current allowlisted terminal environment in fresh and warm ACP sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runner-acpx-terminal-env-"));
  tempRoots.push(root);
  const agentCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`;
  let terminalEnvironment: Record<string, string> = { PAPERCLIP_RUN_ID: "run-one" };
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: createRuntimeStore({ stateDir: path.join(root, "state") }),
    agentRegistry: createAgentRegistry({ overrides: { terminal_env_fixture: agentCommand } }),
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    terminalEnvironment: () => ({ ...terminalEnvironment }),
    verbose: true,
    timeoutMs: 10_000,
  });

  const handle = await runtime.ensureSession({
    sessionKey: "terminal-env-session",
    agent: "terminal_env_fixture",
    mode: "persistent",
    cwd: root,
    sessionOptions: { env: {} },
  });
  const runTurn = async (requestId: string, text = "Print PAPERCLIP_RUN_ID from a terminal."): Promise<string> => {
    let output = "";
    for await (const event of runtime.runTurn({
      handle,
      text,
      mode: "prompt",
      sessionMode: "persistent",
      requestId,
    })) {
      if (event.type === "text_delta") output += event.text;
    }
    return output;
  };

  try {
    expect(await runTurn("terminal-env-run-one")).toBe("run-one");
    terminalEnvironment = { PAPERCLIP_RUN_ID: "run-two" };
    expect(await runTurn("terminal-env-run-two")).toBe("run-two");
    // ACPX 0.21.1: an env var the agent requests in terminal/create wins over
    // the host's, except PAPERCLIP_* names, where the host run identity wins.
    terminalEnvironment = { PAPERCLIP_RUN_ID: "run-three", TERMINAL_ENV_PROBE: "host" };
    expect(await runTurn("terminal-env-run-three", "Check env precedence in a terminal.")).toBe("run-three agent");
  } finally {
    await runtime.close({ handle, discardPersistentState: true });
  }
  // ACPX 0.21.1 snapshots the host process table around agent and terminal
  // lifecycle steps (about 0.8 s each on a busy host).
}, 30_000);
