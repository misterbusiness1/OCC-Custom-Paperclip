import assert from "node:assert/strict";
import test from "node:test";

import { blockingAdvisories } from "./dependency-audit.mjs";

test("blocks only high and critical production advisories", () => {
  const report = {
    advisories: {
      1: { id: 1, severity: "low" },
      2: { id: 2, severity: "moderate" },
      3: { id: 3, severity: "high" },
      4: { id: 4, severity: "critical" },
    },
  };

  assert.deepEqual(blockingAdvisories(report).map(({ id }) => id), [3, 4]);
});

test("fails closed on an unsupported audit report", () => {
  assert.throws(() => blockingAdvisories({}), /unsupported report shape/);
});
