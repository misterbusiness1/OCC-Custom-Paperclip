import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { approvals } from "@paperclipai/db";

/**
 * The `updatedAt` an UPDATE of an approval writes. A client holds the version
 * as milliseconds, so every change must land on a later millisecond than the
 * stored one: the clock's time, or the stored millisecond plus one when the
 * clock has not moved past it. Computed inside the UPDATE, so it is atomic.
 */
export function nextApprovalUpdatedAt(now: Date) {
  return sql<Date>`greatest(${now.toISOString()}::timestamptz, date_trunc('milliseconds', ${approvals.updatedAt}) + interval '1 millisecond')`;
}

/** JSON with object keys in a fixed order, so equal content always gives equal text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * What the board reads when it decides an approval: its type, the stored payload and the
 * board's change request (`decisionNote`). Two versions of an approval with the same content
 * version show the same request. Computed from the stored (not the redacted) payload, so only the
 * server computes it; clients send back the value the API gave them.
 */
export function approvalContentVersion(approval: {
  type: string;
  payload: Record<string, unknown>;
  decisionNote: string | null;
}): string {
  return createHash("sha256")
    .update(stableJson({ type: approval.type, payload: approval.payload, decisionNote: approval.decisionNote ?? null }))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Whether an approval that moved from the status the reader saw to its current status still asks
 * the same thing. Only the requester's resubmission (sent back, then pending again) qualifies;
 * any other move (sent back by someone else, decided, cancelled) changes what a decision means.
 */
export function isSameRequestStatusMove(seenStatus: string, currentStatus: string): boolean {
  return seenStatus === currentStatus || (seenStatus === "revision_requested" && currentStatus === "pending");
}
