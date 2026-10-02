import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
const dockerBuildTest = readFileSync(
  new URL("../../../scripts/docker-build-test.sh", import.meta.url),
  "utf8",
);

test("the shipped runtime installs lsof in the production tool layer", () => {
  const productionStage = dockerfile.split("FROM base AS production", 2)[1];
  assert.ok(productionStage, "Dockerfile must define the production stage");
  assert.match(
    productionStage,
    /apt-get install -y --no-install-recommends[^\n\\]*(?:\\\n[^\n]*)*\blsof\b/,
  );
});

test("the image build smoke verifies real port owner detection", () => {
  assert.match(
    dockerBuildTest,
    /run --rm "\$IMAGE_TAG" node scripts\/assert-container-port-owner\.mjs/,
  );
});
