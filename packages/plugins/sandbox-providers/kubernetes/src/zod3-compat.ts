import { z } from "zod";

/**
 * zod 3 behaviour this plugin keeps on zod 4.
 *
 * The provider config is validated here and the issue messages are shown to
 * operators (`onEnvironmentValidateConfig` / `onEnvironmentProbe`), and the
 * parsed config is what the host stores as the normalized config. zod 4
 * changed default messages ("Required" became "Invalid input: expected
 * string, received undefined", ...) and made `.url()` trim its value, so:
 * - `zod3ParseParams` (pass it to `parse`/`safeParse`) words issues the way
 *   zod 3.25.76 did for the schema kinds this plugin uses. It is a per-parse
 *   error map, never `z.config()`, so other zod users in the worker are not
 *   affected. Issues with a custom message keep it.
 * - `urlString()` accepts what `new URL()` parses and returns the value
 *   unchanged, as zod 3's `.url()` did.
 *
 * This package is installed standalone and must not depend on workspace
 * packages at runtime; the server-side equivalent lives in
 * `@paperclipai/shared` (`zod3IssueParams`, `urlString`).
 * test/unit/zod-validation-messages-baseline.test.ts compares the results with
 * a golden recorded on zod 3.25.76.
 */

// zod 3 `getParsedType` (helpers/util.js), for the `received` part of messages.
function zod3ParsedType(data: unknown): string {
  switch (typeof data) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    default:
      if (Array.isArray(data)) return "array";
      if (data === null) return "null";
      if (typeof (data as { then?: unknown }).then === "function" && typeof (data as { catch?: unknown }).catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) return "map";
      if (typeof Set !== "undefined" && data instanceof Set) return "set";
      if (typeof Date !== "undefined" && data instanceof Date) return "date";
      return "object";
  }
}

// zod 3 `util.joinValues` with its " | " separator.
function joinValues(values: readonly unknown[]): string {
  return values.map((value) => (typeof value === "string" ? `'${value}'` : String(value))).join(" | ");
}

const EXPECTED_ZOD3_NAMES: Record<string, string> = { record: "object" };

type RawIssue = z.core.$ZodRawIssue & Record<string, unknown>;

function sizeMessage(issue: RawIssue, direction: "small" | "big"): string | undefined {
  const bound = direction === "small" ? issue.minimum : issue.maximum;
  const inclusive = issue.inclusive === true;
  const exact = issue.exact === true;
  switch (issue.origin) {
    case "string":
      return direction === "small"
        ? `String must contain ${exact ? "exactly" : inclusive ? "at least" : "over"} ${bound} character(s)`
        : `String must contain ${exact ? "exactly" : inclusive ? "at most" : "under"} ${bound} character(s)`;
    case "number":
      return direction === "small"
        ? `Number must be ${exact ? "exactly equal to " : inclusive ? "greater than or equal to " : "greater than "}${bound}`
        : `Number must be ${exact ? "exactly" : inclusive ? "less than or equal to" : "less than"} ${bound}`;
    case "array":
      return direction === "small"
        ? `Array must contain ${exact ? "exactly" : inclusive ? "at least" : "more than"} ${bound} element(s)`
        : `Array must contain ${exact ? "exactly" : inclusive ? "at most" : "less than"} ${bound} element(s)`;
    default:
      return undefined;
  }
}

/** zod 3.25.76's English message for a raw zod 4 issue, or undefined to keep zod 4's. */
export const zod3ErrorMap: z.core.$ZodErrorMap = (rawIssue) => {
  const issue = rawIssue as RawIssue;
  const input = "input" in issue ? issue.input : undefined;
  switch (issue.code) {
    case "invalid_type": {
      if (input === undefined) return "Required";
      if (issue.expected === "int") return "Expected integer, received float";
      const expected = String(issue.expected);
      return `Expected ${EXPECTED_ZOD3_NAMES[expected] ?? expected}, received ${zod3ParsedType(input)}`;
    }
    case "invalid_value": {
      const values = (issue.values as readonly unknown[] | undefined) ?? [];
      // zod 3's z.enum() reported a non-string input as invalid_type.
      if (typeof input !== "string") return `Expected ${joinValues(values)}, received ${zod3ParsedType(input)}`;
      return `Invalid enum value. Expected ${joinValues(values)}, received '${input}'`;
    }
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${((issue.keys as string[] | undefined) ?? []).map((key) => `'${key}'`).join(", ")}`;
    case "too_small":
      return sizeMessage(issue, "small");
    case "too_big":
      return sizeMessage(issue, "big");
    case "invalid_format":
      if (issue.format === "regex") return "Invalid";
      if (issue.format === "url") return "Invalid url";
      return undefined;
    case "custom":
      return "Invalid input";
    default:
      return undefined;
  }
};

/** Parse params that word issues like zod 3: `schema.safeParse(input, zod3ParseParams)`. */
export const zod3ParseParams = { error: zod3ErrorMap } as const;

function isParseableUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A URL string with zod 3's `.url()` rules: accepted when `new URL(value)`
 * parses it and returned unchanged (zod 4's `.url()` trims the value and
 * strips tabs and newlines).
 */
export function urlString() {
  return z.string().check(z.stringFormat("url", isParseableUrl, { error: "Invalid url" }));
}
