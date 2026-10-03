import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRunOwnedPaperclipEnv, runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("run-owned Paperclip process environment", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("repoints shared local children and nested package-script children without touching hostile sentinels", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-scratch-"));
    const production = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-production-"));
    roots.push(scratch, production);
    const productionEnv = path.join(production, ".env");
    const productionConfig = path.join(production, "config.json");
    await fs.writeFile(productionEnv, "env-sentinel\n");
    await fs.writeFile(productionConfig, "config-sentinel\n");
    const hostile = {
      PATH: process.env.PATH ?? "",
      PAPERCLIP_RUN_SCRATCH_DIR: scratch,
      PAPERCLIP_HOME: production,
      PAPERCLIP_CONFIG: productionConfig,
      PAPERCLIP_CONTEXT: path.join(production, "context.json"),
      PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREES_DIR: production,
      PAPERCLIP_WORKTREE_NAME: "default",
    };

    const direct = await runChildProcess("shared-boundary", process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      cwd: production,
      env: hostile,
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });
    const nested = await runChildProcess("shared-boundary", process.execPath, ["-e", "process.stdout.write(require('node:child_process').execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env))']))"], {
      cwd: production,
      env: hostile,
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });

    for (const observed of [JSON.parse(direct.stdout), JSON.parse(nested.stdout)] as Record<string, string>[]) {
      expect(observed.PAPERCLIP_HOME).toBe(path.join(scratch, "child-paperclip-instance", "home"));
      expect(observed.PAPERCLIP_CONFIG).toBe(path.join(scratch, "child-paperclip-instance", "config.json"));
      expect(observed.PAPERCLIP_CONTEXT).toBe(path.join(scratch, "child-paperclip-instance", "context.json"));
      expect(observed.PAPERCLIP_INSTANCE_ID).toMatch(/^run-/);
      expect(observed.PAPERCLIP_IN_WORKTREE).toBeUndefined();
      expect(observed.PAPERCLIP_WORKTREES_DIR).toBeUndefined();
      expect(observed.PAPERCLIP_WORKTREE_NAME).toBeUndefined();
    }
    expect(await fs.readFile(productionEnv, "utf8")).toBe("env-sentinel\n");
    expect(await fs.readFile(productionConfig, "utf8")).toBe("config-sentinel\n");
  });

  it("prepares the ACP session env at the same run-owned boundary", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-scratch-"));
    roots.push(scratch);
    const env = await prepareRunOwnedPaperclipEnv({
      PAPERCLIP_RUN_SCRATCH_DIR: scratch,
      PAPERCLIP_HOME: "/paperclip/instances/default",
      PAPERCLIP_CONFIG: "/paperclip/instances/default/config.json",
      PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_CONTEXT: "/paperclip/instances/default/context.json",
      PAPERCLIP_IN_WORKTREE: "true",
    }, "acp-run");
    expect(env.PAPERCLIP_HOME).toBe(path.join(scratch, "child-paperclip-instance", "home"));
    expect(env.PAPERCLIP_IN_WORKTREE).toBeUndefined();
  });

  it("starts real local and nested children with a complete oversized wake", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-large-wake-"));
    roots.push(scratch);
    const wake = JSON.stringify({ issue: { id: "owned-task" }, executionContinuation: { messages: [{ body: "x".repeat(137_538) }] } });
    if (process.platform === "linux") {
      const oldBoundary = spawnSync(process.execPath, ["-e", ""], { env: { PAPERCLIP_WAKE_PAYLOAD_JSON: wake } });
      expect((oldBoundary.error as NodeJS.ErrnoException | undefined)?.code).toBe("E2BIG");
    }
    const childCode = "const fs=require('node:fs');const c=require('node:crypto');const p=process.env.PAPERCLIP_WAKE_PAYLOAD_FILE;process.stdout.write(JSON.stringify({sha:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),reference:JSON.parse(process.env.PAPERCLIP_WAKE_PAYLOAD_JSON),entryBytes:Buffer.byteLength(process.env.PAPERCLIP_WAKE_PAYLOAD_JSON)}));";
    const result = await runChildProcess("large-wake", process.execPath, ["-e", "process.stdout.write(require('node:child_process').execFileSync(process.execPath,['-e'," + JSON.stringify(childCode) + "]))"], {
      cwd: scratch,
      env: { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_WAKE_PAYLOAD_JSON: wake },
      timeoutSec: 10, graceSec: 1, onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.sha).toBe(createHash("sha256").update(wake).digest("hex"));
    expect(observed.entryBytes).toBeLessThan(64 * 1024);
    expect(observed.reference.fallbackFetchNeeded).toBe(true);
    expect(observed.reference.payloadFile.startsWith(path.join(scratch, "child-paperclip-instance") + path.sep)).toBe(true);
    expect((await fs.stat(observed.reference.payloadFile)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(observed.reference.payloadFile))).mode & 0o777).toBe(0o700);
  });

  it("uses UTF-8 bytes and preserves old and new payloads for repeated and separate runs", async () => {
    const firstScratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wake-first-"));
    const secondScratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wake-second-"));
    roots.push(firstScratch, secondScratch);
    const wake = JSON.stringify({ message: "\uD83D\uDE80".repeat(20_000) });
    expect(wake.length).toBeLessThan(64 * 1024);
    const first = await prepareRunOwnedPaperclipEnv({ PAPERCLIP_RUN_SCRATCH_DIR: firstScratch, PAPERCLIP_WAKE_PAYLOAD_JSON: wake }, "first");
    const updatedWake = JSON.stringify({ message: "y".repeat(140_000) });
    const repeated = await prepareRunOwnedPaperclipEnv({ PAPERCLIP_RUN_SCRATCH_DIR: firstScratch, PAPERCLIP_WAKE_PAYLOAD_JSON: updatedWake, PAPERCLIP_WAKE_PAYLOAD_FILE: "/foreign/stale.json" }, "first");
    const second = await prepareRunOwnedPaperclipEnv({ PAPERCLIP_RUN_SCRATCH_DIR: secondScratch, PAPERCLIP_WAKE_PAYLOAD_JSON: wake }, "second");
    expect(await fs.readFile(first.PAPERCLIP_WAKE_PAYLOAD_FILE!, "utf8")).toBe(wake);
    expect(await fs.readFile(repeated.PAPERCLIP_WAKE_PAYLOAD_FILE!, "utf8")).toBe(updatedWake);
    expect(await fs.readFile(second.PAPERCLIP_WAKE_PAYLOAD_FILE!, "utf8")).toBe(wake);
    expect(new Set([first.PAPERCLIP_WAKE_PAYLOAD_FILE, repeated.PAPERCLIP_WAKE_PAYLOAD_FILE, second.PAPERCLIP_WAKE_PAYLOAD_FILE]).size).toBe(3);
    const reprepared = await prepareRunOwnedPaperclipEnv(first, "first");
    expect(reprepared.PAPERCLIP_WAKE_PAYLOAD_FILE).toBe(first.PAPERCLIP_WAKE_PAYLOAD_FILE);
    expect(reprepared.PAPERCLIP_WAKE_PAYLOAD_JSON).toBe(first.PAPERCLIP_WAKE_PAYLOAD_JSON);
  });

  it("keeps a small wake inline", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-small-wake-"));
    roots.push(scratch);
    const wake = JSON.stringify({ message: "small" });
    const env = await prepareRunOwnedPaperclipEnv({ PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_WAKE_PAYLOAD_JSON: wake }, "small");
    expect(env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBe(wake);
    expect(env.PAPERCLIP_WAKE_PAYLOAD_FILE).toBeUndefined();
  });
});
