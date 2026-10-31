import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

// Test fakes for the sandbox workspace restore. The managed runtime tars the
// remote workspace to `<runtime root>/workspace-download.tar`, then reads it
// back with a size query (`wc -c < file`) followed by chunked
// `dd if=file bs=N skip=K count=1 | base64` reads. A fake sandbox runner can
// answer those reads with `fakeWorkspaceDownloadRead`.

const execFileAsync = promisify(execFile);

export const WORKSPACE_DOWNLOAD_ARCHIVE = "workspace-download.tar";

/** A valid, empty tar archive (two 512-byte zero blocks): an empty workspace. */
export const EMPTY_TARBALL = Buffer.alloc(1024);

/**
 * The stdout a shell would print for `script` when the remote workspace
 * archive holds `archive`. Only reads of the workspace download archive are
 * answered; any other command gets an empty stdout, so an unexpected read
 * fails instead of silently receiving a workspace archive.
 */
export function fakeWorkspaceDownloadRead(script: string, archive: Buffer = EMPTY_TARBALL): string {
  if (!script.includes(WORKSPACE_DOWNLOAD_ARCHIVE)) return "";
  if (/\bwc -c < /.test(script)) return `${archive.byteLength}\n`;
  const chunk = script.match(/\bdd if=.*? bs=(\d+) skip=(\d+) count=1\b.*\| base64/);
  if (!chunk) return "";
  const blockSize = Number(chunk[1]);
  const start = blockSize * Number(chunk[2]);
  return `${archive.subarray(start, start + blockSize).toString("base64")}\n`;
}

/** Tars the top-level entries of `dir`, as the remote workspace archive would. */
export async function tarDirectory(dir: string): Promise<Buffer> {
  const entries = (await readdir(dir)).sort();
  if (entries.length === 0) return EMPTY_TARBALL;
  const { stdout } = await execFileAsync("tar", ["-cf", "-", "-C", dir, "--", ...entries], {
    encoding: "buffer",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return stdout;
}
