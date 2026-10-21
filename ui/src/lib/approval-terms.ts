import { approvalCostSchema, approvalDecideBySchema, type ApprovalCostPeriod } from "@paperclipai/shared";

/**
 * The typed terms a request can carry in its payload: what approving costs (`cost`) and the time
 * by which the board must decide (`decideBy`). Read only when they have the documented shape; a
 * request without them, or with a value of another shape, simply has none.
 */
export type ApprovalCost = { amount: number; currency: string; period?: ApprovalCostPeriod };

export function approvalCost(payload?: Record<string, unknown> | null): ApprovalCost | null {
  const parsed = approvalCostSchema.safeParse(payload?.cost);
  return parsed.success ? parsed.data : null;
}

export function approvalDecideBy(payload?: Record<string, unknown> | null): Date | null {
  const parsed = approvalDecideBySchema.safeParse(payload?.decideBy);
  if (!parsed.success) return null;
  const date = new Date(parsed.data);
  return Number.isNaN(date.getTime()) ? null : date;
}

const PERIOD_SUFFIX: Record<ApprovalCostPeriod, string> = { one_time: " one-time", month: " / month", year: " / year" };

export function formatApprovalCost(cost: ApprovalCost): string {
  let amount: string;
  try {
    amount = new Intl.NumberFormat(undefined, { style: "currency", currency: cost.currency }).format(cost.amount);
  } catch {
    amount = `${cost.amount} ${cost.currency}`;
  }
  return `${amount}${cost.period ? PERIOD_SUFFIX[cost.period] : ""}`;
}

/** Within this time of its deadline a request is due soon. */
export const DECIDE_BY_SOON_MS = 24 * 60 * 60 * 1000;

export type DecideByState = "overdue" | "soon" | "later";

export function decideByState(decideBy: Date, now: number): DecideByState {
  const left = decideBy.getTime() - now;
  if (left <= 0) return "overdue";
  return left <= DECIDE_BY_SOON_MS ? "soon" : "later";
}

function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** The deadline as a date and time with the reader's time zone named, as board members may be in several. */
export function formatDecideBy(decideBy: Date): string {
  // Explicit fields: dateStyle and timeStyle cannot be combined with timeZoneName (Intl throws).
  return decideBy.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

/** "Decide within 3 h", "Deadline passed 2 h ago", or "Decide by" and the date. */
export function decideByText(decideBy: Date, now: number): string {
  const left = decideBy.getTime() - now;
  if (left <= 0) return `Deadline passed ${spanText(-left)} ago`;
  if (left <= DECIDE_BY_SOON_MS) return `Decide within ${spanText(left)}`;
  return `Decide by ${formatDecideBy(decideBy)}`;
}

/**
 * Orders requests by deadline, soonest (or most overdue) first; requests without one come after,
 * in the order the caller's tie-breaker gives.
 */
export function compareByDecideBy(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): number {
  const da = approvalDecideBy(a);
  const db = approvalDecideBy(b);
  if (da && db) return da.getTime() - db.getTime();
  if (da) return -1;
  if (db) return 1;
  return 0;
}

/**
 * Orders requests by cost, highest first; requests without one come after. Amounts in different
 * currencies are compared as numbers: the order is a reading aid, not a conversion.
 */
export function compareByCost(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): number {
  const ca = approvalCost(a);
  const cb = approvalCost(b);
  if (ca && cb) return cb.amount - ca.amount;
  if (ca) return -1;
  if (cb) return 1;
  return 0;
}
