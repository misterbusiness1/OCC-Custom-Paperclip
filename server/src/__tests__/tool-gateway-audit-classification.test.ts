import { describe, expect, it } from "vitest";
import { classifyToolGatewayAudit, runtimeMcpDiagnosticProvenance } from "../services/tool-gateway-audit-classification.js";

describe("gateway audit semantics", () => {
  it.each([
    ["discovery", "discovery", "success"],
    ["session_created", "policy_decision", "success"],
    ["session_revoked", "session_revoked", "success"],
    ["session_rejected", "call_denied", "denied"],
    ["call_allowed", "policy_decision", "success"],
    ["call_completed", "call_completed", "success"],
    ["call_denied", "call_denied", "denied"],
    ["call_failed", "call_failed", "failure"],
    ["call_deferred", "call_deferred", "pending"],
    ["approval_requested", "approval_requested", "pending"],
    ["elicitation_requested", "elicitation_requested", "pending"],
    ["runtime_mcp_delivery", "runtime_diagnostic", "diagnostic"],
  ])("classifies %s without fall-through", (source, action, outcome) => {
    expect(classifyToolGatewayAudit(`tool_gateway.${source}`)).toEqual({ action, outcome });
  });
  it("does not claim a new unknown event is successful or a failed call", () => {
    expect(classifyToolGatewayAudit("tool_gateway.future_event")).toEqual({ action: "unclassified", outcome: "unknown" });
  });
  it("does not echo unknown event input into its classification", () => {
    expect(JSON.stringify(classifyToolGatewayAudit("Bearer synthetic-private-value"))).not.toContain("synthetic-private");
  });
  it.each(["toString", "constructor", "__proto__"])("rejects inherited map key %s", action => {
    expect(classifyToolGatewayAudit(action)).toEqual({ action: "unclassified", outcome: "unknown" });
  });
});

describe("runtime MCP diagnostic provenance", () => {
  const fixture = { id: "fixture", applicationKey: "paperclip.smoke-lab.http-fixture", applicationMetadata: { smokeLab: true } };
  const production = { id: "production", applicationKey: "real-application", applicationMetadata: {} };
  it("records an explicitly marked fixture candidate without making it authoritative", () => {
    expect(runtimeMcpDiagnosticProvenance([fixture.id], [fixture])).toMatchObject({ auditScope: "fixture_candidate", fixtureCandidateConnectionIds: [fixture.id], fixtureScopeAuthoritative: false });
  });
  it("records production and mixed provenance separately", () => {
    expect(runtimeMcpDiagnosticProvenance([production.id], [production]).auditScope).toBe("production");
    expect(runtimeMcpDiagnosticProvenance([fixture.id, production.id], [fixture, production]).auditScope).toBe("mixed");
  });
  it("does not infer fixture provenance from an application name, key or arbitrary context alone", () => {
    const spoofed = { id: "spoof", applicationKey: fixture.applicationKey, applicationMetadata: { name: "Smoke Lab fixture", contextSnapshot: { fixture: true }, smokeLab: "true" } };
    expect(runtimeMcpDiagnosticProvenance([spoofed.id], [spoofed]).auditScope).toBe("production");
    expect(classifyToolGatewayAudit("tool_gateway.call_failed")).toEqual({ action: "call_failed", outcome: "failure" });
  });
  it("does not let a mutable fixture candidate turn a real invocation failure into a diagnostic", () => {
    expect(runtimeMcpDiagnosticProvenance([fixture.id], [fixture]).fixtureScopeAuthoritative).toBe(false);
    expect(classifyToolGatewayAudit("tool_gateway.call_failed")).toEqual({ action: "call_failed", outcome: "failure" });
  });
  it("retains unknown and mixed-with-unknown scopes rather than silently assuming production", () => {
    expect(runtimeMcpDiagnosticProvenance(["missing"], []).auditScope).toBe("unknown");
    expect(runtimeMcpDiagnosticProvenance([fixture.id, "missing"], [fixture])).toMatchObject({ auditScope: "mixed", unresolvedConnectionCount: 1 });
  });
  it("deduplicates known IDs without accepting rows for unrequested connections", () => {
    expect(runtimeMcpDiagnosticProvenance([production.id, production.id], [production, fixture])).toMatchObject({ auditScope: "production", fixtureCandidateConnectionIds: [], unresolvedConnectionCount: 0 });
  });
});
