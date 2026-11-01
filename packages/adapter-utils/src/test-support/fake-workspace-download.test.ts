import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createCommandManagedRuntimeClient } from "../command-managed-runtime.js";
import type { RunProcessResult } from "../server-utils.js";
import { EMPTY_TARBALL, fakeWorkspaceDownloadRead } from "./fake-workspace-download.js";

// Pins the fake to the shell commands the real command-managed client issues,
// so the adapter tests that rely on it break when those commands change.
function clientServing(archive?: Buffer) {
  return createCommandManagedRuntimeClient({
    commandCwd: "/remote",
    timeoutMs: 1_000,
    runner: {
      execute: async (input): Promise<RunProcessResult> => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: fakeWorkspaceDownloadRead((input.args ?? []).join(" "), archive),
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      }),
    },
  });
}

describe("fakeWorkspaceDownloadRead", () => {
  it("serves an empty workspace archive by default", async () => {
    const bytes = await clientServing().readFile("/remote/.paperclip-runtime/workspace-download.tar");
    expect(Buffer.isBuffer(bytes) && bytes.equals(EMPTY_TARBALL)).toBe(true);
  });

  it("serves a multi-chunk archive through the chunked dd reads", async () => {
    // Larger than one 3 MiB read chunk, so several `skip=` offsets are read.
    const archive = randomBytes(7 * 1024 * 1024 + 123);
    const bytes = await clientServing(archive).readFile("/remote/.paperclip-runtime/workspace-download.tar");
    expect(Buffer.isBuffer(bytes) && bytes.equals(archive)).toBe(true);
  });

  it("does not answer reads of any other remote file", async () => {
    await expect(clientServing().readFile("/remote/.paperclip-runtime/git-export.bundle"))
      .rejects.toThrow("Could not determine remote file size");
  });
});
