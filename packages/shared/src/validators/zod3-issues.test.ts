import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZOD_BASELINE_UPDATE_ENV, readGolden, readZodVersion } from "../testing/zod-baseline-golden.js";
import { datetimeString } from "./zod-compat.js";
import {
  flattenZod3Issues,
  isZodError,
  toZod3Issues,
  ZOD3_ISSUE_KEY,
  zod3IssueParams,
  zod3RequiredError,
} from "./zod3-issues.js";

/**
 * zod 4 issues converted with `zod3IssueParams` + `toZod3Issues` must equal
 * the issues zod 3.25.76 produced for the same schema and input.
 *
 * The fixture holds zod 3.25.76's `error.issues` (JSON) for every probe. It
 * was recorded by running this file with
 * `PAPERCLIP_UPDATE_ZOD_BASELINE=1 PAPERCLIP_ZOD3_MODULE=<zod@3.25.76>/index.js`
 * (zod 3 is no longer a workspace dependency, so the module is passed in);
 * the update refuses to write unless that module is zod 3. This is a zod 3
 * reference golden: `PAPERCLIP_UPDATE_ZOD_GOLDENS=1` leaves it untouched. To
 * add a probe, add it to PROBES and re-record with the two variables above.
 *
 * Each probe builds its schema with the zod 3 API (`v3 === true`) or the
 * zod 4 API the codebase uses for the same rule (`z.uuid()`, `z.url()`,
 * `z.iso.date()`, the shared datetime helper).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "__fixtures__", "zod3-issue-probes.json");

type ZodLike = typeof z;
type Probe = { schema: (zod: ZodLike, v3: boolean) => z.ZodType; input: unknown };

const PROBES: Record<string, Probe> = {
  "string, number input": { schema: (zod) => zod.string(), input: 5 },
  "string, missing": { schema: (zod) => zod.string(), input: undefined },
  "string, null": { schema: (zod) => zod.string(), input: null },
  "string, array": { schema: (zod) => zod.string(), input: [1] },
  "string, object": { schema: (zod) => zod.string(), input: { a: 1 } },
  "string, Map": { schema: (zod) => zod.string(), input: new Map() },
  "string, Set": { schema: (zod) => zod.string(), input: new Set() },
  "string, Date": { schema: (zod) => zod.string(), input: new Date(0) },
  "string, promise": { schema: (zod) => zod.string(), input: { then: () => undefined, catch: () => undefined } },
  "number, string input": { schema: (zod) => zod.number(), input: "5" },
  "number, NaN": { schema: (zod) => zod.number(), input: Number.NaN },
  "int, float": { schema: (zod) => zod.number().int(), input: 1.5 },
  "int min": { schema: (zod) => zod.number().int().min(1), input: 0 },
  "number max": { schema: (zod) => zod.number().max(10), input: 11 },
  "number gt": { schema: (zod) => zod.number().gt(1), input: 1 },
  "number lt": { schema: (zod) => zod.number().lt(1), input: 1 },
  "number positive": { schema: (zod) => zod.number().positive(), input: 0 },
  "number nonnegative": { schema: (zod) => zod.number().nonnegative(), input: -1 },
  "number multipleOf": { schema: (zod) => zod.number().multipleOf(5), input: 7 },
  "coerce number, not numeric": { schema: (zod) => zod.coerce.number().int().min(1), input: "abc" },
  "coerce number, below min": { schema: (zod) => zod.coerce.number().int().min(1), input: "0" },
  "boolean, string": { schema: (zod) => zod.boolean(), input: "yes" },
  "bigint, number": { schema: (zod) => zod.bigint(), input: 5 },
  "null, number": { schema: (zod) => zod.null(), input: 1 },
  "enum, unknown value": { schema: (zod) => zod.enum(["a", "b"]), input: "c" },
  "enum, number": { schema: (zod) => zod.enum(["a", "b"]), input: 1 },
  "enum, null": { schema: (zod) => zod.enum(["a", "b"]), input: null },
  "enum, missing": { schema: (zod) => zod.enum(["a", "b"]), input: undefined },
  "single-value enum": { schema: (zod) => zod.enum(["header"]), input: "" },
  "literal number": { schema: (zod) => zod.literal(1), input: 2 },
  "literal string": { schema: (zod) => zod.literal("x"), input: "y" },
  "literal string, number input": { schema: (zod) => zod.literal("x"), input: 3 },
  "literal, missing": { schema: (zod) => zod.literal("x"), input: undefined },
  "literal boolean": { schema: (zod) => zod.literal(true), input: false },
  "strict object, unknown keys": { schema: (zod) => zod.object({ a: zod.string() }).strict(), input: { a: "x", b: 1, c: 2 } },
  "object, missing keys": { schema: (zod) => zod.object({ a: zod.string(), b: zod.number() }), input: {} },
  "object, string input": { schema: (zod) => zod.object({ a: zod.string() }), input: "x" },
  "object, null": { schema: (zod) => zod.object({ a: zod.string() }), input: null },
  "object, array": { schema: (zod) => zod.object({ a: zod.string() }), input: [] },
  "nested object and array": {
    schema: (zod) => zod.object({ a: zod.object({ b: zod.array(zod.number()) }) }),
    input: { a: { b: [1, "x", 3] } },
  },
  "optional and nullable fields": {
    schema: (zod) => zod.object({ a: zod.string().optional(), b: zod.number().nullable() }),
    input: { a: 1, b: "x" },
  },
  "nullable, wrong type": { schema: (zod) => zod.string().nullable(), input: 5 },
  "field with default, wrong type": { schema: (zod) => zod.object({ a: zod.string().default("x") }), input: { a: 5 } },
  "array min": { schema: (zod) => zod.array(zod.string()).min(2), input: ["a"] },
  "array max": { schema: (zod) => zod.array(zod.string()).max(1), input: ["a", "b"] },
  "array length": { schema: (zod) => zod.array(zod.string()).length(2), input: ["a"] },
  "array nonempty": { schema: (zod) => zod.array(zod.string()).nonempty(), input: [] },
  "array, string input": { schema: (zod) => zod.array(zod.string()), input: "x" },
  "array of objects, element issues": {
    schema: (zod) => zod.array(zod.object({ id: zod.string().min(1) })).max(5),
    input: [{ id: "" }, { id: 3 }],
  },
  "tuple, string input": { schema: (zod) => zod.tuple([zod.string()]), input: "x" },
  "string min": { schema: (zod) => zod.string().min(3), input: "a" },
  "string max": { schema: (zod) => zod.string().max(1), input: "ab" },
  "string length, short": { schema: (zod) => zod.string().length(3), input: "a" },
  "string length, long": { schema: (zod) => zod.string().length(1), input: "abc" },
  "trimmed string min": { schema: (zod) => zod.string().trim().min(1), input: "   " },
  "custom check message": { schema: (zod) => zod.string().min(2, "Too short"), input: "a" },
  email: { schema: (zod) => zod.string().email(), input: "nope" },
  url: { schema: (zod, v3) => (v3 ? zod.string().url() : zod.url()), input: "not a url" },
  uuid: { schema: (zod, v3) => (v3 ? zod.string().uuid() : zod.uuid()), input: "nope" },
  datetime: { schema: (zod, v3) => (v3 ? zod.string().datetime() : datetimeString()), input: "yesterday" },
  date: { schema: (zod, v3) => (v3 ? zod.string().date() : zod.iso.date()), input: "2026-13-45" },
  "regex, default message": { schema: (zod) => zod.string().regex(/^a+$/), input: "b" },
  "regex, custom message": { schema: (zod) => zod.string().regex(/^a+$/, "Only a"), input: "b" },
  startsWith: { schema: (zod) => zod.string().startsWith("ab"), input: "x" },
  endsWith: { schema: (zod) => zod.string().endsWith("ab"), input: "x" },
  includes: { schema: (zod) => zod.string().includes("ab"), input: "x" },
  "includes with position": { schema: (zod) => zod.string().includes("ab", { position: 2 }), input: "abxx" },
  "refine, default message": { schema: (zod) => zod.string().refine((value) => value === "ok"), input: "no" },
  "refine, custom message": {
    schema: (zod) => zod.string().refine((value) => value === "ok", { message: "Must be ok" }),
    input: "no",
  },
  "refine with params": {
    schema: (zod) => zod.string().refine((value) => value === "ok", { message: "Bad", params: { code: "bad" } }),
    input: "no",
  },
  "superRefine addIssue": {
    schema: (zod) =>
      zod.object({ a: zod.string() }).superRefine((_value, ctx) => {
        ctx.addIssue({ code: "custom", message: "Nope", path: ["a"] });
      }),
    input: { a: "x" },
  },
  "union, every option fails on type": { schema: (zod) => zod.union([zod.string(), zod.number()]), input: true },
  "union, one option fails on checks": { schema: (zod) => zod.union([zod.string().min(5), zod.number()]), input: "ab" },
  "union inside object": {
    schema: (zod) => zod.object({ v: zod.union([zod.string(), zod.literal(1), zod.null()]) }),
    input: { v: true },
  },
  "discriminated union, unknown discriminator": {
    schema: (zod) =>
      zod.object({
        x: zod.discriminatedUnion("kind", [
          zod.object({ kind: zod.literal("a"), a: zod.string() }),
          zod.object({ kind: zod.literal("b") }),
        ]),
      }),
    input: { x: { kind: "c" } },
  },
  "discriminated union, missing discriminator": {
    schema: (zod) =>
      zod.discriminatedUnion("kind", [zod.object({ kind: zod.literal("a"), a: zod.string() }), zod.object({ kind: zod.literal("b") })]),
    input: {},
  },
  "discriminated union, option fails": {
    schema: (zod) =>
      zod.discriminatedUnion("kind", [zod.object({ kind: zod.literal("a"), a: zod.string() }), zod.object({ kind: zod.literal("b") })]),
    input: { kind: "a", a: 1 },
  },
  "discriminated union, string input": {
    schema: (zod) => zod.discriminatedUnion("kind", [zod.object({ kind: zod.literal("a") }), zod.object({ kind: zod.literal("b") })]),
    input: "x",
  },
  "record values": { schema: (zod) => zod.record(zod.string(), zod.number()), input: { a: "x", b: 2 } },
  "record, string input": { schema: (zod) => zod.record(zod.string(), zod.number()), input: "x" },
  "record key check": { schema: (zod) => zod.record(zod.string().min(2), zod.number()), input: { a: 1 } },
  "date, invalid Date": { schema: (zod) => zod.date(), input: new Date("nope") },
  "date, string input": { schema: (zod) => zod.date(), input: "2026-01-01" },
  preprocess: {
    schema: (zod) => zod.preprocess((value) => (typeof value === "string" ? value.trim() : value), zod.string().min(2)),
    input: " a ",
  },
  "transform then pipe": {
    schema: (zod) => zod.string().transform((value) => value.length).pipe(zod.number().min(5)),
    input: "abc",
  },
  // zod 4 also runs length checks on a wrong-typed value that has a length.
  "string min, array input": { schema: (zod) => zod.object({ title: zod.string().min(1) }), input: { title: [] } },
  "string min max, long array input": { schema: (zod) => zod.string().min(1).max(3), input: [1, 2, 3, 4, 5] },
  "trimmed nullable string min, array input": { schema: (zod) => zod.string().trim().min(1).nullable(), input: [] },
  "array max, long string input": { schema: (zod) => zod.array(zod.string()).max(20), input: "x".repeat(600) },
  "array nonempty, empty string input": { schema: (zod) => zod.array(zod.string()).nonempty(), input: "" },
  "array length, string input": { schema: (zod) => zod.array(zod.string()).length(2), input: "abc" },
  "array of strings, array elements": { schema: (zod) => zod.array(zod.string().min(2)), input: [[], "x", [1, 2, 3]] },
  "record value min, array input": { schema: (zod) => zod.record(zod.string(), zod.string().min(2)), input: { a: [] } },
  "union option string min, array input": { schema: (zod) => zod.union([zod.string().min(1), zod.number()]), input: [] },
  // zod 4 reports an array's size issue after its element issues.
  "array min, element issues": { schema: (zod) => zod.array(zod.object({ id: zod.string() })).min(3), input: [{ id: 1 }, {}] },
  "array min between sibling fields": {
    schema: (zod) => zod.object({ before: zod.string(), list: zod.array(zod.string().min(2)).min(3), after: zod.number() }),
    input: { before: 1, list: ["a", 2], after: "x" },
  },
  // zod 4 stops after a failed .int(); zod 3 still ran the later checks.
  "int min, float below": { schema: (zod) => zod.number().int().min(30), input: 1.5 },
  "int positive, negative float": { schema: (zod) => zod.number().int().positive(), input: -0.5 },
  "int min max, float above": { schema: (zod) => zod.number().int().min(1).max(5), input: 7.5 },
  "int multipleOf, float": { schema: (zod) => zod.number().int().multipleOf(5), input: 7.5 },
  "int min with custom message, float": { schema: (zod) => zod.object({ n: zod.number().int().min(30, "At least 30") }), input: { n: 1.5 } },
  "min before int, float": { schema: (zod) => zod.number().min(30).int(), input: 1.5 },
  "coerce int min, float string": { schema: (zod) => zod.coerce.number().int().min(1), input: "0.5" },
  // zod 3 returned the first union option that failed without aborting.
  "union literal or int, float": { schema: (zod) => zod.union([zod.literal("latest"), zod.number().int().positive()]), input: 1.5 },
  "union of int options, float": { schema: (zod) => zod.union([zod.number().int(), zod.number().int().min(10)]), input: 1.5 },
  "union, two options fail on checks": { schema: (zod) => zod.union([zod.string().min(5), zod.string().regex(/^z/)]), input: "ab" },
  "union, aborted option then two dirty options": {
    schema: (zod) => zod.union([zod.number(), zod.string().min(5), zod.string().max(1)]),
    input: "abc",
  },
  "union, two dirty object options": {
    schema: (zod) => zod.union([zod.object({ a: zod.string().min(3) }), zod.object({ a: zod.string().max(1), b: zod.number().optional() })]),
    input: { a: "ab" },
  },
  "union, aborted field option then dirty option": {
    schema: (zod) => zod.union([zod.object({ a: zod.number() }), zod.object({ a: zod.string().min(5) })]),
    input: { a: "ab" },
  },
  "union, two refinement options": {
    schema: (zod) =>
      zod.union([
        zod.string().refine((value) => value.startsWith("x"), "Needs x"),
        zod.string().refine((value) => value.endsWith("y"), "Needs y"),
      ]),
    input: "ab",
  },
  "union, two strict objects with unknown keys": {
    schema: (zod) => zod.union([zod.object({ a: zod.string() }).strict(), zod.object({ b: zod.string() }).strict()]),
    input: { a: "x", c: 1 },
  },
  "union of array options with sizes": {
    schema: (zod) => zod.union([zod.array(zod.string()).min(2), zod.array(zod.number()).max(0)]),
    input: ["a"],
  },
};

/**
 * Probes whose zod 4 result intentionally differs from zod 3, with the
 * expected zod 4 (converted) issues.
 */
const KNOWN_DIFFERENCES: Record<string, { reason: string; schema: () => z.ZodType; input: unknown; expected: unknown }> = {
  "array over max reports only the size issue": {
    reason:
      "zod 4.6.6+ rejects an oversized array before parsing its elements (the GHSA-mrhx-c7xc-m3w5 fix); " +
      "zod 3 also reported every element issue.",
    schema: () => z.array(z.object({ id: z.string().min(1) })).max(1),
    input: [{ id: "" }, { id: 3 }],
    expected: [
      { code: "too_big", maximum: 1, type: "array", inclusive: true, exact: false, message: "Array must contain at most 1 element(s)", path: [] },
    ],
  },
  "earlier union option failing only .int() loses to a later dirty option": {
    reason:
      "zod 3 returned the first option that failed without aborting, here the .int() option. zod 4 aborts after .int(), " +
      "so it resolves to the later option and reports its issues without an invalid_union to convert.",
    schema: () => z.union([z.number().int(), z.number().min(10)]),
    input: 1.5,
    expected: [
      { code: "too_small", minimum: 10, type: "number", inclusive: true, exact: false, message: "Number must be greater than or equal to 10", path: [] },
    ],
  },
  "superRefine issue with path before message": {
    reason:
      "zod 3 kept the key order of the object passed to ctx.addIssue ({ code, path, message }); the converted issue lists " +
      "message before path, as for .refine(). Same keys and values.",
    schema: () =>
      z.object({ a: z.string() }).superRefine((_value, ctx) => {
        ctx.addIssue({ code: "custom", path: ["a"], message: "Nope" });
      }),
    input: { a: "x" },
    expected: [{ code: "custom", message: "Nope", path: ["a"] }],
  },
};

function runZod4(probe: Probe) {
  const result = probe.schema(z, false).safeParse(probe.input, zod3IssueParams);
  return result.success ? { success: true } : JSON.parse(JSON.stringify(toZod3Issues(result.error.issues)));
}

type ProbeFixture = Record<string, unknown>;

async function maybeRecordFixture() {
  if (process.env[ZOD_BASELINE_UPDATE_ENV] !== "1") return;
  const modulePath = process.env.PAPERCLIP_ZOD3_MODULE;
  if (!modulePath) throw new Error("PAPERCLIP_ZOD3_MODULE must point at zod@3's index.js to record this fixture.");
  const version = readZodVersion(path.join(path.dirname(modulePath), "package.json"));
  if (!version.startsWith("3.")) {
    throw new Error(`${ZOD_BASELINE_UPDATE_ENV}=1 refused: ${modulePath} is zod ${version}, not zod 3.`);
  }
  const zod3 = (await import(pathToFileURL(modulePath).href)) as { z: ZodLike };
  const data: ProbeFixture = {};
  for (const [name, probe] of Object.entries(PROBES)) {
    const result = probe.schema(zod3.z, true).safeParse(probe.input);
    data[name] = result.success ? { success: true } : JSON.parse(JSON.stringify(result.error.issues));
  }
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(
    FIXTURE,
    `${JSON.stringify({ capturedWith: `zod@${version}`, note: "zod 3 error.issues for each probe in validators/zod3-issues.test.ts.", data }, null, 1)}\n`,
  );
}

describe("toZod3Issues + zod3IssueParams (zod 3.25.76 probes)", async () => {
  await maybeRecordFixture();
  const fixture = readGolden<ProbeFixture>(FIXTURE);

  it("was recorded on zod 3 and covers every probe", () => {
    expect(fixture.capturedWith).toMatch(/^zod@3\./);
    expect(Object.keys(fixture.data).sort()).toEqual(Object.keys(PROBES).sort());
  });

  for (const [name, probe] of Object.entries(PROBES)) {
    it(`matches zod 3: ${name}`, () => {
      expect(runZod4(probe)).toEqual(fixture.data[name]);
    });
  }

  for (const [name, difference] of Object.entries(KNOWN_DIFFERENCES)) {
    it(`known difference: ${name}`, () => {
      const result = difference.schema().safeParse(difference.input, zod3IssueParams);
      expect(result.success).toBe(false);
      expect(JSON.parse(JSON.stringify(toZod3Issues(result.error!.issues)))).toEqual(difference.expected);
    });
  }
});

describe("issue ordering on large invalid collections", () => {
  it("does not rescan every preceding issue for each invalid skill selection", () => {
    // The skills/sync endpoint accepts an unbounded array. Even a small JSON
    // request can therefore produce thousands of minimum-length failures.
    const result = z.array(z.string().min(1)).safeParse(Array(2_000).fill(""), zod3IssueParams);
    expect(result.success).toBe(false);
    const issues = result.error!.issues;
    let codeReads = 0;
    const observed = issues.map((issue) => new Proxy(issue, {
      get(target, key, receiver) {
        if (key === "code") codeReads += 1;
        return Reflect.get(target, key, receiver);
      },
    }));
    const converted = toZod3Issues(observed);
    expect(converted).toHaveLength(issues.length);
    expect(converted[0]!.path).toEqual([0]);
    expect(converted.at(-1)!.path).toEqual([issues.length - 1]);
    // Count work, not elapsed time: a prefix scan reads O(n²) codes even
    // though every failure is at a different path and none is a type error.
    expect(codeReads).toBeLessThan(issues.length * 20);
  });

  it("moves nested array bounds ahead of elements while preserving sibling and bound order", () => {
    const nested = z.object({
      before: z.string(),
      groups: z.array(z.array(z.string().min(1)).min(2)).min(3),
      after: z.string(),
    }).safeParse({ before: 1, groups: [[""], [""]], after: 2 }, zod3IssueParams);
    expect(toZod3Issues(nested.error!.issues).map((issue) => [issue.code, issue.path])).toEqual([
      ["invalid_type", ["before"]],
      ["too_small", ["groups"]],
      ["too_small", ["groups", 0]],
      ["too_small", ["groups", 0, 0]],
      ["too_small", ["groups", 1]],
      ["too_small", ["groups", 1, 0]],
      ["invalid_type", ["after"]],
    ]);
  });
});

describe("zod3 issue record", () => {
  it("reaches the final zod 4 issue (fails if a zod upgrade stops copying raw issue keys)", () => {
    const result = z.string().safeParse(5, zod3IssueParams);
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0] as unknown as Record<string, unknown>;
    expect(issue[ZOD3_ISSUE_KEY]).toEqual({ code: "invalid_type", expected: "string", received: "number" });
    expect(issue.message).toBe("Expected string, received number");
  });

  it("is not added, and messages stay zod 4's, for parses without zod3IssueParams", () => {
    const result = z.string().safeParse(5);
    const issue = result.error!.issues[0] as unknown as Record<string, unknown>;
    expect(issue[ZOD3_ISSUE_KEY]).toBeUndefined();
    expect(issue.message).toBe("Invalid input: expected string, received number");
  });

  it("converts issues from parses without zod3IssueParams as far as the zod 4 fields allow", () => {
    const result = z.object({ a: z.uuid(), b: z.number().min(2), c: z.enum(["x", "y"]) }).safeParse({ a: "nope", b: 1, c: "z" });
    expect(toZod3Issues(result.error!.issues)).toEqual([
      { validation: "uuid", code: "invalid_string", message: "Invalid UUID", path: ["a"] },
      { code: "too_small", minimum: 2, type: "number", inclusive: true, exact: false, message: "Too small: expected number to be >=2", path: ["b"] },
      { code: "invalid_enum_value", options: ["x", "y"], path: ["c"], message: 'Invalid option: expected one of "x"|"y"' },
    ]);
  });

  it("never leaks the record or the input into converted issues", () => {
    const result = z.object({ a: z.string() }).safeParse({ a: 1 }, { ...zod3IssueParams, reportInput: true });
    for (const issue of toZod3Issues(result.error!.issues)) {
      expect(issue).not.toHaveProperty(ZOD3_ISSUE_KEY);
      expect(issue).not.toHaveProperty("input");
    }
  });
});

describe("zod3RequiredError", () => {
  const schema = z.object({ host: z.string({ error: zod3RequiredError("Host is required.") }).min(1, "Host is required.") });

  it("uses the message for a missing value and records received: undefined, like zod 3's required_error", () => {
    const result = schema.safeParse({}, zod3IssueParams);
    expect(toZod3Issues(result.error!.issues)).toEqual([
      { code: "invalid_type", expected: "string", received: "undefined", path: ["host"], message: "Host is required." },
    ]);
  });

  it("keeps zod 3's default message for a wrong type", () => {
    const result = schema.safeParse({ host: 5 }, zod3IssueParams);
    expect(toZod3Issues(result.error!.issues)).toEqual([
      { code: "invalid_type", expected: "string", received: "number", path: ["host"], message: "Expected string, received number" },
    ]);
  });
});

describe("flattenZod3Issues", () => {
  it("matches zod 3's error.flatten() shape over the converted issues", () => {
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) }).strict();
    const result = schema.safeParse({ b: { c: "x" }, extra: 1 }, zod3IssueParams);
    expect(flattenZod3Issues(result.error!.issues)).toEqual({
      formErrors: ["Unrecognized key(s) in object: 'extra'"],
      fieldErrors: { a: ["Required"], b: ["Expected number, received string"] },
    });
  });
});

describe("isZodError", () => {
  it("recognises thrown and safe-parse zod errors only", () => {
    let thrown: unknown;
    try {
      z.string().parse(1);
    } catch (error) {
      thrown = error;
    }
    expect(isZodError(thrown)).toBe(true);
    expect(isZodError(z.string().safeParse(1).error)).toBe(true);
    expect(isZodError({ name: "ZodError", issues: [] })).toBe(true);
    expect(isZodError(new Error("x"))).toBe(false);
    expect(isZodError({ name: "ZodError" })).toBe(false);
    expect(isZodError(null)).toBe(false);
  });
});
