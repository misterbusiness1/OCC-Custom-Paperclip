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
