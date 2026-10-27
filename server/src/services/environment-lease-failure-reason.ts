/** Known non-secret run categories, never arbitrary provider error text. */
const SAFE_RUN_FAILURE_CODES = new Set([
  "acpx_turn_failed",
  "codex_transient_upstream",
  "adapter_failed",
  "adapter_timeout",
  "environment_setup_failed",
  "setup_failed",
  "process_lost",
  "server_shutdown_interrupted",
  "issue_execution_lock_changed",
  "issue_reassigned",
  "issue_dependencies_blocked",
  "secret_binding_missing",
  "missing_secret",
]);

/**
 * Error codes can originate in adapters and are not safe merely because they
 * look like identifiers. Only known constant codes leave this boundary; a raw
 * message, token-shaped value or unknown provider code becomes a fixed category.
 */
export function environmentLeaseFailureReason(input: {
  status?: string | null;
  errorCode?: unknown;
} | null | undefined): string {
  if (typeof input?.errorCode === "string" && SAFE_RUN_FAILURE_CODES.has(input.errorCode)) {
    return input.errorCode;
  }
  switch (input?.status) {
    case "timed_out": return "run_timed_out";
    case "cancelled": return "run_cancelled";
    case "interrupted": return "run_interrupted";
    default: return "run_failed";
  }
}
