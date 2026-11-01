import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/agent-runtime-images.yml"), "utf8");
const workflowEnv = workflow.match(/^env:\n((?: {2}.*\n|\n)*)/m)?.[1] ?? "";
const resolveStepIndex = workflow.indexOf("      - name: Resolve image registry\n");
const resolveRun = workflow.slice(resolveStepIndex).match(/^ {8}run: (.+)$/m)?.[1];

function resolveRegistry(t, owner) {
  assert.ok(resolveRun, "the Resolve image registry step must have a run command");
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-agent-runtime-images-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const githubEnv = path.join(root, "github-env");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", resolveRun], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_REPOSITORY_OWNER: owner, GITHUB_ENV: githubEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(githubEnv, "utf8");
}

test("agent runtime images resolve REGISTRY in a step before anything uses it", () => {
  assert.ok(resolveStepIndex >= 0, "the Resolve image registry step must exist");
  assert.ok(resolveRun, "the Resolve image registry step must have a run command");
  assert.ok(resolveStepIndex < workflow.indexOf("docker buildx bake"), "REGISTRY must be resolved before the bake step");
  assert.ok(resolveStepIndex < workflow.indexOf("${{ env.REGISTRY }}"), "REGISTRY must be resolved before any env.REGISTRY reference");
  // A workflow-level REGISTRY would be the unlowercased owner and would make the
  // step's $GITHUB_ENV value depend on env precedence.
  assert.doesNotMatch(workflowEnv, /^ {2}REGISTRY:/m);
  assert.doesNotMatch(workflow, /REGISTRY: .*github\.repository_owner/);
});

test("agent runtime images lowercase a mixed-case repository owner", (t) => {
  assert.equal(resolveRegistry(t, "MisterBusiness1"), "REGISTRY=ghcr.io/misterbusiness1\n");
  assert.equal(resolveRegistry(t, "PaperclipAI"), "REGISTRY=ghcr.io/paperclipai\n");
});

test("agent runtime images push and sign only under the resolved registry", () => {
  assert.doesNotMatch(workflow, /ghcr\.io\/paperclipai\/agent-runtime/);
  const cosignRefs = [...workflow.matchAll(/cosign sign --yes "([^"]+)"/g)].map((match) => match[1]);
  assert.equal(cosignRefs.length, 6);
  for (const ref of cosignRefs) {
    assert.match(ref, /^\$\{\{ env\.REGISTRY \}\}\/agent-runtime-[a-z]+@/);
  }
  assert.match(workflow, /--metadata-file=bake-metadata\.json\n[\s\S]*?env:\n\s+VERSION: \$\{\{ env\.VERSION \}\}\n\s+REGISTRY: \$\{\{ env\.REGISTRY \}\}/);
});
