import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Exercise installed vendor code through its public API. Release the session's
// process before discarding it so cleanup must use the saved session rather
// than reuse a warm client that masks this bug.
const runtimePackages = [
  ["0.12.0", "../packages/adapter-utils/package.json"],
  ["0.13.1", "../server/package.json"],
];

const assignedKeys = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "ACP_ASSIGNED_SENTINEL"];
const ambientKey = "ACP_AMBIENT_SENTINEL";

// This fixture cannot contact a provider: it only answers local ACP lifecycle
// requests. Log only these synthetic test variables, never the full environment.
const fixtureSource = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [logPath, commandIdentity] = process.argv.slice(2);
function record(event) {
  appendFileSync(logPath, JSON.stringify({ ...event, pid: process.pid, commandIdentity }) + "\\n");
}
record({ type: "spawn", cwd: process.cwd(), env: Object.fromEntries(
  ${JSON.stringify([...assignedKeys, ambientKey])}.map((key) => [key, process.env[key] ?? null])
)});
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
    agentInfo: { name: "synthetic-cleanup-fixture", version: "1.0.0" },
  };
  else if (request.method === "session/new") {
    record({ type: "new", cwd: request.params.cwd });
    result = { sessionId: "synthetic-backend-session" };
  } else if (request.method === "session/close") {
    record({ type: "close", sessionId: request.params.sessionId });
    result = {};
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "Unsupported synthetic fixture method" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;

for (const [version, packageManifest] of runtimePackages) {
  const requirePackage = createRequire(new URL(packageManifest, import.meta.url));
  const installedPackage = requirePackage("acpx/package.json");
  assert.equal(installedPackage.version, version);
  const { createAcpRuntime, createRuntimeStore } = await import(
    pathToFileURL(requirePackage.resolve("acpx/runtime")).href
  );

  for (const agent of ["codex", "claude"]) {
    test(`ACPX ${version} preserves ${agent}'s assigned environment during backend cleanup`,
      { timeout: 15_000 }, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-cleanup-env-"));
        const previousAmbient = process.env[ambientKey];
        let runtime;
        let handle;
        t.after(async () => {
          try {
            if (runtime && handle) await runtime.close({ handle, reason: "fixture teardown" });
          } finally {
            if (previousAmbient === undefined) delete process.env[ambientKey];
            else process.env[ambientKey] = previousAmbient;
            await rm(root, { recursive: true, force: true });
          }
        });
        const sessionCwd = join(root, "assigned-workspace");
        const runtimeCwd = join(root, "different-runtime-workspace");
        await Promise.all([mkdir(sessionCwd), mkdir(runtimeCwd)]);
        const fixturePath = join(root, "agent.mjs");
        const logPath = join(root, "lifecycle.jsonl");
        await writeFile(fixturePath, fixtureSource);
        const command = (identity) => [process.execPath, fixturePath, logPath, identity]
          .map((value) => JSON.stringify(value.replaceAll("\\", "/"))).join(" ");
        let currentCommand = command("saved-session-command");
        const agentRegistry = {
          resolve(agentName) {
            assert.equal(agentName, agent);
            return currentCommand;
          },
          list: () => [agent],
        };
        const assignedEnv = {
          HOME: join(root, "assigned-home"),
          CODEX_HOME: join(root, "assigned-codex-home"),
          CLAUDE_CONFIG_DIR: join(root, "assigned-claude-home"),
          ACP_ASSIGNED_SENTINEL: `assigned-${version}-${agent}`,
        };
        process.env[ambientKey] = "must-never-reach-either-child";
        runtime = createAcpRuntime({
          cwd: runtimeCwd,
          sessionStore: createRuntimeStore({ stateDir: join(root, "state") }),
          agentRegistry,
          // The two qualified versions expose different host-env controls.
          ...(version === "0.12.0" ? { inheritProcessEnv: false } : { spawnEnvironment: () => ({}) }),
          permissionMode: "approve-all",
          nonInteractivePermissions: "deny",
          timeoutMs: 5_000,
        });
        handle = await runtime.ensureSession({
          sessionKey: `cleanup-${agent}`,
          agent,
          mode: "oneshot",
          cwd: sessionCwd,
          sessionOptions: { env: assignedEnv },
        });
        // 0.13 retains even an initialized oneshot process; normal close
        // releases it without deleting the backend session. The later discard
        // must therefore exercise the cold cleanup path in both versions.
        await runtime.close({ handle, reason: "release local process before backend cleanup" });

        // A changed registry/default cwd must not redirect cleanup away from
        // the backend recorded at session creation.
        currentCommand = command("replacement-registry-command");
        assert.equal(agentRegistry.resolve(agent), command("replacement-registry-command"),
          "the current registry must actually resolve to a different command before cleanup");
        await runtime.close({ handle, reason: "synthetic cleanup regression", discardPersistentState: true });

        const events = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
        const spawns = events.filter((event) => event.type === "spawn");
        assert.equal(spawns.length, 2, "oneshot cleanup must launch a distinct second ACP process");
        assert.notEqual(spawns[0].pid, spawns[1].pid);
        assert.equal(events.filter((event) => event.type === "new").length, 1);
        const closes = events.filter((event) => event.type === "close");
        assert.equal(closes.length, 1, "cleanup must actually send session/close");
        assert.equal(closes[0].sessionId, "synthetic-backend-session");
        assert.equal(closes[0].pid, spawns[1].pid);
        for (const [index, spawned] of spawns.entries()) {
          const phase = index === 0 ? "startup" : "cleanup";
          assert.equal(spawned.commandIdentity, "saved-session-command", `${phase} uses recorded command`);
          assert.equal(spawned.cwd, sessionCwd, `${phase} uses recorded cwd`);
          assert.equal(spawned.env[ambientKey], null, `${phase} excludes ambient environment`);
          for (const key of assignedKeys) {
            assert.equal(spawned.env[key], assignedEnv[key], `${phase} preserves assigned ${key}`);
          }
        }
      });
  }
}
