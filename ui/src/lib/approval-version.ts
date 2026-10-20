import type { Approval } from "@paperclipai/shared";

/**
 * The version of an approval a decision is made for: its `updatedAt` as the page holds it when
 * the button is pressed. The server refuses the decision with 409 when the approval has changed
 * since (resubmitted, sent back, decided), so a request is never decided in a version the reader
 * did not have in front of them.
 */
export type ApprovalVersion =
  | Approval["updatedAt"]
  | string
  | Pick<Approval, "updatedAt" | "status" | "contentVersion">;

/**
 * The version of an approval as a decision should send it: its `updatedAt`, and, from a server
 * that gives one, its `contentVersion` and `status`. With those the server still decides a
 * request that was resubmitted unchanged since the page read it, instead of answering 409.
 */
export function approvalVersionOf(approval: Pick<Approval, "updatedAt" | "status" | "contentVersion">): ApprovalVersion {
  // From an older server (no content version) the version is the time alone, exactly as before.
  if (!approval.contentVersion) return approval.updatedAt;
  return { updatedAt: approval.updatedAt, status: approval.status, contentVersion: approval.contentVersion };
}

/** What the server said about the approval when it refused a decision made for an older version. */
export type ApprovalVersionConflict = {
  /** The status the approval has now, or null when the answer did not carry one. */
  currentStatus: string | null;
  /** When the approval last changed, as an ISO string, or null. */
  currentUpdatedAt: string | null;
};

const CONFLICT_CODE = "approval_version_conflict";

/**
 * The conflict behind a failed decision, or null when the error is something else. Read from the
 * error's shape (`status` 409 and the code in its body), so it works on any error the API client throws.
 */
export function approvalVersionConflict(error: unknown): ApprovalVersionConflict | null {
  if (!error || typeof error !== "object") return null;
  const { status, body } = error as { status?: unknown; body?: unknown };
  if (status !== 409 || !body || typeof body !== "object") return null;
  const { code, details } = body as { code?: unknown; details?: unknown };
  if (code !== CONFLICT_CODE) return null;
  const read = (key: string) => {
    const value = details && typeof details === "object" ? (details as Record<string, unknown>)[key] : null;
    return typeof value === "string" ? value : null;
  };
  return { currentStatus: read("currentStatus"), currentUpdatedAt: read("currentUpdatedAt") };
}

export function isApprovalVersionConflict(error: unknown): boolean {
  return approvalVersionConflict(error) !== null;
}

/**
 * The version as the request field `expectedUpdatedAt`: the ISO string the API gave. Undefined for
 * no version or one that is not a time; the field is then left out and the server does not check.
 */
export function expectedUpdatedAtField(version: ApprovalVersion | null | undefined): string | undefined {
  if (version === null || version === undefined) return undefined;
  const at = typeof version === "object" && !(version instanceof Date) ? version.updatedAt : version;
  const time = new Date(at).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * The version as the request fields: `expectedUpdatedAt`, and `expectedContentVersion` with
 * `expectedStatus` when the version carries both. Empty when there is no usable time; the server
 * then does not check.
 */
export function expectedVersionFields(version: ApprovalVersion | null | undefined): {
  expectedUpdatedAt?: string;
  expectedContentVersion?: string;
  expectedStatus?: string;
} {
  const expectedUpdatedAt = expectedUpdatedAtField(version);
  if (expectedUpdatedAt === undefined) return {};
  if (version && typeof version === "object" && !(version instanceof Date)) {
    const { contentVersion, status } = version;
    if (typeof contentVersion === "string" && contentVersion.length > 0 && typeof status === "string") {
      return { expectedUpdatedAt, expectedContentVersion: contentVersion, expectedStatus: status };
    }
  }
  return { expectedUpdatedAt };
}
