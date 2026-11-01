import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * API validation errors keep zod 3's issue objects (see
 * packages/shared/src/validators/zod3-issues.ts): client input is parsed with
 * `zod3IssueParams`, and issues are serialized through `toZod3Issues` /
 * `flattenZod3Issues`. These checks catch new code that sends raw zod 4
 * issues or zod 4 `flatten()` output to clients.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");

// Reads of raw issues that never reach a response body.
const RAW_ISSUE_READS_ALLOWED = new Set([
  // Looks up a refinement's `params.code`; the refinement message is custom.
  "routes/file-resources.ts:const refinement = error.issues.find((issue) => {",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out.sort();
}

const lines = sourceFiles(SRC).flatMap((file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((text, index) => ({ file: path.relative(SRC, file).split(path.sep).join("/"), line: index + 1, text: text.trim() })),
);

describe("zod issue serialization guard (server)", () => {
  it("serializes zod issues only through toZod3Issues / flattenZod3Issues", () => {
    const offenders = lines
      .filter(({ text }) => /\b(?:error|err)\.issues\b/.test(text))
      .filter(({ text }) => !/toZod3Issues\(|flattenZod3Issues\(/.test(text))
      .filter(({ file, text }) => !RAW_ISSUE_READS_ALLOWED.has(`${file}:${text}`))
      .map(({ file, line, text }) => `${file}:${line}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it("does not use zod's own flatten()/format()/.errors on validation errors", () => {
    const offenders = lines
      .filter(({ text }) => /\.error\.(?:flatten|format)\(|\b(?:error|err)\.(?:flatten|format)\(\)|\.error\.errors\b/.test(text))
      .map(({ file, line, text }) => `${file}:${line}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it("parses request input with zod3IssueParams", () => {
    const offenders = lines
      .filter(({ text }) => /\.(?:safeParse|parse|safeParseAsync|parseAsync)\(req\.(?:body|query|params)\b/.test(text))
      .filter(({ text }) => !text.includes("zod3IssueParams"))
      .map(({ file, line, text }) => `${file}:${line}: ${text}`);
    expect(offenders).toEqual([]);
  });
});
