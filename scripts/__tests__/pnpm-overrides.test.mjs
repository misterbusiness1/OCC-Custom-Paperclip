import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const overrides = manifest.pnpm?.overrides ?? {};

// The completed Zod 4 migration replaces the temporary parent-specific floors.
// A parent override can otherwise shadow the exact version used by our compatibility layer.
test("zod uses the migration's single exact pin without parent overrides", () => {
  const selectors = Object.keys(overrides).filter((selector) => /(^|>)zod(@|$)/.test(selector));
  assert.deepEqual(selectors, ["zod"]);
  assert.equal(overrides.zod, "4.6.7");
});
