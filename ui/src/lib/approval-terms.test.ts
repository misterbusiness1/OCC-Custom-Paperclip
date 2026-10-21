import { describe, expect, it } from "vitest";
import {
  approvalCost,
  approvalDecideBy,
  compareByCost,
  compareByDecideBy,
  decideByState,
  decideByText,
  formatApprovalCost,
  formatDecideBy,
} from "./approval-terms";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const HOUR = 3_600_000;

describe("approval terms", () => {
  it("reads a cost and a deadline only in the documented shape", () => {
    expect(approvalCost({ cost: { amount: 42, currency: "USD", period: "month" } })).toEqual({ amount: 42, currency: "USD", period: "month" });
    expect(approvalCost({ cost: "$42/month" })).toBeNull();
    expect(approvalCost({ cost: { amount: 42, currency: "usd" } })).toEqual({ amount: 42, currency: "USD" });
    expect(approvalCost({ cost: { amount: "42", currency: "USD" } })).toBeNull();
    expect(approvalCost({})).toBeNull();
    expect(approvalCost(null)).toBeNull();
    expect(approvalDecideBy({ decideBy: "2026-10-24T17:00:00Z" })?.toISOString()).toBe("2026-10-24T17:00:00.000Z");
    expect(approvalDecideBy({ decideBy: "Friday" })).toBeNull();
    expect(approvalDecideBy({ decideBy: "2026-10-24" })).toBeNull();
  });

  it("formats a cost with its currency and period", () => {
    expect(formatApprovalCost({ amount: 42, currency: "USD", period: "month" })).toMatch(/42.*\/ month$/);
    expect(formatApprovalCost({ amount: 1200, currency: "EUR", period: "year" })).toMatch(/\/ year$/);
    expect(formatApprovalCost({ amount: 5, currency: "USD", period: "one_time" })).toMatch(/one-time$/);
  });

  it("says how a deadline stands", () => {
    expect(decideByState(new Date(NOW - 1), NOW)).toBe("overdue");
    expect(decideByState(new Date(NOW + 3 * HOUR), NOW)).toBe("soon");
    expect(decideByState(new Date(NOW + 30 * HOUR), NOW)).toBe("later");
    expect(decideByText(new Date(NOW - 2 * HOUR), NOW)).toBe("Deadline passed 2 h ago");
    expect(decideByText(new Date(NOW + 3 * HOUR), NOW)).toBe("Decide within 3 h");
    expect(decideByText(new Date(NOW + 20 * 60_000), NOW)).toBe("Decide within 20 min");
    expect(decideByText(new Date(NOW + 5 * 24 * HOUR), NOW)).toMatch(/^Decide by .*2026/);
    expect(formatDecideBy(new Date(NOW))).toMatch(/UTC|GMT|[A-Z]{2,5}/);
  });

  it("orders by deadline soonest first and by cost highest first, with requests without one last", () => {
    const soon = { decideBy: "2026-10-21T00:00:00Z" };
    const late = { decideBy: "2026-10-30T00:00:00Z" };
    const none = {};
    expect([late, none, soon].sort(compareByDecideBy)).toEqual([soon, late, none]);
    const cheap = { cost: { amount: 1, currency: "USD" } };
    const pricey = { cost: { amount: 100, currency: "USD" } };
    expect([cheap, none, pricey].sort(compareByCost)).toEqual([pricey, cheap, none]);
  });
});
