import type { Approval } from "@paperclipai/shared";

/**
 * The version of an approval a decision is made for: its `updatedAt` as the page holds it when
 * the button is pressed. The server refuses the decision with 409 when the approval has changed
 * since (resubmitted, sent back, decided), so a request is never decided in a version the reader
 * did not have in front of them.
 */
export type ApprovalVersion = Approval["updatedAt"] | string;

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
  const time = new Date(version).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
