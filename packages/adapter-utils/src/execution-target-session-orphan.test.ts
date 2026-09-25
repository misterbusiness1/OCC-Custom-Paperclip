import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { getProcessSessionRemoteSource } from "./execution-target.js";

const execFileAsync = promisify(execFile);

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("process session wrapper teardown", () => {
  const cleanupDirs: string[] = [];
  const livePids = new Set<number>();

  afterEach(async () => {
    for (const pid of livePids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    livePids.clear();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !isAlive(pid);
  }

  async function startWrapper(options: {
    command: string;
    args?: string[];
    streamOutput?: boolean;
    env?: Record<string, string>;
  }) {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-session-orphan-"));
    cleanupDirs.push(sessionDir);
    await mkdir(path.join(sessionDir, "stdin"), { recursive: true });
    await mkdir(path.join(sessionDir, "events"), { recursive: true });

    const wrapperPath = path.join(sessionDir, "wrapper.mjs");
    await writeFile(
      wrapperPath,
      getProcessSessionRemoteSource({ outputToStdout: options.streamOutput === true }),
      "utf8",
    );
    const config = {
      command: options.command,
      args: options.args ?? [],
      cwd: sessionDir,
      env: {},
    };
    const env: Record<string, string> = {
      ...process.env,
      ...(options.env ?? {}),
      PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
      PAPERCLIP_PROCESS_SESSION_COMMAND_B64: Buffer.from(JSON.stringify(config), "utf8").toString("base64"),
    };
    const wrapper = spawn(process.execPath, [wrapperPath], {
      cwd: sessionDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    livePids.add(wrapper.pid as number);
    return {
      sessionDir,
      wrapper,
      exited: new Promise<void>((resolve) => wrapper.on("close", () => resolve())),
    };
  }

  async function findChildPid(wrapperPid: number, timeoutMs = 5_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync("pgrep", ["-P", String(wrapperPid)]).catch(() => ({ stdout: "" }));
      const pid = Number.parseInt(stdout.trim().split("\n")[0] ?? "", 10);
      if (Number.isFinite(pid) && pid > 0) {
        livePids.add(pid);
        return pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Never observed a child of wrapper pid ${wrapperPid}`);
  }

  it("exits the event-file wrapper when its child closes", async () => {
    const { wrapper, exited } = await startWrapper({ command: "true" });

    await Promise.race([
      exited,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("wrapper never exited")), 10_000)),
    ]);

    expect(await waitForExit(wrapper.pid as number, 2_000)).toBe(true);
  }, 20_000);

  // Upstream v2026.831 (#12244/#12248) signals only the wrapper's direct child,
  // through the child handle (invariants I2/I3, enforced by
  // execution-target-stdin-race T11). These cases therefore use a child that
  // owns its stdio itself; a grandchild that inherits the pipes is outside the
  // wrapper's contract.
  const IGNORE_SIGTERM_CHILD = [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ];

  it("reaps the wrapper and child when the session directory disappears", async () => {
    const { sessionDir, wrapper } = await startWrapper({
      command: "sleep",
      args: ["300"],
    });
    const childPid = await findChildPid(wrapper.pid as number);

    await rm(sessionDir, { recursive: true, force: true });

    expect(await waitForExit(wrapper.pid as number, 10_000)).toBe(true);
    expect(await waitForExit(childPid, 10_000)).toBe(true);
  }, 30_000);

  it("reaps the wrapper and child on SIGTERM", async () => {
    const { wrapper } = await startWrapper({
      command: "sleep",
      args: ["300"],
    });
    const childPid = await findChildPid(wrapper.pid as number);

    process.kill(wrapper.pid as number, "SIGTERM");

    expect(await waitForExit(wrapper.pid as number, 10_000)).toBe(true);
    expect(await waitForExit(childPid, 10_000)).toBe(true);
  }, 30_000);

  it("escalates when the child ignores SIGTERM", async () => {
    const { wrapper } = await startWrapper({
      command: process.execPath,
      args: IGNORE_SIGTERM_CHILD,
      env: { PAPERCLIP_PROCESS_SESSION_TERMINATE_GRACE_MS: "500" },
    });
    const childPid = await findChildPid(wrapper.pid as number);
    // Give the child time to install its SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 300));

    process.kill(wrapper.pid as number, "SIGTERM");

    expect(await waitForExit(wrapper.pid as number, 10_000)).toBe(true);
    expect(await waitForExit(childPid, 10_000)).toBe(true);
  }, 30_000);

  it("still exits the streamed wrapper when its child closes", async () => {
    const { wrapper, exited } = await startWrapper({ command: "true", streamOutput: true });

    await Promise.race([
      exited,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("wrapper never exited")), 10_000)),
    ]);

    expect(await waitForExit(wrapper.pid as number, 2_000)).toBe(true);
  }, 20_000);
});
