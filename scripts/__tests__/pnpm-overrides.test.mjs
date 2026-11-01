import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const overrides = manifest.pnpm?.overrides ?? {};

// pnpm applies a `zod@<range>` override to every dependency *and peer* spec that merely
// intersects the range. A global zod 4 override therefore also rewrites the dual
// `^3.25 || ^4` specs of @modelcontextprotocol/sdk, @anthropic-ai/sdk,
// @agentclientprotocol/sdk and zod-to-json-schema, silently moving zod 3 consumers onto
// zod 4 and leaving our zod 3 workspaces with unmet peers. Scope zod overrides to the
// parents that actually depend on zod 4 (`parent>zod@range`).
test("zod overrides are scoped to parent packages", () => {
  const zodSelectors = Object.keys(overrides).filter((selector) => /(^|[^ |@]>)zod(@|$)/.test(selector));
  for (const selector of zodSelectors) {
    assert.match(selector, /^[^>]*[^ |@>]>zod(@.+)?$/, `${selector} must use a parent selector (parent>zod@range)`);
  }
});
