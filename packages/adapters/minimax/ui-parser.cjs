"use strict";

// Self-contained UI transcript parser for the minimax_local external adapter
// (paperclip.adapterUiParser 1.0.0).
//
// Paperclip evaluates this file inside a sandboxed Web Worker with
// `new Function("exports", "module", "self", "globalThis", source)`, so it
// must be plain CommonJS-compatible JavaScript: no `import`/`export`
// statements and no dependencies. Do not replace it with tsc ESM output.
//
// execute() writes these stdout lines:
//   [tool] $ <command>     -> tool_call
//   <command output...>    -> stdout (while a tool call is open)
//   [tool] exit <code>     -> tool_result (isError when code != 0)
//   [paperclip] <note>     -> system
//   anything else          -> assistant

var TOOL_CALL_RE = /^\[tool\] \$ ([\s\S]*)$/;
var TOOL_EXIT_RE = /^\[tool\] exit (\S+)\s*$/;
var SYSTEM_RE = /^\[paperclip\]\s?([\s\S]*)$/;

var toolSeq = 0;
var openToolId = null;

function parseStdoutLine(line, ts) {
  var text = String(line == null ? "" : line).replace(/\r$/, "");
  if (!text.trim()) return [];

  var call = TOOL_CALL_RE.exec(text);
  if (call) {
    toolSeq += 1;
    openToolId = "minimax-tool-" + toolSeq;
    return [
      {
        kind: "tool_call",
        ts: ts,
        name: "bash",
        input: { command: call[1] },
        toolUseId: openToolId,
      },
    ];
  }

  var exit = TOOL_EXIT_RE.exec(text);
  if (exit) {
    var code = exit[1];
    var toolUseId = openToolId || "minimax-tool-" + (toolSeq + 1);
    openToolId = null;
    return [
      {
        kind: "tool_result",
        ts: ts,
        toolUseId: toolUseId,
        toolName: "bash",
        content: "exit " + code,
        isError: code !== "0",
      },
    ];
  }

  var system = SYSTEM_RE.exec(text);
  if (system) {
    return [{ kind: "system", ts: ts, text: system[1] }];
  }

  // Raw command output streamed between "[tool] $" and "[tool] exit" is not
  // assistant prose; keep it visible as plain stdout.
  if (openToolId !== null) {
    return [{ kind: "stdout", ts: ts, text: text }];
  }

  return [{ kind: "assistant", ts: ts, text: text }];
}

module.exports = { parseStdoutLine: parseStdoutLine };
