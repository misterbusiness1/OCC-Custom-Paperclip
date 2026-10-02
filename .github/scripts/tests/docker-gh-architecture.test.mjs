import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../workflows/docker.yml", import.meta.url), "utf8");

test("GitHub CLI pin covers every supported Docker architecture", () => {
  assert.match(workflow, /platform: linux\/amd64[\s\S]*?arch: amd64/);
  assert.match(workflow, /platform: linux\/arm64[\s\S]*?arch: arm64/);

  assert.match(dockerfile, /GH_DEB_SHA256_AMD64=7e54a307f90afdc59796c325ec0c49fb09e6c18537727207a8ac7513584ea5b0/);
  assert.match(dockerfile, /GH_BINARY_SHA256_AMD64=7469124f706944133d6a169691dd1c6c3511b12e85878d255e044e2948df4c9b/);
  assert.match(dockerfile, /GH_DEB_SHA256_ARM64=5006962696f01e1624b3fcf1f9d8e1a11547f24bf067dd2a0371b7b421945237/);
  assert.match(dockerfile, /GH_BINARY_SHA256_ARM64=93308395c2d296a63a662742c6366e4db413d2a4870d07bd9b84e491c065d65d/);
  assert.match(dockerfile, /amd64\) gh_arch=amd64;/);
  assert.match(dockerfile, /arm64\) gh_arch=arm64;/);
  assert.match(dockerfile, /\*\) echo "FATAL: no pinned gh package for architecture \$arch"/);
  assert.match(dockerfile, /gh_\$\{GH_VERSION\}_linux_\$\{gh_arch\}\.deb/);
});
