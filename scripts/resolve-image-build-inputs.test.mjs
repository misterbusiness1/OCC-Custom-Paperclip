import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveImageBuildInputs } from "./resolve-image-build-inputs.mjs";

const candidate = "fa821cc37d9df3b825dffa508c5f602c374f51a6";
const rollback = "6a0d31ea385556934f53bab3490d4c227bc6bbd4";

test("lowercases a mixed-case GitHub repository for every GHCR reference", () => {
  assert.deepEqual(resolveImageBuildInputs(candidate, rollback, "misterbusiness1/OCC-Custom-Paperclip"), {
    sourceSha: candidate,
    imageRepository: "ghcr.io/misterbusiness1/occ-custom-paperclip",
  });
});

test("uses the workflow SHA when no explicit immutable source is supplied", () => {
  assert.equal(resolveImageBuildInputs("", rollback, "Owner/Repo").sourceSha, rollback);
});

for (const sourceRef of ["main", "fa821cc", "F".repeat(40), `${candidate}x`]) {
  test(`rejects non-immutable source ref ${sourceRef}`, () => {
    assert.throws(() => resolveImageBuildInputs(sourceRef, rollback, "Owner/Repo"), /full lowercase 40-character commit SHA/);
  });
}

test("image workflows use resolved lowercase repositories and exact source provenance", () => {
  // Upstream v2026.1005.0 retired docker-cloud.yml (#13827).
  for (const relative of ["../.github/workflows/docker.yml"]) {
    const workflow = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.match(workflow, /ref: \$\{\{ steps\.image-inputs\.outputs\.source_sha \}\}/);
    assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ steps\.image-inputs\.outputs\.source_sha \}\}/);
    assert.match(workflow, /provenance: mode=max/);
    assert.doesNotMatch(workflow, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
  }
});
