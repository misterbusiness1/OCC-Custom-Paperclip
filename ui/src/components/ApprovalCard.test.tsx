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

describe("ApprovalCard for requests without a source, hires and strategies", () => {
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

  it("notes a missing source once in the header line instead of an empty section", () => {
    render({ approval: createApproval() });

    const text = container.textContent ?? "";
    expect(text).toContain("Waiting 1 dayNo original request attached");
    expect(text).not.toContain("Original request");
    expect(text).not.toContain("was not retained");
    expect(container.querySelector("pre")).toBeNull();
    // Pros and risks the agent supplied are still shown.
    expect(text).toContain("Fixed monthly commitment.");
  });

  it("does not add the note when a source is attached or for other approval types", () => {
    render({
      approval: createApproval({
        payload: {
          title: "Approve staging hosting spend",
          recommendedAction: "Approve provider X.",
          reasoning: "It meets the request.",
          pros: ["Fixed cost."],
          risks: ["May rise."],
          originalRequest: { text: "Use provider X.", source: { kind: "external", sender: "Board" } },
        },
      }),
    });
    expect(container.textContent).not.toContain("No original request attached");
    expect(container.textContent).toContain("Original request");

    render({ approval: createApproval({ type: "hire_agent", payload: { name: "Pricing Analyst" } }) });
    expect(container.textContent).not.toContain("No original request attached");
  });

  it("shows who a hire is, what it runs on, what it may spend, and what each decision does", () => {
    render({
      approval: createApproval({
        type: "hire_agent",
        payload: {
          name: "Pricing Analyst",
          role: "researcher",
          title: "Senior Pricing Analyst",
          reportsTo: "agent-ceo",
          capabilities: "Tracks competitor prices weekly and flags changes above five percent.",
          adapterType: "claude_local",
          adapterConfig: { model: "claude-opus-5-5", apiKey: "must-never-render" },
          budgetMonthlyCents: 5000,
          desiredSkills: ["paperclip", "pricing-research", "s3", "s4", "s5", "s6", "s7"],
          agentId: "agent-pending",
        },
      }),
      resolveAgentName: (agentId) => (agentId === "agent-ceo" ? "Chief Executive" : null),
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });

    // The card is headed by the agent's name; the job title is one of the facts.
    expect(container.querySelector("h3")?.textContent).toBe("Pricing Analyst");
    expect(button("Approve")?.getAttribute("aria-label")).toBe("Approve: Pricing Analyst");
    const hire = container.querySelector("[data-approval-hire]")!;
    const facts = Object.fromEntries(
      [...hire.querySelectorAll("dl > div")].map((row) => [
        row.querySelector("dt")!.textContent,
        row.querySelector("dd")!.textContent,
      ]),
    );
    expect(facts).toMatchObject({
      Role: "Researcher",
      "Job title": "Senior Pricing Analyst",
      "Reports to": "Chief Executive",
      "Monthly budget": "$50.00",
    });
    expect(facts["Runs on"]).toContain("claude-opus-5-5");
    expect(hire.textContent).toContain("What it will doTracks competitor prices weekly");
    expect(hire.textContent).toContain("If approvedPricing Analyst is activated and can take work. Its monthly budget is set to $50.00.");
    expect(hire.textContent).toContain("If rejectedThe pending agent is terminated.");
    // Only the model name is read from the adapter configuration.
    expect(container.textContent).not.toContain("must-never-render");
    // The old one-line fallback is gone.
    expect(container.textContent).not.toContain("Why");

    expect(hire.querySelectorAll("li")).toHaveLength(6);
    act(() => button("+1 more")!.click());
    expect(hire.querySelectorAll("li")).toHaveLength(7);
  });

  it("leaves out hire facts the request does not carry, and never shows a raw agent id", () => {
    render({
      approval: createApproval({
        type: "hire_agent",
        payload: { name: "Pricing Analyst", title: "Pricing Analyst", reportsTo: "11111111-1111-4111-8111-111111111111", budgetMonthlyCents: 0 },
      }),
    });

    const hire = container.querySelector("[data-approval-hire]")!;
    const labels = [...hire.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Monthly budget"]);
    expect(hire.textContent).toContain("No monthly limit");
    expect(hire.textContent).not.toContain("11111111");
    expect(hire.textContent).toContain("The request does not describe the agent's work.");
    // No pending agent exists yet: approving creates it.
    expect(hire.textContent).toContain("Pricing Analyst is created and can take work.");
    expect(hire.textContent).not.toContain("monthly budget is set");
    // No pending agent exists yet, so a rejection terminates nothing.
    expect(hire.textContent).not.toContain("If rejected");
  });

  it("shows a strategy plan with its structure and expands a long one in place", () => {
    const plan = [
      "## Q4 strategy",
      "1. Grow wholesale.",
      "2. Cut returns.",
      "- Hire one **analyst**",
      "- Review `pricing_rules` weekly",
      "",
      "Line six.",
      "Line seven.",
      "Final line of the plan.",
    ].join("\n");
    render({ approval: createApproval({ type: "approve_ceo_strategy", payload: { plan } }) });

    const block = container.querySelector("[data-approval-plan]")!;
    const body = block.querySelector("p.whitespace-pre-line")!;
    expect(block.textContent).toContain("Plan");
    // Numbering, bullets and line breaks survive; markup characters do not, and identifiers keep their underscores.
    expect(body.textContent).toContain("Q4 strategy\n1. Grow wholesale.\n2. Cut returns.\n• Hire one analyst\n• Review pricing_rules weekly");
    expect(body.textContent).not.toContain("#");
    expect(body.textContent).not.toContain("**");
    expect(body.textContent).not.toContain("Final line of the plan.");
    expect(container.textContent).not.toContain("Why");

    act(() => button("Show full plan")!.click());
    expect(block.querySelector("p.whitespace-pre-line")!.textContent).toContain("Final line of the plan.");
    act(() => button("Show less")!.click());
    expect(block.querySelector("p.whitespace-pre-line")!.textContent).not.toContain("Final line of the plan.");
  });

  it("shows a short strategy plan whole, with no expander", () => {
    render({
      approval: createApproval({ type: "approve_ceo_strategy", payload: { plan: "1. Grow wholesale.\n2. Cut returns." } }),
    });
    expect(container.querySelector("[data-approval-plan] p.whitespace-pre-line")!.textContent).toBe(
      "1. Grow wholesale.\n2. Cut returns.",
    );
    expect(button("Show full plan")).toBeUndefined();
  });
});
