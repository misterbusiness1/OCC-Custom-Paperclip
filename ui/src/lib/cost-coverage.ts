import type { CostSummary } from "@paperclipai/shared";

/** Explain ledger coverage without turning absent prices into zero-dollar bills. */
export function costCoverageMessages(coverage: NonNullable<CostSummary["costCoverage"]>): string[] {
  const messages: string[] = [];
  const events = (count: number) => `${count.toLocaleString()} ${count === 1 ? "event" : "events"}`;
  if (coverage.unpricedNonIncludedEventCount > 0) {
    messages.push(
      `${events(coverage.unpricedNonIncludedEventCount)} outside included subscription capacity ${coverage.unpricedNonIncludedEventCount === 1 ? "has" : "have"} no reported price. Recorded spend is incomplete; billed-cost caps cannot account for those amounts.`,
    );
  }
  if (coverage.subscriptionIncludedEventCount > 0) {
    messages.push(
      `${events(coverage.subscriptionIncludedEventCount)} ${coverage.subscriptionIncludedEventCount === 1 ? "is" : "are"} recorded as included subscription usage. A zero incremental charge does not include plan fees; record invoices and credits in Finance. Provider quota limits remain separate.`,
    );
  }
  if (coverage.unknownBillingEventCount > 0) {
    messages.push(`${events(coverage.unknownBillingEventCount)} ${coverage.unknownBillingEventCount === 1 ? "has" : "have"} an unknown billing route.`);
  }
  if (coverage.unknownModelEventCount > 0) {
    messages.push(`${events(coverage.unknownModelEventCount)} ${coverage.unknownModelEventCount === 1 ? "has" : "have"} no reported model.`);
  }
  return messages;
}
