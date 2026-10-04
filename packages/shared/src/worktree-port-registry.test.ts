import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  withWorktreePortRegistryLock,
  withWorktreePortRegistryLockSync,
} from "./worktree-port-registry.js";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-port-registry-lock-"));
  temporaryRoots.push(root);
  return root;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("worktree port registry lock", () => {
  it("does not reclaim a stale lock while its fallback ownership probe responds", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const token = "responsive-stale-owner";
    const probeControl = new Int32Array(new SharedArrayBuffer(8));
    const probe = new Worker(`
      const net = require("node:net");
      const { parentPort, workerData } = require("node:worker_threads");
      const control = new Int32Array(workerData.control);
      const server = net.createServer((socket) => {
        socket.setEncoding("utf8");
        socket.once("data", (candidate) => {
          socket.end(candidate === workerData.token ? "owned" : "denied");
        });
      });
      parentPort.once("message", () => server.close(() => process.exit(0)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        Atomics.store(control, 1, address.port);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
      });
    `, {
      eval: true,
      execArgv: [],
      workerData: { control: probeControl.buffer, token },
    });
    Atomics.wait(probeControl, 0, 0, 2_000);
    const probePort = Atomics.load(probeControl, 1);
    if (Atomics.load(probeControl, 0) !== 1 || probePort <= 0) {
      void probe.terminate();
      throw new Error("Failed to start fallback ownership probe fixture");
    }

    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.backup.json"),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processIdentity: "unavailable-process-identity",
        probePort,
        token,
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
    let secondEntered = false;

    expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeGreaterThan(5_000);

    const second = withWorktreePortRegistryLock(homeDir, async () => {
      secondEntered = true;
    });
    await delay(100);

    expect(secondEntered).toBe(false);
    probe.postMessage("close");
    await probe.terminate();
    await second;
    expect(secondEntered).toBe(true);
  }, 10_000);

  it("refreshes the lease throughout an async critical section", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");

    await withWorktreePortRegistryLock(homeDir, async () => {
      await delay(5_250);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(2_000);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  }, 10_000);

  it("reclaims an old lock after its owner process exits", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        probePort: 1,
        token: "dead-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims an old lock when its pid belongs to a different process", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processIdentity: "reused-pid-owner",
        probePort: 1,
        token: "abandoned-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refreshes the lease while a synchronous critical section blocks the main thread", () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const blocker = new Int32Array(new SharedArrayBuffer(4));

    withWorktreePortRegistryLockSync(homeDir, () => {
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
      Atomics.wait(blocker, 0, 0, 1_500);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(1_250);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
