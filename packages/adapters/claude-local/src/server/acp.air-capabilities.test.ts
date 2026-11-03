import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { acpClientCapabilitiesForAgent } from "@paperclipai/adapter-utils/acpx-engine/execute";

// claude-agent-acp 0.100.0 switches into full JetBrains AIR client mode for ANY
// `_meta.jetbrains.air` declaration (changed-only tool-call `_meta`, no streamed
// subagent text, no rawInput on tool calls, AIR-only initialize capabilities).
// Paperclip advertises `jetbrains.air` only to opt into typed session failures,
// as it did on 0.73.0. The 0.100.0 patch narrows `isAirClient` so that a
// declaration whose only capability is `sessionFailure` is not an AIR client.
// These checks run against the installed, patched package that claude_local
// agents execute.
const requireClaudeAcp = createRequire(new URL("../../package.json", import.meta.url));
async function loadClaudeAcpModule(relativePath: string): Promise<Record<string, any>> {
  const resolved = requireClaudeAcp.resolve(`@agentclientprotocol/claude-agent-acp/${relativePath}`);
  return (await import(pathToFileURL(resolved).href)) as Record<string, any>;
}

const airExtension = await loadClaudeAcpModule("dist/air-extension.js");
const clientCapabilities = await loadClaudeAcpModule("dist/tool-calls/client-capabilities.js");
const sessionFailure = await loadClaudeAcpModule("dist/session-failure-extension.js");
const subagents = await loadClaudeAcpModule("dist/acp-subagents.js");
const claudeAcpPackage = requireClaudeAcp("@agentclientprotocol/claude-agent-acp/package.json") as {
  version: string;
};

function airDeclaration(air: Record<string, unknown>) {
  return { _meta: { jetbrains: { air } } };
}

describe("claude-agent-acp AIR client detection for Paperclip's ACPX host", () => {
  it("runs against the production claude_local lane", () => {
    expect(claudeAcpPackage.version).toBe("0.100.0");
  });

  it("keeps the typed-failure-only declaration out of AIR client mode", () => {
    const capabilities = acpClientCapabilitiesForAgent("claude");
    expect(capabilities).toEqual(airDeclaration({ version: 1, capabilities: ["sessionFailure"] }));

    expect(airExtension.isAirClient(capabilities)).toBe(false);
    const toolCallCapabilities = clientCapabilities.ClientCapabilities.from(capabilities);
    expect(toolCallCapabilities.air).toEqual({ client: false, rawInputRendering: false, planFile: false });
    expect(toolCallCapabilities.terminalOutput).toBe(false);
    expect(toolCallCapabilities.diffPatch).toBe(false);
    expect(subagents.subagentForm(capabilities)).toBeUndefined();

    // The one behaviour Paperclip opts into stays on.
    expect(sessionFailure.supportsAirSessionFailures(capabilities)).toBe(true);
  });

  it("matches an ACP client that sends no AIR declaration at all", () => {
    const plain = clientCapabilities.ClientCapabilities.from({});
    const paperclip = clientCapabilities.ClientCapabilities.from(acpClientCapabilitiesForAgent("claude"));
    expect(paperclip).toEqual(plain);
    expect(sessionFailure.supportsAirSessionFailures({})).toBe(false);
  });

  it("still treats a real JetBrains AIR declaration as an AIR client", () => {
    expect(airExtension.isAirClient(airDeclaration({ version: 1 }))).toBe(true);
    expect(airExtension.isAirClient(airDeclaration({ version: 1, capabilities: [] }))).toBe(true);
    expect(
      airExtension.isAirClient(airDeclaration({ version: 1, capabilities: ["sessionFailure", "diffPatch"] })),
    ).toBe(true);
    expect(
      clientCapabilities.ClientCapabilities.from(airDeclaration({ version: 1, capabilities: ["planFile"] })).air
        .client,
    ).toBe(true);
    expect(airExtension.isAirClient({})).toBe(false);
  });
});
