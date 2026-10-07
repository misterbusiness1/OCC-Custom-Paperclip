// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// Counts every conversion of agent-written text, and records how much text each one was given.
vi.mock("../lib/approval-readable-text", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/approval-readable-text")>();
  return { ...original, approvalReadableText: vi.fn(original.approvalReadableText) };
});

import { approvalReadableText } from "../lib/approval-readable-text";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalDecisionSummary } from "./ApprovalDecisionSummary";
import { APPROVAL_TITLE_LENGTH, approvalAskLine, approvalExcerpt, approvalSummaryText } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const conversions = vi.mocked(approvalReadableText);

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  } as Approval;
}

describe("the cost of an approval's text", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rerender: () => void;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    conversions.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** Draws the element under a parent that can be drawn again with nothing changed, as a list does on hover. */
  function renderUnderParent(element: React.ReactElement) {
    function Parent() {
      const [, setTick] = useState(0);
      rerender = () => setTick((tick) => tick + 1);
      return element.type ? <element.type {...(element.props as object)} /> : null;
    }
    act(() => root.render(<Parent />));
  }

  const boardPayload = {
    title: "Renew the hosting contract",
    summary: "Estimated cost is **$42**/month.",
    recommendedAction: "Approve [provider X](https://example.test/x).",
    reasoning: "It meets every condition.",
    pros: ["Cheaper", "Faster"],
    risks: ["Lock-in"],
    nextActionOnApproval: "Sign the order form.",
  };

  it.each([
    ["a Board approval", "request_board_approval", boardPayload, "Estimated cost is $42/month."],
    ["a hire", "hire_agent", { name: "Pricing Analyst", capabilities: "Tracks **competitor** prices weekly." }, "Tracks competitor prices weekly."],
    ["a strategy", "approve_ceo_strategy", { plan: "1. Grow wholesale.\n2. Cut returns.", reasoning: "Margins are thin." }, "1. Grow wholesale."],
    ["a strategy with no plan", "approve_ceo_strategy", { reasoning: "Margins are **thin**." }, "Margins are thin."],
  ])("converts the text of %s once, not again on every render", (_name, type, payload, shown) => {
    renderUnderParent(<ApprovalDecisionSummary type={type} payload={payload} status="pending" requestedByAgentId="agent-1" />);
    expect(container.textContent).toContain(shown);
    const afterFirstRender = conversions.mock.calls.length;
    expect(afterFirstRender).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) act(() => rerender());
    expect(conversions.mock.calls.length).toBe(afterFirstRender);
  });

  it("converts a closed queue row's title and ask line once", () => {
    const approval = createApproval({ payload: boardPayload });
    renderUnderParent(<ApprovalCard approval={approval} requesterAgent={null} collapsible open={false} onOpenChange={() => {}} />);
    expect(container.textContent).toContain("Renew the hosting contract");
    expect(container.textContent).toContain("Approve provider X (https://example.test/x).");
    const afterFirstRender = conversions.mock.calls.length;
    expect(afterFirstRender).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) act(() => rerender());
    expect(conversions.mock.calls.length).toBe(afterFirstRender);
  });

  it("gives a one-line excerpt only the start of a very long text to convert", () => {
    const long = `Approve the [price list](https://example.test/prices) for the wholesale portal. ${"More detail follows here. ".repeat(60_000)}`;
    expect(long.length).toBeGreaterThan(1_000_000);

    const title = approvalExcerpt(long, APPROVAL_TITLE_LENGTH)!;
    expect(title.startsWith("Approve the price list (https://example.test/prices) for the wholesale portal.")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(APPROVAL_TITLE_LENGTH + 1);
    // The same excerpt as the whole text gives.
    conversions.mockClear();
    expect(approvalExcerpt(long, APPROVAL_TITLE_LENGTH)).toBe(title);
    expect(approvalAskLine("request_board_approval", { recommendedAction: long })!.text.endsWith("…")).toBe(true);
    for (const [given] of conversions.mock.calls) expect((given as string).length).toBeLessThan(5_000);

    // A text cut before conversion is never passed off as whole, even when markup shrinks it below the limit.
    const mostlyMarkup = `Short.\n${"---\n".repeat(2_000)}The amount is $9,000.`;
    expect(approvalExcerpt(mostlyMarkup, 120)).toBe("Short.…");
    // The whole text is still converted where the whole text is shown.
    conversions.mockClear();
    expect(approvalExcerpt("word ".repeat(5_000), Number.POSITIVE_INFINITY)).toBe("word ".repeat(5_000).trim());
    expect((conversions.mock.calls[0][0] as string).length).toBe(25_000);
  });

  it("shows a very long summary without comparing it, and never compares only its start", () => {
    const recommendation = `Approve provider X. ${"The terms are unchanged. ".repeat(1_000)}`;
    // Shares the recommendation's first 25,000 characters and then adds the cost.
    const summary = `${recommendation}It costs $9,000 a month.`;
    expect(summary.length).toBeGreaterThan(20_000);

    conversions.mockClear();
    expect(
      approvalSummaryText(
        { title: "Hosting", summary, recommendedAction: recommendation, reasoning: "It meets every condition." },
        "request_board_approval",
      ),
    ).toBe(summary);
    expect(conversions).not.toHaveBeenCalled();

    // Below the limit the whole texts are compared, as before.
    const short = "Approve provider X. It costs $9,000 a month.";
    const brief = { title: "Hosting", recommendedAction: "Approve provider X.", reasoning: "It meets every condition." };
    expect(approvalSummaryText({ ...brief, summary: short })).toBe(short);
    expect(approvalSummaryText({ ...brief, summary: "**Approve** provider X." })).toBeNull();
  });
});
