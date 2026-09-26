import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type RuntimeSkillFile = { path: string; content: string };

/** Publish complete, content-addressed directories; never rewrite an in-use snapshot. */
export async function publishRuntimeSkillSnapshot(root: string, input: RuntimeSkillFile[]) {
  const files = input.map((file) => {
    const relative = file.path.replace(/\\/g, "/");
    const normalized = path.posix.normalize(relative);
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`Invalid runtime skill path: ${file.path}`);
    }
    return { path: normalized, content: file.content };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error("Runtime skill snapshot requires SKILL.md");
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Duplicate runtime skill path");

  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const snapshotsRoot = path.join(root, ".snapshots");
  const snapshot = path.join(snapshotsRoot, digest);
  await fs.mkdir(snapshotsRoot, { recursive: true });

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
      if (await fs.readFile(path.join(snapshot, file.path), "utf8").catch(() => null) !== file.content) return false;
    }
    return true;
  }

  if (!await matches()) {
    const staging = await fs.mkdtemp(path.join(snapshotsRoot, ".staging-"));
    try {
      for (const file of files) {
        const target = path.join(staging, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content, "utf8");
      }
      try {
        await fs.rename(staging, snapshot);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !await matches()) throw error;
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  // Readers receive the immutable target, not this movable discovery link.
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
