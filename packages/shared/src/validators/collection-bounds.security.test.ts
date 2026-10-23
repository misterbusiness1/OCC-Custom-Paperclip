import { describe, expect, it } from "vitest";
import { z } from "zod";

// GHSA-mrhx-c7xc-m3w5: an upper bound must reject oversized collections
// before walking their elements. A small fixture proves this without an OOM probe.
describe("bounded collection admission", () => {
  it.each(["array", "set", "map"] as const)("rejects an oversized %s before element validation", (kind) => {
    let inspected = 0;
    const element = z.string().refine(() => { inspected += 1; return true; });
    const schema = kind === "array" ? z.array(element).max(2)
      : kind === "set" ? z.set(element).max(2)
      : z.map(element, element).max(2);
    const values = ["a", "b", "c"];
    const input = kind === "array" ? values : kind === "set" ? new Set(values) : new Map(values.map(value => [value, value]));
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    expect(inspected).toBe(0);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });
  it("still validates every element within the admitted bound", () => {
    let inspected = 0;
    const schema = z.array(z.string().refine(() => { inspected += 1; return true; })).max(2);
    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(inspected).toBe(2);
    expect(schema.safeParse(["a", 1]).success).toBe(false);
  });
});
