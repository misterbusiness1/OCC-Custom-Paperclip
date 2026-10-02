import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-terminal-env-agent.mjs");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("uses the current terminal environment for fresh and warm ACP sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-terminal-env-"));
  tempRoots.push(root);
  const agentCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`;
  const stderrChunks: string[] = [];
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: createRuntimeStore({ stateDir: path.join(root, "state") }),
    agentRegistry: createAgentRegistry({ overrides: { terminal_env_fixture: agentCommand } }),
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    terminalEnv: { PAPERCLIP_RUN_ID: "run-one" },
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
  const runTurn = async (requestId: string): Promise<string> => {
    let output = "";
    const seen: unknown[] = [];
    for await (const event of runtime.runTurn({ handle, text: "Read the run id from a terminal.", mode: "prompt", requestId })) {
      seen.push(event);
      if (event.type === "text_delta") output += event.text;
    }
    if (!output) console.error(JSON.stringify({ seen, stderr: stderrChunks.join("") }));
    return output;
  };

  try {
    expect(await runTurn("terminal-env-run-one")).toBe("run-one");
    await runtime.setTerminalEnv?.({ env: { PAPERCLIP_RUN_ID: "run-two" } });
    expect(await runTurn("terminal-env-run-two")).toBe("run-two");
  } finally {
    await runtime.close({ handle, reason: "terminal environment smoke complete", discardPersistentState: true });
  }
});
