import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { skillFileBytes } from "./skill-snapshot.js";

export type RuntimeSkillFile = Pick<CompanySkillVersionFileInventoryEntry, "path" | "content" | "encoding" | "executable">;

// In-process dedupe of identical snapshot publications (keyed by snapshot dir).
const skillSnapshotFlights = new Map<string, Promise<void>>();

/**
 * Publish a complete, content-addressed skill snapshot at
 * `<root>/.snapshots/<digest>` and atomically repoint `<root>/.snapshots/current`
 * (read back through resolvePublishedRuntimeSkillSnapshot).
 *
 * Guarantees (fork, runtime skill isolation):
 * - a published snapshot directory is never rewritten in place, so a reader
 *   holding a returned path keeps a consistent file set; old snapshots and
 *   legacy files directly under `root` are left alone;
 * - files are staged in a private directory and published with one rename;
 *   concurrent publishers of the same content converge on one directory;
 * - paths are validated (no absolute/escaping/duplicate paths) and SKILL.md
 *   is required.
 * Upstream semantics (v2026.1005.0 version snapshots):
 * - bytes come from skillFileBytes (base64 or utf8) and the executable bit is
 *   kept; readOnly publishes 0o444/0o555 like upstream immutable versions;
 * - identical in-flight publications in this process share one staging pass;
 * - an existing snapshot whose bytes or executable bits do not match is
 *   replaced instead of failing forever.
 * Plain utf8, non-executable files hash exactly as the fork's original
 * publisher did, so snapshots already on disk are reused.
 */
export async function publishRuntimeSkillSnapshot(
  root: string,
  input: RuntimeSkillFile[],
  options: { readOnly?: boolean } = {},
): Promise<string> {
  const files: Array<{ path: string; content: string; encoding?: "base64"; executable?: true }> = input.map((file) => {
    const relative = file.path.replace(/\\/g, "/");
    const normalized = path.posix.normalize(relative);
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`Invalid runtime skill path: ${file.path}`);
    }
    return {
      path: normalized,
      content: file.content,
      ...(file.encoding === "base64" ? { encoding: "base64" as const } : {}),
      ...(file.executable ? { executable: true as const } : {}),
    };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error("Runtime skill snapshot requires SKILL.md");
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Duplicate runtime skill path");

  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const snapshotsRoot = path.join(root, ".snapshots");
  const snapshot = path.join(snapshotsRoot, digest);
  const fileMode = (file: (typeof files)[number]) => options.readOnly
    ? (file.executable ? 0o555 : 0o444)
    : (file.executable ? 0o755 : 0o644);

  async function matches() {
    async function listFiles(dir: string, prefix = ""): Promise<string[]> {
      const found: string[] = [];
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) found.push(...await listFiles(path.join(dir, entry.name), relative));
        else if (entry.isFile()) found.push(relative);
        else throw new Error("Runtime skill snapshots must contain regular files");
      }
      return found;
    }
    const existing = await listFiles(snapshot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing || JSON.stringify(existing.sort()) !== JSON.stringify(files.map((file) => file.path))) return false;
    for (const file of files) {
      const target = path.join(snapshot, file.path);
      const bytes = await fs.readFile(target).catch(() => null);
      if (!bytes?.equals(skillFileBytes(file))) return false;
      if (Boolean((await fs.stat(target)).mode & 0o111) !== Boolean(file.executable)) return false;
    }
    return true;
  }

  async function publish() {
    await fs.mkdir(snapshotsRoot, { recursive: true });
    if (await matches()) return;
    const staging = await fs.mkdtemp(path.join(snapshotsRoot, ".staging-"));
    try {
      for (const file of files) {
        const target = path.join(staging, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, skillFileBytes(file), { mode: fileMode(file) });
      }
      // Another process may have published the same snapshot while we staged it.
      if (await matches()) return;
      try {
        await fs.rename(staging, snapshot);
      } catch (error) {
        if (await matches()) return;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        // The directory under this digest does not hold the digest's content
        // (damaged): replace it rather than fail every later materialization.
        await fs.rm(snapshot, { recursive: true, force: true });
        await fs.rename(staging, snapshot);
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  let flight = skillSnapshotFlights.get(snapshot);
  if (!flight) {
    flight = publish().finally(() => skillSnapshotFlights.delete(snapshot));
    skillSnapshotFlights.set(snapshot, flight);
  }
  await flight;

  // Every caller repoints the discovery link itself (not the shared flight),
  // so the latest publication wins. Readers receive the immutable target.
  const pendingLink = path.join(snapshotsRoot, `.current-${randomUUID()}`);
  try {
    await fs.symlink(digest, pendingLink, "dir");
    await fs.rename(pendingLink, path.join(snapshotsRoot, "current"));
  } finally {
    await fs.rm(pendingLink, { force: true });
  }
  return snapshot;
}

export async function resolvePublishedRuntimeSkillSnapshot(root: string) {
  return fs.realpath(path.join(root, ".snapshots", "current")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return root; // Existing installations may have a legacy materialization.
    throw error;
  });
}
