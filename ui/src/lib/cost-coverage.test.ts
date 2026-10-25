import { describe, expect, it } from "vitest";
import { costCoverageMessages } from "./cost-coverage";

const complete = {
  eventCount: 1, unpricedEventCount: 0, unpricedNonIncludedEventCount: 0,
  subscriptionIncludedEventCount: 0, unknownBillingEventCount: 0, unknownModelEventCount: 0,
};

describe("cost coverage disclosure", () => {
  it("does not describe unpriced included subscription usage as missing metered spend", () => {
    const messages = costCoverageMessages({
      ...complete, unpricedEventCount: 1, subscriptionIncludedEventCount: 1,
    });
    expect(messages.join(" ")).toContain("recorded as included subscription usage");
    expect(messages.join(" ")).toContain("zero incremental charge does not include plan fees");
    expect(messages.join(" ")).toContain("Provider quota limits remain separate");
    expect(messages.join(" ")).not.toContain("Recorded spend is incomplete");
  });

  it("warns about missing billed amounts independently of subscription usage", () => {
    const text = costCoverageMessages({
      ...complete, eventCount: 2, unpricedEventCount: 2,
      unpricedNonIncludedEventCount: 1, subscriptionIncludedEventCount: 1,
    }).join(" ");
    expect(text).toContain("Recorded spend is incomplete");
    expect(text).toContain("billed-cost caps cannot account");
    expect(text).toContain("plan fees");
  });

  it("discloses unknown attribution without inferring a model, route or price", () => {
    expect(costCoverageMessages({
      ...complete, unknownBillingEventCount: 1, unknownModelEventCount: 1,
    })).toEqual([
      "1 event has an unknown billing route.",
      "1 event has no reported model.",
    ]);
  });

  it("does not warn when recorded events have complete attribution and prices", () => {
    expect(costCoverageMessages(complete)).toEqual([]);
  });
});
