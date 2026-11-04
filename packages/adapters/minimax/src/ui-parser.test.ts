import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type ParseFn = (line: string, ts: string) => Array<Record<string, unknown>>;

// Evaluate ui-parser.cjs exactly as ui/src/adapters/sandboxed-parser-worker.ts
// does: inside `new Function("exports", "module", "self", "globalThis", ...)`
// with a strict-mode block wrapper and no access to self/globalThis.
function loadParserLikeSandbox(): ParseFn {
  const source = readFileSync(path.join(packageDir, "ui-parser.cjs"), "utf8");
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const factory = new Function(
    "exports",
    "module",
    "self",
    "globalThis",
    "\"use strict\";\n{\n" + source + "\n}",
  );
  factory(exports, module, undefined, undefined);
  const resolved =
    module.exports && typeof module.exports === "object" && Object.keys(module.exports).length > 0
      ? (module.exports as Record<string, unknown>)
      : exports;
  expect(typeof resolved.parseStdoutLine).toBe("function");
  return resolved.parseStdoutLine as ParseFn;
}

describe("ui-parser.cjs", () => {
  it("contains no ESM syntax or imports", () => {
    const source = readFileSync(path.join(packageDir, "ui-parser.cjs"), "utf8");
    expect(source).not.toMatch(/^\s*(export|import)\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("maps adapter stdout lines to transcript entries", () => {
    const parse = loadParserLikeSandbox();
    const ts = "2026-01-01T00:00:00.000Z";

    const call = parse("[tool] $ ls -la", ts);
    expect(call).toEqual([
      { kind: "tool_call", ts, name: "bash", input: { command: "ls -la" }, toolUseId: expect.any(String) },
    ]);
    const toolUseId = call[0]!.toolUseId;

    expect(parse("total 0", ts)).toEqual([{ kind: "stdout", ts, text: "total 0" }]);

    expect(parse("[tool] exit 0", ts)).toEqual([
      { kind: "tool_result", ts, toolUseId, toolName: "bash", content: "exit 0", isError: false },
    ]);

    const second = parse("[tool] $ false", ts);
    expect(second[0]!.toolUseId).not.toBe(toolUseId);
    expect(parse("[tool] exit 1", ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: second[0]!.toolUseId, toolName: "bash", content: "exit 1", isError: true },
    ]);
    expect(parse("[tool] $ missing-binary", ts)[0]!.kind).toBe("tool_call");
    expect(parse("[tool] exit spawn-error", ts)[0]).toMatchObject({ kind: "tool_result", isError: true });

    expect(parse("[paperclip] No actionable task in this wake; standing by.", ts)).toEqual([
      { kind: "system", ts, text: "No actionable task in this wake; standing by." },
    ]);

    expect(parse("Visible answer", ts)).toEqual([{ kind: "assistant", ts, text: "Visible answer" }]);
    expect(parse("   ", ts)).toEqual([]);
  });
});

describe("package.json external-adapter contract", () => {
  const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

  it("exports the TypeScript entry, server entry and the CJS ui-parser", () => {
    expect(pkg.name).toBe("@paperclipai/minimax-paperclip-adapter");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.exports).toEqual({
      ".": "./src/index.ts",
      "./server": "./src/server/index.ts",
      "./ui-parser": "./ui-parser.cjs",
    });
  });

  it("declares UI parser contract version 1.x", () => {
    expect(pkg.paperclip?.adapterUiParser).toBe("1.0.0");
  });
});
