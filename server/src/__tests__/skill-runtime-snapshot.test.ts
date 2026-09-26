import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishRuntimeSkillSnapshot, resolvePublishedRuntimeSkillSnapshot } from "../services/skill-runtime-snapshot.js";

const roots: string[] = [];
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-test-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("runtime skill snapshots", () => {
  it("publishes one complete snapshot for concurrent callers without rewriting readers' files", async () => {
    const dir = await root();
    const files = [{ path: "SKILL.md", content: "# Skill" }, { path: "scripts/check.sh", content: "echo ok" }];
    const snapshots = await Promise.all(Array.from({ length: 32 }, () => publishRuntimeSkillSnapshot(dir, files)));
    expect(new Set(snapshots).size).toBe(1);
    const first = snapshots[0]!;
    const before = await fs.stat(path.join(first, "SKILL.md"));
    await Promise.all(Array.from({ length: 32 }, async () => {
      await publishRuntimeSkillSnapshot(dir, files);
      expect(await fs.readFile(path.join(first, "SKILL.md"), "utf8")).toBe("# Skill");
      expect(await fs.readFile(path.join(first, "scripts/check.sh"), "utf8")).toBe("echo ok");
    }));
    expect((await fs.stat(path.join(first, "SKILL.md"))).ino).toBe(before.ino);
    expect(await resolvePublishedRuntimeSkillSnapshot(dir)).toBe(first);
    expect((await fs.readdir(path.join(dir, ".snapshots"))).sort()).toEqual([path.basename(first), "current"].sort());
  });

  it("preserves old readers and legacy files while publishing changed content without removed files", async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, "SKILL.md"), "legacy");
    const old = await publishRuntimeSkillSnapshot(dir, [{ path: "SKILL.md", content: "old" }, { path: "removed.md", content: "old extra" }]);
    const next = await publishRuntimeSkillSnapshot(dir, [{ path: "SKILL.md", content: "new" }]);
    expect(next).not.toBe(old);
    expect(await fs.readFile(path.join(old, "SKILL.md"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(dir, "SKILL.md"), "utf8")).toBe("legacy");
    await expect(fs.access(path.join(next, "removed.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await resolvePublishedRuntimeSkillSnapshot(dir)).toBe(next);
  });

  it("rejects invalid snapshots without disturbing the published one", async () => {
    const dir = await root();
    const old = await publishRuntimeSkillSnapshot(dir, [{ path: "SKILL.md", content: "good" }]);
    for (const files of [[], [{ path: "../escape", content: "x" }], [{ path: "/absolute", content: "x" }], [{ path: "SKILL.md", content: "a" }, { path: "SKILL.md", content: "b" }]]) {
      await expect(publishRuntimeSkillSnapshot(dir, files)).rejects.toThrow();
    }
    expect(await resolvePublishedRuntimeSkillSnapshot(dir)).toBe(old);
    expect(await fs.readFile(path.join(old, "SKILL.md"), "utf8")).toBe("good");
  });
});
