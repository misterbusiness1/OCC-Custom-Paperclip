export interface ToolGatewayAuditClassification {
  action: string;
  outcome: string;
}

/** This is the local access audit, not first-party telemetry or a tool call. */
const GATEWAY_AUDIT_CLASSIFICATIONS: Readonly<Record<string, ToolGatewayAuditClassification>> = {
  "tool_gateway.discovery": { action: "discovery", outcome: "success" },
  "tool_gateway.session_created": { action: "policy_decision", outcome: "success" },
  "tool_gateway.session_revoked": { action: "session_revoked", outcome: "success" },
  "tool_gateway.session_rejected": { action: "call_denied", outcome: "denied" },
  "tool_gateway.call_allowed": { action: "policy_decision", outcome: "success" },
  "tool_gateway.call_completed": { action: "call_completed", outcome: "success" },
  "tool_gateway.call_denied": { action: "call_denied", outcome: "denied" },
  "tool_gateway.call_failed": { action: "call_failed", outcome: "failure" },
  "tool_gateway.call_deferred": { action: "call_deferred", outcome: "pending" },
  "tool_gateway.approval_requested": { action: "approval_requested", outcome: "pending" },
  "tool_gateway.elicitation_requested": { action: "elicitation_requested", outcome: "pending" },
  "tool_gateway.runtime_mcp_delivery": { action: "runtime_diagnostic", outcome: "diagnostic" },
};

export function classifyToolGatewayAudit(action: string): ToolGatewayAuditClassification {
  // Unknown lifecycle events must never silently become successful failed calls.
  return Object.hasOwn(GATEWAY_AUDIT_CLASSIFICATIONS, action)
    ? GATEWAY_AUDIT_CLASSIFICATIONS[action]!
    : { action: "unclassified", outcome: "unknown" };
}

export interface DiagnosticConnectionProvenance {
  id: string;
  applicationKey: string | null;
  applicationMetadata: unknown;
}

export function runtimeMcpDiagnosticProvenance(
  connectionIds: readonly string[],
  persisted: readonly DiagnosticConnectionProvenance[],
) {
  const byId = new Map(persisted.map(row => [row.id, row]));
  const candidateIds: string[] = [];
  let productionCount = 0;
  let unknownCount = 0;
  for (const id of new Set(connectionIds)) {
    const row = byId.get(id);
    if (!row) { unknownCount += 1; continue; }
    const metadata = row.applicationMetadata;
    const marked = metadata !== null && typeof metadata === "object" &&
      !Array.isArray(metadata) && (metadata as Record<string, unknown>).smokeLab === true;
    if (marked && (row.applicationKey === "paperclip.smoke-lab.http-fixture" ||
                   row.applicationKey === "paperclip.smoke-lab.stdio-fixture")) candidateIds.push(id);
    else productionCount += 1;
  }
  const categories = Number(candidateIds.length > 0) + Number(productionCount > 0) + Number(unknownCount > 0);
  const auditScope = categories > 1 ? "mixed" : candidateIds.length > 0 ? "fixture_candidate" :
    productionCount > 0 ? "production" : "unknown";
  return {
    auditScope,
    provenance: "persisted_application_metadata",
    fixtureCandidateConnectionIds: candidateIds.sort(),
    unresolvedConnectionCount: unknownCount,
    // Mutable catalog metadata is not trusted to suppress production failures.
    fixtureScopeAuthoritative: false,
  };
}
