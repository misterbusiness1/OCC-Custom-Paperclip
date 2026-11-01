import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadOrUpdateGolden, readZodVersion } from "./testing/zod-baseline-golden.js";
import { datetimeString, urlString } from "./validators/zod-compat.js";

/**
 * zod 3 -> zod 4 baseline for the string/number formats the codebase uses
 * (`.datetime()`, `.datetime({ offset: true })`, `.url()`, `.email()`,
 * `.uuid()`, `.int()`, `z.coerce.number()`, `z.coerce.date()`, `z.date()`).
 *
 * The golden records, on zod 3.25.76, whether each probe input is accepted
 * and what value comes out. After the migration each subject must be built
 * with the schema the code actually uses for that format (for example the
 * shared datetime helper), and its outcomes must match the golden except for
 * the differences listed in INTENTIONAL_DIFFERENCES.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const GOLDEN_FILE = path.join(here, "__fixtures__", "zod3-format-baseline.json");

const DATETIME_PROBES = [
  "2026-10-31T12:00:00Z",
  "2026-10-31T12:00:00.123Z",
  "2026-10-31T12:00:00.123456789Z",
  "2026-10-31T12:00Z",
  "2026-10-31T12Z",
  "2026-10-31T12:00:00",
  "2026-10-31T12:00",
  "2026-10-31T12:00:00+02:00",
  "2026-10-31T12:00+02:00",
  "2026-10-31T12:00:00+0200",
  "2026-10-31T12:00+0200",
  "2026-10-31T12:00:00+02",
  "2026-10-31T12:00:00.5-05:30",
  "2026-10-31 12:00:00Z",
  "2026-10-31",
  "2026-13-31T12:00:00Z",
  "2026-02-30T12:00:00Z",
  "2026-10-31T24:00:00Z",
  "2026-10-31T12:60:00Z",
  "2026-10-31t12:00:00z",
  " 2026-10-31T12:00:00Z",
  "",
  "not a date",
];

const URL_PROBES = [
  "https://example.com",
  "https://example.com/path?q=1#frag",
  "http://localhost:3100/api",
  "ftp://example.com/file",
  "mailto:user@example.com",
  "file:///tmp/x",
  "javascript:alert(1)",
  "example.com",
  "//example.com",
  " https://example.com ",
  "https://exa mple.com",
  "https://example.com/\n",
  "https://",
  "",
];

const EMAIL_PROBES = [
  "user@example.com",
  "USER@EXAMPLE.COM",
  "first.last+tag@sub.example.co.uk",
  "user@localhost",
  "user@[127.0.0.1]",
  "user name@example.com",
  "user@example",
  " user@example.com",
  "user..dots@example.com",
  "",
];

const UUID_PROBES = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123E4567-E89B-42D3-A456-426614174000",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "11111111-1111-1111-1111-111111111111",
  "00000000-0000-0000-0000-000000000001",
  "11111111-1111-4111-8111-111111111111",
  "123e4567-e89b-12d3-a456-426614174000",
  "123e4567-e89b-92d3-a456-426614174000",
  "123e4567-e89b-42d3-c456-426614174000",
  "123e4567e89b42d3a456426614174000",
  "{123e4567-e89b-42d3-a456-426614174000}",
  "123e4567-e89b-42d3-a456-42661417400",
  "",
];

const NUMBER_PROBES: unknown[] = [
  0,
  1,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  -Number.MAX_SAFE_INTEGER - 1,
  1e21,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
  "1",
  "",
  " 2 ",
  "1e3",
  "0x10",
  "abc",
  null,
  true,
  undefined,
];

const DATE_PROBES: unknown[] = [
  "2026-10-31T12:00:00Z",
  "2026-10-31",
  "2026-10-31T12:00Z",
  "not a date",
  "",
  0,
  1_700_000_000_000,
  null,
  undefined,
  true,
];

type Subject = { name: string; schema: () => z.ZodTypeAny; probes: unknown[] };

/**
 * Subjects keyed by the zod 3 API the codebase used; each factory builds the
 * schema the code uses for that format now (on zod 3 it was the plain zod
 * call, on zod 4 the compat helper where one exists).
 */
const SUBJECTS: Subject[] = [
  { name: "string.datetime()", schema: () => datetimeString(), probes: DATETIME_PROBES },
  { name: "string.datetime({offset:true})", schema: () => datetimeString({ offset: true }), probes: DATETIME_PROBES },
  { name: "string.url()", schema: () => urlString(), probes: URL_PROBES },
  { name: "string.trim().url()", schema: () => urlString({ trim: true }), probes: URL_PROBES },
  { name: "string.email()", schema: () => z.string().email(), probes: EMAIL_PROBES },
  { name: "string.uuid()", schema: () => z.uuid(), probes: UUID_PROBES },
  { name: "number()", schema: () => z.number(), probes: NUMBER_PROBES },
  { name: "number().int()", schema: () => z.number().int(), probes: NUMBER_PROBES },
  { name: "coerce.number()", schema: () => z.coerce.number(), probes: NUMBER_PROBES },
  { name: "coerce.number().int()", schema: () => z.coerce.number().int(), probes: NUMBER_PROBES },
  { name: "date()", schema: () => z.date(), probes: DATE_PROBES },
  { name: "coerce.date()", schema: () => z.coerce.date(), probes: DATE_PROBES },
];

const STRICT_UUID =
  "Owner decision: IDs use zod 4's RFC 9562 z.uuid() (version 1-8 and variant 8/9/a/b, plus nil and max). " +
  "zod 3's .uuid() accepted any 8-4-4-4-12 hex string. Every production ID is a random v4 UUID; test fixtures were updated.";
const NON_FINITE =
  "zod 4 rejects Infinity/-Infinity for z.number(). JSON request bodies cannot encode them, and every z.coerce.number() " +
  "in the codebase also has .int(), which zod 3 already used to reject non-finite query values.";
const UNSAFE_INTEGER =
  "zod 4's .int() only accepts safe integers (|n| <= 2^53 - 1). Larger values cannot be represented exactly in " +
  "JavaScript after JSON.parse, so zod 3 accepted an already-corrupted number.";

/**
 * Probe outcomes that are allowed to differ from the zod 3 golden, keyed by
 * `${subject} ${probe}`, with the reason. These are the only zod 3 -> zod 4
 * format differences the migration accepts.
 */
const INTENTIONAL_DIFFERENCES: Record<string, string> = {
  'string.uuid() "11111111-1111-1111-1111-111111111111"': STRICT_UUID,
  'string.uuid() "00000000-0000-0000-0000-000000000001"': STRICT_UUID,
  'string.uuid() "123e4567-e89b-92d3-a456-426614174000"': STRICT_UUID,
  'string.uuid() "123e4567-e89b-42d3-c456-426614174000"': STRICT_UUID,
  "number() Infinity": NON_FINITE,
  "number() -Infinity": NON_FINITE,
  "coerce.number() Infinity": NON_FINITE,
  "coerce.number() -Infinity": NON_FINITE,
  "number().int() 9007199254740992": UNSAFE_INTEGER,
  "number().int() -9007199254740992": UNSAFE_INTEGER,
  "number().int() 1e+21": UNSAFE_INTEGER,
  "coerce.number().int() 9007199254740992": UNSAFE_INTEGER,
  "coerce.number().int() -9007199254740992": UNSAFE_INTEGER,
  "coerce.number().int() 1e+21": UNSAFE_INTEGER,
};

function describeProbe(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function encodeOutput(value: unknown): unknown {
  if (value instanceof Date) return { date: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { number: String(value) };
  return value;
}

function runSubjects() {
  const out: Record<string, Record<string, { ok: boolean; output?: unknown }>> = {};
  for (const subject of SUBJECTS) {
    const schema = subject.schema();
    const results: Record<string, { ok: boolean; output?: unknown }> = {};
    for (const probe of subject.probes) {
      const result = schema.safeParse(probe);
      results[describeProbe(probe)] = result.success ? { ok: true, output: encodeOutput(result.data) } : { ok: false };
    }
    out[subject.name] = results;
  }
  return out;
}

describe("zod format behaviour baseline", () => {
  const current = runSubjects();
  const golden = loadOrUpdateGolden(GOLDEN_FILE, current, {
    zodVersion,
    // zod 3's own output for fixed probes: never re-recorded on zod 4.
    kind: "zod3-reference",
    note:
      "Accept/reject and output of each string/number format probe, captured before the zod 4 migration. " +
      "Do not regenerate on zod 4; see packages/shared/src/testing/zod-baseline-golden.ts.",
  }).data;

  for (const subject of SUBJECTS) {
    it(`${subject.name} keeps zod 3 acceptance and output`, () => {
      const mismatches: Array<{ probe: string; golden: unknown; current: unknown }> = [];
      for (const [probe, outcome] of Object.entries(current[subject.name] ?? {})) {
        const expected = golden[subject.name]?.[probe];
        if (JSON.stringify(expected) === JSON.stringify(outcome)) continue;
        if (INTENTIONAL_DIFFERENCES[`${subject.name} ${probe}`]) continue;
        mismatches.push({ probe, golden: expected, current: outcome });
      }
      expect(mismatches).toEqual([]);
      expect(Object.keys(current[subject.name] ?? {}).sort()).toEqual(Object.keys(golden[subject.name] ?? {}).sort());
    });
  }

  it("lists only intentional differences that really differ from zod 3", () => {
    const stale = Object.keys(INTENTIONAL_DIFFERENCES).filter((key) => {
      const subject = SUBJECTS.find((entry) => key.startsWith(`${entry.name} `));
      if (!subject) return true;
      const probe = key.slice(subject.name.length + 1);
      return JSON.stringify(golden[subject.name]?.[probe]) === JSON.stringify(current[subject.name]?.[probe]);
    });
    expect(stale).toEqual([]);
  });
});
