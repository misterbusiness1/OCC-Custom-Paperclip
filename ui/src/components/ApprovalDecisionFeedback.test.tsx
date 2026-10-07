// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useApprovalDecisionFeedback } from "./ApprovalDecisionActions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The inbox leaves for a hire's or a strategy's confirmation page only when no other row would lose
// something by it. This is the question it asks, on its own.
describe("useApprovalDecisionFeedback: is another request unsettled?", () => {
  let root: Root;
  let feedback!: ReturnType<typeof useApprovalDecisionFeedback>;

  function Harness() {
    feedback = useApprovalDecisionFeedback();
    return null;
  }

  beforeEach(() => {
    root = createRoot(document.createElement("div"));
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("answers yes while another decision is on its way, and no once it has landed", () => {
    expect(feedback.hasOthersUnsettled("hire")).toBe(false);
    act(() => {
      feedback.start("hire", "approve");
      feedback.start("other", "revision");
    });
    expect(feedback.hasOthersUnsettled("hire")).toBe(true);
    act(() => feedback.settle("other"));
    expect(feedback.hasOthersUnsettled("hire")).toBe(false);
    // The request's own decision never counts against it.
    expect(feedback.hasOthersUnsettled("other")).toBe(true);
  });

  it("answers yes while another request shows the error of a decision that failed", () => {
    act(() => {
      feedback.start("hire", "approve");
      feedback.start("other", "revision");
    });
    act(() => {
      feedback.settle("other", "Session expired");
      // Asked in the same moment, before the error has been drawn: the answer is already right.
      expect(feedback.hasOthersUnsettled("hire")).toBe(true);
      feedback.settle("hire");
    });
    expect(feedback.errors).toEqual({ other: "Session expired" });
    expect(feedback.hasOthersUnsettled("hire")).toBe(true);
    // Its own error does not hold back its own retry.
    expect(feedback.hasOthersUnsettled("other")).toBe(false);
  });

  it("answers no again once that error is gone: sent again, dismissed, or cleared with the rest", () => {
    const fail = (id: string) =>
      act(() => {
        feedback.start(id, "reject");
        feedback.settle(id, "Session expired");
      });

    // Sent again and landed.
    fail("other");
    expect(feedback.hasOthersUnsettled("hire")).toBe(true);
    act(() => {
      feedback.start("other", "reject");
    });
    act(() => feedback.settle("other"));
    expect(feedback.errors).toEqual({});
    expect(feedback.hasOthersUnsettled("hire")).toBe(false);

    // Dismissed, as when the board edits the note.
    fail("other");
    act(() => feedback.clearError("other"));
    expect(feedback.hasOthersUnsettled("hire")).toBe(false);

    // All errors cleared at once.
    fail("other");
    fail("third");
    act(() => feedback.clearErrors());
    expect(feedback.errors).toEqual({});
    expect(feedback.hasOthersUnsettled("hire")).toBe(false);
  });
});
