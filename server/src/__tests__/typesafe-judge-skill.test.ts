import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listKimiSkills, syncKimiSkills } from "@paperclipai/adapter-kimi-local/server";
import { listCodexSkills } from "@paperclipai/adapter-codex-local/server";
import { typeSafeJudgeInputSchema } from "../services/typesafe-runtime-tool.js";

describe("shared TypeSafe operational skill", () => {
  const temporaryHomes: string[] = [];
  afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("keeps the shared pilot compatible with the runtime's three question types", async () => {
    const pilot = JSON.parse(await fs.readFile("skills/typesafe-judge/pilot.json", "utf8"));
    const input = typeSafeJudgeInputSchema.parse(pilot);
    expect(new Set(Object.values(input.questions).map((question) => question.type)))
      .toEqual(new Set(["choice", "noul", "score"]));
  });

  it("selects the shared skill for Codex's existing per-run injection", async () => {
    const key = "paperclipai/paperclip/typesafe-judge";
    const snapshot = await listCodexSkills({
      agentId: "agent-synthetic", companyId: "company-synthetic", adapterType: "codex_local",
      config: { paperclipSkillSync: { desiredSkills: [key] } },
    });
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toContain(key);
    expect(snapshot.entries.find((entry) => entry.key === key)?.state).toBe("configured");
  });

  it("discovers the optional skill and delivers its complete directory when selected", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-typesafe-skill-"));
    temporaryHomes.push(home);
    const key = "paperclipai/paperclip/typesafe-judge";
    const context = {
      agentId: "agent-synthetic", companyId: "company-synthetic", adapterType: "kimi_local",
      config: { env: { KIMI_CODE_HOME: home }, paperclipSkillSync: { desiredSkills: [key] } },
    };
    const unselected = await listKimiSkills({ ...context, config: { env: { KIMI_CODE_HOME: home } } });
    expect(unselected.entries.some((entry) => entry.key === key)).toBe(true);
    expect(unselected.desiredSkills).not.toContain(key);
    const selected = await syncKimiSkills(context, [key]);
    expect(selected.entries.find((entry) => entry.key === key)?.state).toBe("installed");
    for (const file of ["SKILL.md", "pilot.json"]) {
      expect(await fs.readFile(path.join(home, "skills/typesafe-judge", file), "utf8"))
        .toBe(await fs.readFile(path.join("skills/typesafe-judge", file), "utf8"));
    }
  });
});
