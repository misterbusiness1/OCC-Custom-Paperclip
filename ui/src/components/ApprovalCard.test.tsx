// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { ApprovalCard } from "./ApprovalCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-06T12:00:00.000Z");
const COMMENT_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {
      title: "Approve staging hosting spend",
      recommendedAction: "Approve provider X at the quoted monthly price.",
      reasoning: "Provider X meets every condition in the request.",
      pros: ["Fixed monthly commitment."],
      risks: ["The bill rises if traffic doubles."],
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-10-05T12:00:00.000Z"),
    updatedAt: new Date("2026-10-05T12:00:00.000Z"),
    ...overrides,
  };
}

describe("ApprovalCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = (props: Partial<ComponentProps<typeof ApprovalCard>> & { approval: Approval }) =>
    act(() => root.render(<ApprovalCard requesterAgent={null} {...props} />));
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  const click = (label: string) => act(() => button(label)!.click());
  const type = (value: string) =>
    act(() => {
      const textarea = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("shows the outgoing email draft before the decision buttons", () => {
    render({
      approval: createApproval({
        payload: {
          title: "Reply to wholesale request",
          recommendedAction: "Send the drafted reply.",
          reasoning: "Both answers are in the published terms.",
          pros: ["Answers both questions."],
          risks: ["The price list changes next month."],
          recipient: "buyer@example.test",
          subject: "Re: Wholesale price list",
          body: "Hi Sam,\n\nOur wholesale price list is attached.",
          originalRequest: {
            text: "Could you send your wholesale price list?",
            source: { kind: "external", channel: "Email", sender: "Sam Example", snapshotOrigin: "requester" },
          },
        },
      }),
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Email reply");
    const draft = container.querySelector("[data-approval-draft]")!;
    expect(draft.textContent).toContain("Tobuyer@example.test");
    expect(draft.textContent).toContain("SubjectRe: Wholesale price list");
    expect(draft.textContent).toContain("Our wholesale price list is attached.");
    // The verbatim source stays the only <pre>; the draft never fills that slot.
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre")?.textContent).toBe("Could you send your wholesale price list?");
    expect(text).toContain("Email · Sam Example · Requester-provided external source snapshot");
    expect(text.indexOf("Original request")).toBeLessThan(text.indexOf("Draft reply"));
    expect(text.indexOf("Draft reply")).toBeLessThan(text.indexOf("ApproveReject"));
  });

  it("approves at once and sends an optional note with the decision", () => {
    const onApprove = vi.fn();
    render({ approval: createApproval(), onApprove, onReject: vi.fn() });

    click("Approve");
    expect(onApprove).toHaveBeenLastCalledWith(undefined);

    click("Add a note");
    type("  Go ahead, month to month only.  ");
    click("Approve");
    expect(onApprove).toHaveBeenLastCalledWith("Go ahead, month to month only.");
  });

  it("names the approval in each decision button for assistive technology", () => {
    render({ approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), onRequestRevision: vi.fn() });

    expect(button("Approve")?.getAttribute("aria-label")).toBe("Approve: Approve staging hosting spend");
    expect(button("Request changes")?.getAttribute("aria-label")).toBe("Request changes: Approve staging hosting spend");
    expect(button("Reject")?.getAttribute("aria-label")).toBe("Reject: Approve staging hosting spend");
  });

  it("asks for confirmation before rejecting", () => {
    const onReject = vi.fn();
    render({ approval: createApproval(), onApprove: vi.fn(), onReject });

    click("Reject");
    expect(onReject).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Reject this request?");
    expect(button("Approve")?.disabled).toBe(true);

    click("Cancel");
    expect(container.textContent).not.toContain("Reject this request?");
    expect(onReject).not.toHaveBeenCalled();

    click("Reject");
    type("Outside this quarter's budget");
    click("Reject request");
    expect(onReject).toHaveBeenCalledExactlyOnceWith("Outside this quarter's budget");
  });

  it("requires a note before changes can be requested", () => {
    const onRequestRevision = vi.fn();
    render({ approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), onRequestRevision });

    click("Request changes");
    expect(button("Send request")?.disabled).toBe(true);
    type("   ");
    expect(button("Send request")?.disabled).toBe(true);
    type("Confirm where the data is stored");
    click("Send request");
    expect(onRequestRevision).toHaveBeenCalledExactlyOnceWith("Confirm where the data is stored");
  });

  it("offers Request changes only where it can be handled and only while pending", () => {
    render({ approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn() });
    expect(button("Request changes")).toBeUndefined();

    render({
      approval: createApproval({ status: "revision_requested" }),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
    });
    expect(button("Request changes")).toBeUndefined();
    expect(button("Approve")).toBeDefined();
  });

  it("expands long text and extra pros and risks in place", () => {
    const reasoning = `${"Provider X meets every condition in the request. ".repeat(8)}Final sentence.`;
    render({
      approval: createApproval({
        payload: {
          title: "Approve staging hosting spend",
          recommendedAction: "Approve provider X.",
          reasoning,
          pros: ["First pro.", "Second pro.", "Third pro."],
          risks: ["First risk."],
        },
      }),
    });

    expect(container.textContent).not.toContain("Final sentence.");
    click("Show more");
    expect(container.textContent).toContain("Final sentence.");
    click("Show less");
    expect(container.textContent).not.toContain("Final sentence.");

    expect(container.textContent).not.toContain("Third pro.");
    click("+1 more");
    expect(container.textContent).toContain("Third pro.");
  });

  it("links a Paperclip source back to its comment", () => {
    render({
      approval: createApproval({
        payload: {
          title: "Approve staging hosting spend",
          recommendedAction: "Approve provider X.",
          reasoning: "It meets the request.",
          pros: ["Fixed cost."],
          risks: ["May rise."],
          originalRequest: {
            text: "Use provider X if it stays under $50.",
            source: {
              kind: "paperclip_comment",
              commentId: COMMENT_ID,
              issueId: ISSUE_ID,
              snapshotOrigin: "server",
            },
          },
        },
      }),
    });

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "View comment");
    expect(link?.getAttribute("href")).toBe(`/issues/${ISSUE_ID}#comment-${COMMENT_ID}`);
    expect(container.textContent).toContain("Paperclip source snapshot");
  });

  it("shows linked tasks and how long the request has waited", () => {
    render({
      approval: createApproval({ createdAt: new Date("2026-09-27T12:00:00.000Z") }),
      linkedIssues: [{ id: ISSUE_ID, identifier: "DEMO-398", title: "Staging environment" }],
    });

    const chip = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "DEMO-398");
    expect(chip?.getAttribute("href")).toBe("/issues/DEMO-398");
    const waiting = [...container.querySelectorAll("span")].find((span) => span.textContent === "Waiting 9 days");
    expect(waiting?.className).toContain("text-amber-700");

    render({ approval: createApproval() });
    const recent = [...container.querySelectorAll("span")].find((span) => span.textContent === "Waiting 1 day");
    expect(recent?.className).not.toContain("text-amber-700");

    render({ approval: createApproval({ status: "approved" }) });
    expect(container.textContent).toContain("Created 1d ago");
    expect(container.textContent).not.toContain("Waiting");
  });

  it("decides from the keyboard only when shortcuts are enabled and focus is outside a text field", () => {
    const onApprove = vi.fn();
    const press = (key: string, target: Element) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true }));
      });

    render({ approval: createApproval(), onApprove, onReject: vi.fn(), onRequestRevision: vi.fn() });
    press("A", container.querySelector("[data-approval-card]")!);
    expect(onApprove).not.toHaveBeenCalled();

    render({
      approval: createApproval(),
      onApprove,
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
      enableShortcuts: true,
    });
    const card = container.querySelector<HTMLElement>("[data-approval-card]")!;
    expect(card.tabIndex).toBe(-1);

    press("X", card);
    expect(container.textContent).toContain("Reject this request?");
    press("A", container.querySelector("textarea")!);
    press("A", card);
    expect(onApprove).not.toHaveBeenCalled();

    click("Cancel");
    press("C", card);
    expect(button("Send request")).toBeDefined();
    click("Cancel");
    press("A", card);
    expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
