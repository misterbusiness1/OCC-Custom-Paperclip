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
import { ApprovalDecisionSummary } from "./ApprovalDecisionSummary";
import {
  approvalDraftPreview,
  approvalExcerpt,
  approvalReadableText,
  approvalStrategyPlan,
  approvalTextPreview,
  stripLeadingListMarker,
} from "./ApprovalPayload";

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
    requestedByAgentId: "agent-requester",
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

/** The part of an outgoing draft a five-line or 1,500-character cut would hide. */
const DRAFT_ENDING = "We will ship the same day and split the order at no extra charge.";

/** An email body of exactly `length` characters that ends with the commitment above. */
function emailDraftBody(length: number): string {
  const opening = "Hi Sam,\n\nThank you for your message. ";
  const filler = "Our wholesale terms are in the attached price list. ";
  const room = length - opening.length - DRAFT_ENDING.length - 2;
  return `${opening}${filler.repeat(Math.ceil(room / filler.length)).slice(0, room)}\n\n${DRAFT_ENDING}`;
}

function emailPayload(body: string) {
  return {
    title: "Reply to wholesale request",
    recommendedAction: "Send the drafted reply.",
    reasoning: "Nothing in the reply commits to a delivery date.",
    pros: ["Answers both questions."],
    risks: ["The price list changes next month."],
    recipient: "buyer@example.test",
    subject: "Re: Wholesale price list",
    body,
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

  it("keeps the characters that carry meaning in the recommendation, why, pros, risks and next action", () => {
    render({
      approval: createApproval({
        payload: {
          title: "Approve the price sync",
          recommendedAction: "Run deploy_prod_v2 against orders_2026_q4 for ~$42/month.",
          reasoning: "Margin is 3 * 12 = 36, which is > 30%. See [the diff](https://example.test/price_list_v2.pdf).",
          pros: ["+ 12% conversion on pricing_rules"],
          risks: ["> 5 minutes of stale prices in ~/cache"],
          nextActionOnApproval: "Set SYNC__ENABLED and call __init__ in pricing__rules.py.",
        },
      }),
    });

    const text = container.textContent ?? "";
    expect(text).toContain("RecommendationRun deploy_prod_v2 against orders_2026_q4 for ~$42/month.");
    expect(text).toContain("Margin is 3 * 12 = 36, which is > 30%.");
    // A link keeps its target: where it points can be what the board is approving.
    expect(text).toContain("See the diff (https://example.test/price_list_v2.pdf).");
    expect(text).toContain("+ 12% conversion on pricing_rules");
    expect(text).toContain("> 5 minutes of stale prices in ~/cache");
    expect(text).toContain("If approvedSet SYNC__ENABLED and call __init__ in pricing__rules.py.");
    // Agent-written text stays plain text: no link, emphasis or other markup is built from it.
    expect(container.querySelector("a[href^='https://example.test']")).toBeNull();
    expect(container.querySelector(".paperclip-markdown")).toBeNull();
  });

  it("keeps the line breaks of short multi-line text, with nothing to expand", () => {
    render({
      approval: createApproval({
        payload: {
          title: "Approve the price page",
          recommendedAction: "1. Publish the page.\n2. Tell support.",
          reasoning: "- Prices match the approved sheet\n- Legal signed off\n\nThe old page 404s on mobile.",
          pros: ["Fixed cost."],
          risks: ["May rise."],
          nextActionOnApproval: "**Publish** today.\nReview on Monday.",
        },
      }),
    });

    const paragraphs = [...container.querySelectorAll("p.whitespace-pre-wrap")].map((p) => p.textContent);
    expect(paragraphs).toEqual([
      "1. Publish the page.\n2. Tell support.",
      "\u2022 Prices match the approved sheet\n\u2022 Legal signed off\n\nThe old page 404s on mobile.",
      "Publish today.\nReview on Monday.",
    ]);
    expect(button("Show more")).toBeUndefined();
  });

  it("previews long multi-line text by its first lines and expands it in place", () => {
    const reasoning = ["First reason.", "Second reason.", "Third reason.", "Fourth reason.", "Fifth and final reason."].join("\n");
    render({
      approval: createApproval({
        payload: {
          title: "Approve the price page",
          recommendedAction: "Publish the page.",
          reasoning,
          pros: ["Fixed cost."],
          risks: ["May rise."],
        },
      }),
    });

    const why = () => [...container.querySelectorAll("p.whitespace-pre-wrap")].map((p) => p.textContent)[1];
    expect(why()).toBe("First reason.\nSecond reason.\nThird reason.\u2026");
    expect(button("Show more")?.getAttribute("aria-expanded")).toBe("false");
    click("Show more");
    expect(why()).toBe(reasoning);
    expect(button("Show less")?.getAttribute("aria-expanded")).toBe("true");
    click("Show less");
    expect(why()).toBe("First reason.\nSecond reason.\nThird reason.\u2026");
  });

  it("shows a fourth line instead of a control that would reveal only that line", () => {
    const reasoning = "First reason.\nSecond reason.\nThird reason.\nFourth and final reason.";
    render({
      approval: createApproval({
        payload: { title: "Approve the price page", recommendedAction: "Publish.", reasoning, pros: ["A."], risks: ["B."] },
      }),
    });

    expect(container.textContent).toContain("Fourth and final reason.");
    expect(button("Show more")).toBeUndefined();
  });

  it("shows each pro and risk beside one bullet, without the item's own list marker", () => {
    render({
      approval: createApproval({
        payload: {
          title: "Approve the price page",
          recommendedAction: "Publish the page.",
          reasoning: "It is ready.",
          pros: ["- **Dash** pro.", "* Star pro."],
          risks: ["1. Cached copies stay stale for an hour.", "2) Second numbered risk.", "\u2022 Dot risk.", "1.5x the cost of today"],
        },
      }),
    });

    click("+2 more");
    const items = [...container.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([
      "Dash pro.",
      "Star pro.",
      "Cached copies stay stale for an hour.",
      "Second numbered risk.",
      "Dot risk.",
      "1.5x the cost of today",
    ]);
  });

  it("keeps every marker of a risk that is itself a list, on separate lines", () => {
    render({
      approval: createApproval({
        payload: {
          title: "Approve the price page",
          recommendedAction: "Publish the page.",
          reasoning: "It is ready.",
          pros: ["Fixed cost."],
          // One string, not an array: the agent wrote its risks as a numbered list.
          risks: "1. Cached copies stay stale.\n2. Support is not briefed.\n3. No rollback.",
        },
      }),
    });

    const risk = () => [...container.querySelectorAll("li")].at(-1)!;
    expect(risk().textContent).toBe("1. Cached copies stay stale.\n2. Support is not briefed.\n3. No rollback.");
    expect(risk().querySelector("span.whitespace-pre-wrap")).not.toBeNull();

    // A marked item with detail lines under it is one item: its own marker goes, the detail keeps its place.
    render({
      approval: createApproval({
        payload: {
          title: "Approve the price page",
          recommendedAction: "Publish the page.",
          reasoning: "It is ready.",
          pros: ["Fixed cost."],
          risks: ["- Cached copies stay stale.\n  - for up to an hour\n  - on mobile only"],
        },
      }),
    });
    expect(risk().textContent).toBe("Cached copies stay stale.\n  \u2022 for up to an hour\n  \u2022 on mobile only");
  });

  it("previews a long original request behind a button that states its size, and never in a scroll box", () => {
    const longByLength = `${"Use provider X if it stays under $50 a month. ".repeat(12)}Stop and ask first.`;
    const longByLines = `${"Line.\n".repeat(20)}Stop and ask first.`;
    expect(longByLines.length).toBeLessThan(480);

    for (const original of [longByLength, longByLines]) {
      render({
        approval: createApproval({
          payload: {
            title: "Approve staging hosting spend",
            recommendedAction: "Approve provider X.",
            reasoning: "It meets the request.",
            pros: ["Fixed cost."],
            risks: ["May rise."],
            originalRequest: { text: original, source: { kind: "external", sender: "Board" } },
          },
        }),
      });

      const source = () => container.querySelector("pre")!;
      const label = `Show full request (${original.length.toLocaleString()} characters)`;
      // The retained text is whole in the page; the preview is a visual clamp that the button announces.
      expect(source().textContent).toBe(original);
      expect(source().className).toContain("line-clamp-4");
      expect(button(label)?.getAttribute("aria-expanded")).toBe("false");
      click(label);
      expect(source().className).not.toMatch(/line-clamp|max-h-|overflow-/);
      click("Show less");
      expect(source().className).toContain("line-clamp-4");
    }

    // A short request is shown whole, with no button and no height cap.
    render({
      approval: createApproval({
        payload: {
          title: "Approve staging hosting spend",
          recommendedAction: "Approve provider X.",
          reasoning: "It meets the request.",
          pros: ["Fixed cost."],
          risks: ["May rise."],
          originalRequest: { text: "Use provider X.\nStop and ask first.", source: { kind: "external", sender: "Board" } },
        },
      }),
    });
    expect(container.querySelector("pre")!.className).not.toMatch(/line-clamp|max-h-|overflow-/);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Show full request"))).toBe(false);
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

  describe("decision feedback", () => {
    const SUBJECT = "Approve staging hosting spend";
    const noteField = () => container.querySelector("textarea")!;
    const alerts = () => [...container.querySelectorAll("[role='alert']")];
    const keyDown = (target: Element, init: KeyboardEventInit) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      });

    it("shows a decision error as an alert directly above the buttons and keeps the typed note", () => {
      const onDismissError = vi.fn();
      const props = { approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), onDismissError };
      render(props);
      expect(alerts()).toHaveLength(0);
      click("Add a note");
      type("Month to month only");

      render({ ...props, error: "Error while approving: Session expired" });
      expect(alerts()).toHaveLength(1);
      const [alert] = alerts();
      expect(alert.textContent).toBe("Error while approving: Session expired");
      expect(alert.className).toContain("text-destructive");
      expect(container.querySelector("[data-approval-card]")!.contains(alert)).toBe(true);
      // The next element is the button row itself: nothing sits between the error and the buttons.
      expect(alert.nextElementSibling).toBe(button("Approve")!.parentElement!.parentElement);
      expect(alert.nextElementSibling!.contains(button("Reject")!)).toBe(true);
      expect(button("Approve")!.getAttribute("aria-describedby")).toBe(alert.id);
      expect(noteField().value).toBe("Month to month only");

      // Editing the note tells the page the error no longer describes what will be sent.
      expect(onDismissError).not.toHaveBeenCalled();
      type("Month to month, from November");
      expect(onDismissError).toHaveBeenCalledTimes(1);

      render({ ...props, error: null });
      expect(alerts()).toHaveLength(0);
      expect(noteField().value).toBe("Month to month, from November");
    });

    it("keeps the error on a card that can no longer be decided", () => {
      render({
        approval: createApproval({ status: "approved" }),
        onApprove: vi.fn(),
        onReject: vi.fn(),
        error: "Error while approving: Agent not found",
      });
      expect(button("Approve")).toBeUndefined();
      expect(alerts().map((alert) => alert.textContent)).toEqual(["Error while approving: Agent not found"]);
    });

    it.each([
      ["Reject", "Reject this request?"],
      ["Request changes", "What should change?"],
      ["Add a note", "Note for the requester (optional)"],
    ])("closes the %s panel with Escape or its own button and returns focus to the opener", (opener, prompt) => {
      const onApprove = vi.fn();
      const onReject = vi.fn();
      const onRequestRevision = vi.fn();
      render({ approval: createApproval(), onApprove, onReject, onRequestRevision });
      const openerButton = () => button(opener) ?? button("Remove note")!;

      click(opener);
      expect(container.textContent).toContain(prompt);
      expect(document.activeElement).toBe(noteField());
      type("Half a thought");
      keyDown(noteField(), { key: "Escape" });
      expect(container.textContent).not.toContain(prompt);
      expect(container.querySelector("textarea")).toBeNull();
      expect(document.activeElement).toBe(openerButton());
      expect(openerButton().disabled).toBe(false);

      // Escape discards the note the way Cancel does, so nothing unseen is sent later.
      click(opener);
      expect(noteField().value).toBe("");
      type("Another thought");
      click(opener === "Add a note" ? "Remove note" : "Cancel");
      expect(container.querySelector("textarea")).toBeNull();
      expect(document.activeElement).toBe(openerButton());
      expect(document.activeElement).not.toBe(document.body);

      // Escape works from any control inside the panel, not only the field.
      if (opener !== "Add a note") {
        click(opener);
        keyDown(button("Cancel")!, { key: "Escape" });
        expect(container.querySelector("textarea")).toBeNull();
        expect(document.activeElement).toBe(openerButton());
      }
      expect(onApprove).not.toHaveBeenCalled();
      expect(onReject).not.toHaveBeenCalled();
      expect(onRequestRevision).not.toHaveBeenCalled();
    });

    it("moves the cursor into the field when the note panel becomes a confirmation", () => {
      render({ approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), onRequestRevision: vi.fn() });
      click("Add a note");
      type("Too expensive");
      act(() => button("Reject")!.focus());
      click("Reject");
      expect(document.activeElement).toBe(noteField());
      expect(noteField().value).toBe("Too expensive");
      click("Cancel");
      expect(document.activeElement).toBe(button("Reject"));
    });

    it("sends Request changes on Ctrl+Enter only with a note, rejects on Cmd+Enter, and never approves from the field", () => {
      const onApprove = vi.fn();
      const onReject = vi.fn();
      const onRequestRevision = vi.fn();
      render({ approval: createApproval(), onApprove, onReject, onRequestRevision });

      click("Request changes");
      keyDown(noteField(), { key: "Enter", ctrlKey: true });
      type("   ");
      keyDown(noteField(), { key: "Enter", ctrlKey: true });
      keyDown(noteField(), { key: "Enter", metaKey: true });
      expect(onRequestRevision).not.toHaveBeenCalled();

      type("  Confirm where the data is stored  ");
      // A plain Enter is a new line in the note.
      keyDown(noteField(), { key: "Enter" });
      expect(onRequestRevision).not.toHaveBeenCalled();
      keyDown(noteField(), { key: "Enter", ctrlKey: true });
      expect(onRequestRevision).toHaveBeenCalledExactlyOnceWith("Confirm where the data is stored");
      click("Cancel");

      click("Reject");
      type("Outside this quarter's budget");
      keyDown(noteField(), { key: "Enter", metaKey: true });
      expect(onReject).toHaveBeenCalledExactlyOnceWith("Outside this quarter's budget");
      click("Cancel");

      click("Add a note");
      type("Go ahead");
      keyDown(noteField(), { key: "Enter", ctrlKey: true });
      keyDown(noteField(), { key: "Enter", metaKey: true });
      expect(onApprove).not.toHaveBeenCalled();
      expect(onReject).toHaveBeenCalledTimes(1);
      expect(onRequestRevision).toHaveBeenCalledTimes(1);
    });

    it("sends nothing from the keyboard and keeps the panel open while a decision is sending", () => {
      const onReject = vi.fn();
      const props = { approval: createApproval(), onApprove: vi.fn(), onReject, onRequestRevision: vi.fn() };
      render(props);
      click("Reject");
      type("Too expensive");
      render({ ...props, isPending: true, pendingAction: "reject" as const });

      keyDown(noteField(), { key: "Enter", ctrlKey: true });
      keyDown(noteField(), { key: "Escape" });
      expect(onReject).not.toHaveBeenCalled();
      expect(noteField().value).toBe("Too expensive");
      expect(button("Rejecting...")!.getAttribute("aria-label")).toBe(`Rejecting: ${SUBJECT}`);
    });

    it("ties each panel's prompt to its field", () => {
      render({ approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), onRequestRevision: vi.fn() });
      const group = () => container.querySelector("[role='group']")!;
      const groupLabel = () => document.getElementById(group().getAttribute("aria-labelledby")!)!;

      expect(container.querySelector("[role='group']")).toBeNull();
      click("Reject");
      expect(groupLabel().textContent).toBe("Reject this request?");
      expect(group().contains(noteField())).toBe(true);
      expect(noteField().getAttribute("aria-describedby")).toBe(groupLabel().id);
      expect(noteField().labels[0].textContent).toBe("Reason (optional)");
      expect(noteField().hasAttribute("aria-required")).toBe(false);
      expect(button("Reject request")!.getAttribute("aria-label")).toBe(`Reject request: ${SUBJECT}`);
      click("Cancel");

      click("Request changes");
      expect(groupLabel().textContent).toBe("What should change?");
      expect(noteField().labels[0]).toBe(groupLabel());
      expect(noteField().getAttribute("aria-required")).toBe("true");
      expect(button("Send request")!.getAttribute("aria-label")).toBe(`Send request for changes: ${SUBJECT}`);
      click("Cancel");

      click("Add a note");
      expect(groupLabel().textContent).toBe("Note for the requester (optional)");
    });

    it("marks the whole control busy and names the pressed button while its decision is sending", () => {
      const props = { approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), onRequestRevision: vi.fn() };
      render(props);
      expect(button("Approve")!.closest("[aria-busy]")!.getAttribute("aria-busy")).toBe("false");

      render({ ...props, isPending: true, pendingAction: "approve" as const });
      const approving = button("Approving...")!;
      expect(approving.disabled).toBe(true);
      expect(approving.getAttribute("aria-label")).toBe(`Approving: ${SUBJECT}`);
      const control = approving.closest("[aria-busy]")!;
      expect(control.getAttribute("aria-busy")).toBe("true");
      expect(control.contains(button("Reject")!)).toBe(true);
      expect(button("Reject")!.disabled).toBe(true);
    });
  });

  describe("with an outgoing email draft", () => {
    const scrollIntoView = vi.fn();
    const draftBlock = () => container.querySelector<HTMLElement>("[data-approval-draft]")!;
    const shownBody = () => draftBlock().querySelector("[data-approval-draft-body]")!.textContent ?? "";
    const heldBackMessage = () => container.querySelector("[role='status']")!.textContent;
    const showFullLabel = (body: string) => `Show full reply (${body.length.toLocaleString()} characters)`;

    beforeEach(() => {
      // jsdom does not implement scrollIntoView.
      scrollIntoView.mockReset();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it.each(["a click", "Shift+A"])(
      "opens a cut draft and moves focus to it on the first Approve by %s, and sends on the second",
      (how) => {
        const onApprove = vi.fn();
        const body = emailDraftBody(2000);
        expect(body).toHaveLength(2000);
        render({
          approval: createApproval({ payload: emailPayload(body) }),
          onApprove,
          onReject: vi.fn(),
          enableShortcuts: true,
        });
        const approve = () =>
          how === "a click"
            ? click("Approve")
            : act(() => {
                // The shortcut works from wherever focus is inside the card, the opened draft included.
                const target = container.contains(document.activeElement)
                  ? document.activeElement!
                  : container.querySelector("[data-approval-card]")!;
                target.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true }));
              });

        // Cut at a word boundary near 1,500 characters, behind a button that states the size.
        expect(shownBody()).not.toContain(DRAFT_ENDING);
        expect(shownBody().endsWith("\u2026")).toBe(true);
        expect(shownBody().length).toBeGreaterThan(1400);
        expect(shownBody().length).toBeLessThanOrEqual(1501);
        expect(body.startsWith(shownBody().slice(0, -1))).toBe(true);
        expect(button(showFullLabel(body))!.getAttribute("aria-expanded")).toBe("false");
        expect(draftBlock().querySelector("[class*='line-clamp']")).toBeNull();
        expect(heldBackMessage()).toBe("");

        approve();
        expect(onApprove).not.toHaveBeenCalled();
        expect(shownBody()).toBe(body);
        expect(button("Show less")!.getAttribute("aria-expanded")).toBe("true");
        expect(heldBackMessage()).toBe("Read the full reply, then approve.");
        expect(draftBlock().tabIndex).toBe(-1);
        expect(document.activeElement).toBe(draftBlock());
        expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
        expect(scrollIntoView.mock.contexts[0]).toBe(draftBlock());

        approve();
        expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined);
        expect(heldBackMessage()).toBe("");
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      },
    );

    it("shows a draft of up to 1,500 characters whole and approves it at once", () => {
      const onApprove = vi.fn();
      const body = emailDraftBody(900);
      expect(body).toHaveLength(900);
      render({ approval: createApproval({ payload: emailPayload(body) }), onApprove, onReject: vi.fn() });

      expect(shownBody()).toBe(body);
      expect(draftBlock().querySelector("button")).toBeNull();
      expect(draftBlock().querySelector("[class*='line-clamp']")).toBeNull();
      expect(draftBlock().hasAttribute("tabindex")).toBe(false);

      click("Approve");
      expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(heldBackMessage()).toBe("");
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(draftBlock());
    });

    it("does not hold back Reject or Request changes while the draft is cut", () => {
      const onApprove = vi.fn();
      const onReject = vi.fn();
      const onRequestRevision = vi.fn();
      const body = emailDraftBody(2000);
      render({ approval: createApproval({ payload: emailPayload(body) }), onApprove, onReject, onRequestRevision });

      click("Request changes");
      type("Quote the delivery date");
      click("Send request");
      expect(onRequestRevision).toHaveBeenCalledExactlyOnceWith("Quote the delivery date");
      click("Cancel");

      click("Reject");
      click("Reject request");
      expect(onReject).toHaveBeenCalledExactlyOnceWith(undefined);

      expect(button(showFullLabel(body))).toBeDefined();
      expect(shownBody()).not.toContain(DRAFT_ENDING);
      expect(heldBackMessage()).toBe("");
      expect(onApprove).not.toHaveBeenCalled();
    });

    it("approves at once when the board opened the draft itself, and holds back again once it is cut again", () => {
      const onApprove = vi.fn();
      const body = emailDraftBody(2000);
      render({ approval: createApproval({ payload: emailPayload(body) }), onApprove, onReject: vi.fn() });

      click(showFullLabel(body));
      expect(shownBody()).toBe(body);
      click("Approve");
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(heldBackMessage()).toBe("");

      // Approve sends only while the whole draft is on the page.
      click("Show less");
      expect(shownBody()).not.toContain(DRAFT_ENDING);
      click("Approve");
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(shownBody()).toBe(body);
      expect(heldBackMessage()).toBe("Read the full reply, then approve.");
      click("Approve");
      expect(onApprove).toHaveBeenCalledTimes(2);
    });

    it("sends the note typed before Approve was held back", () => {
      const onApprove = vi.fn();
      render({
        approval: createApproval({ payload: emailPayload(emailDraftBody(2000)) }),
        onApprove,
        onReject: vi.fn(),
      });

      click("Add a note");
      type("Send it today");
      click("Approve");
      expect(onApprove).not.toHaveBeenCalled();
      click("Approve");
      expect(onApprove).toHaveBeenCalledExactlyOnceWith("Send it today");
    });
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
          capabilities: "Tracks competitor prices weekly, writes weekly_report to ~/reports, and flags changes above five percent.",
          adapterType: "claude_local",
          adapterConfig: { model: "claude-opus-5-5", apiKey: "must-never-render" },
          budgetMonthlyCents: 5000,
          desiredSkills: ["paperclip", "pricing-research", "s3", "s4", "s5", "s6", "s7"],
          agentId: "agent-pending",
        },
      }),
      resolveAgentName: (agentId) =>
        agentId === "agent-ceo" ? "Chief Executive" : agentId === "agent-pending" ? "Pricing Analyst" : null,
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
    // The described work keeps its identifiers and paths.
    expect(hire.textContent).toContain("What it will doTracks competitor prices weekly, writes weekly_report to ~/reports");
    expect(hire.textContent).toContain("If approvedPricing Analyst is activated. Its monthly budget is set to $50.00.");
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
        payload: {
          name: "Pricing Analyst",
          title: "Pricing Analyst",
          reportsTo: "11111111-1111-4111-8111-111111111111",
          budgetMonthlyCents: 0,
          desiredSkills: ["paperclip"],
        },
      }),
    });

    const hire = container.querySelector("[data-approval-hire]")!;
    const labels = [...hire.querySelectorAll("dt")].map((dt) => dt.textContent);
    // No resolver here, so the manager is unknown and left out rather than shown as an id.
    expect(labels).toEqual(["Monthly budget"]);
    expect(hire.textContent).toContain("No monthly limit");
    expect(hire.textContent).not.toContain("11111111");
    // Approval creates this agent, and the server does not apply skills on that path.
    expect(hire.textContent).toContain("Requested skills (not applied on approval)");
    expect(hire.textContent).toContain("The request does not describe the agent's work.");
    // No pending agent exists yet: approving creates it.
    expect(hire.textContent).toContain("If approvedPricing Analyst is created.");
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
    const body = block.querySelector("p.whitespace-pre-wrap")!;
    expect(block.textContent).toContain("Plan");
    // Numbering, bullets and line breaks survive; markup characters do not, and identifiers keep their underscores.
    expect(body.textContent).toContain("Q4 strategy\n1. Grow wholesale.\n2. Cut returns.\n• Hire one analyst\n• Review pricing_rules weekly");
    expect(body.textContent).not.toContain("#");
    expect(body.textContent).not.toContain("**");
    expect(body.textContent).not.toContain("Final line of the plan.");
    expect(container.textContent).not.toContain("Why");

    act(() => button("Show full plan")!.click());
    expect(block.querySelector("p.whitespace-pre-wrap")!.textContent).toContain("Final line of the plan.");
    act(() => button("Show less")!.click());
    expect(block.querySelector("p.whitespace-pre-wrap")!.textContent).not.toContain("Final line of the plan.");
  });

  it("shows a short strategy plan whole, with no expander", () => {
    render({
      approval: createApproval({ type: "approve_ceo_strategy", payload: { plan: "1. Grow wholesale.\n2. Cut returns." } }),
    });
    expect(container.querySelector("[data-approval-plan] p.whitespace-pre-wrap")!.textContent).toBe(
      "1. Grow wholesale.\n2. Cut returns.",
    );
    expect(button("Show full plan")).toBeUndefined();
  });
  it("renders a hire whose role is a reserved property name instead of crashing the page", () => {
    for (const role of ["__proto__", "constructor", "toString"]) {
      render({ approval: createApproval({ type: "hire_agent", payload: { name: "Odd Role", role } }) });
      const facts = [...container.querySelectorAll("[data-approval-hire] dl > div")].map((row) => row.textContent);
      expect(facts).toContain(`Role${role}`);
    }
  });

  it("says when a hire's budget is not stated and when its manager is not a known agent", () => {
    render({
      approval: createApproval({ type: "hire_agent", payload: { name: "Returns Clerk", reportsTo: "agent-gone" } }),
      resolveAgentName: () => null,
    });
    const hire = container.querySelector("[data-approval-hire]")!;
    expect(hire.textContent).toContain("Monthly budgetNot stated in the request");
    expect(hire.textContent).toContain("Reports toAn agent that is not in this company's list");
    expect(hire.textContent).not.toContain("agent-gone");

    // While the agent list is still loading, nothing is claimed about the manager.
    render({
      approval: createApproval({ type: "hire_agent", payload: { name: "Returns Clerk", reportsTo: "agent-gone" } }),
      resolveAgentName: () => undefined,
    });
    expect(container.querySelector("[data-approval-hire]")!.textContent).not.toContain("Reports to");
  });

  it("warns when a hire request points at a different, existing agent", () => {
    render({
      approval: createApproval({ type: "hire_agent", payload: { name: "Pricing Analyst", agentId: "agent-ceo" } }),
      resolveAgentName: (agentId) => (agentId === "agent-ceo" ? "Chief Executive" : null),
    });
    const hire = container.querySelector("[data-approval-hire]")!;
    expect(hire.textContent).toContain(
      "This request is linked to the existing agent Chief Executive, not to a new agent named Pricing Analyst.",
    );
    expect(hire.textContent).toContain("rejecting terminates it");
    expect(hire.textContent).not.toContain("The pending agent is terminated.");
  });

  it("states what a hire decision does only while the decision is open", () => {
    const payload = { name: "Pricing Analyst", agentId: "agent-pending", budgetMonthlyCents: 5000 };
    render({ approval: createApproval({ type: "hire_agent", status: "revision_requested", payload }) });
    expect(container.textContent).toContain("If rejectedThe pending agent is terminated.");

    for (const status of ["approved", "rejected", "cancelled"] as const) {
      render({ approval: createApproval({ type: "hire_agent", status, payload }) });
      expect(container.textContent).not.toContain("If approved");
      expect(container.textContent).not.toContain("If rejected");
      // The facts stay as the record of what was decided.
      expect(container.textContent).toContain("Monthly budget$50.00");
    }
  });

  it("offers Request changes only when a requesting agent can receive it", () => {
    render({
      approval: createApproval({ requestedByAgentId: null }),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
    });
    expect(button("Request changes")).toBeUndefined();
    expect(button("Approve")).toBeDefined();
  });

  it("shows the decision fields a strategy carries, and uses its rationale when it has no plan field", () => {
    render({
      approval: createApproval({
        type: "approve_ceo_strategy",
        payload: {
          plan: "1. Grow wholesale.\n2. Cut returns.",
          recommendedAction: "Approve the shift for Q4.",
          risks: ["Cash runway drops to four months."],
          nextActionOnApproval: "CEO reallocates budget on Monday.",
        },
      }),
    });
    let text = container.textContent ?? "";
    expect(text).toContain("RecommendationApprove the shift for Q4.");
    expect(text).toContain("Cash runway drops to four months.");
    expect(text).toContain("If approvedCEO reallocates budget on Monday.");
    expect(text).not.toContain("Pros");

    render({
      approval: createApproval({
        type: "approve_ceo_strategy",
        payload: { summary: "Shift 30% of ad spend to wholesale outreach." },
      }),
    });
    text = container.textContent ?? "";
    expect(text).toContain("PlanShift 30% of ad spend to wholesale outreach.");
    expect(text).not.toContain("no plan text");
  });

  it("reads a plan given as a list of steps and says so when a plan is not text", () => {
    render({ approval: createApproval({ type: "approve_ceo_strategy", payload: { plan: ["Step 1: cut costs", "Step 2: hire"] } }) });
    expect(container.querySelector("[data-approval-plan] p.whitespace-pre-wrap")!.textContent).toBe(
      "Step 1: cut costs\nStep 2: hire",
    );

    render({ approval: createApproval({ type: "approve_ceo_strategy", payload: { plan: { goals: ["a"] } } }) });
    expect(container.textContent).toContain("The plan is not plain text. Open the full request to read it.");

    render({ approval: createApproval({ type: "approve_ceo_strategy", payload: {} }) });
    expect(container.textContent).toContain("The request contains no plan text.");
  });

  it("shows a plan in full, with no expander, where the page asks for it", () => {
    const plan = Array.from({ length: 12 }, (_, index) => `Step ${index + 1}.`).join("\n");
    act(() => root.render(<ApprovalDecisionSummary type="approve_ceo_strategy" payload={{ plan }} full />));
    expect(container.textContent).toContain("Step 12.");
    expect(button("Show full plan")).toBeUndefined();
  });

  it("shows every part of a Board approval in full, with no control and no clamp, where the page asks for it", () => {
    const long = (label: string) => `${`${label} sentence that repeats. `.repeat(30)}${label} ends here.`;
    const payload = {
      title: "Reply to wholesale request",
      recommendedAction: long("Recommendation"),
      reasoning: Array.from({ length: 12 }, (_, index) => `Reason ${index + 1}.`).join("\n"),
      pros: ["Pro 1.", "Pro 2.", "Pro 3.", "Pro 4.", "Pro 5."],
      risks: ["Risk 1.", "Risk 2.", "Risk 3.", "Risk 4.", "Risk 5."],
      nextActionOnApproval: long("Next action"),
      recipient: "buyer@example.test",
      body: long("Draft"),
      originalRequest: {
        text: `${long("Request")}\n${"Line.\n".repeat(30)}Stop and ask before going any further.`,
        source: { kind: "external", sender: "Sam Example" },
      },
    };

    // The same request on a compact surface previews and offers to expand.
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
    expect(container.textContent).not.toContain("Recommendation ends here.");
    expect(container.textContent).not.toContain("Risk 5.");
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);

    act(() => root.render(<ApprovalDecisionSummary key="full" type="request_board_approval" payload={payload} full />));
    const text = container.textContent ?? "";
    for (const end of ["Recommendation ends here.", "Reason 12.", "Pro 5.", "Risk 5.", "Next action ends here.", "Draft ends here."]) {
      expect(text).toContain(end);
    }
    expect(text).not.toContain("\u2026");
    expect(container.querySelectorAll("li")).toHaveLength(10);
    expect(container.querySelector("pre")!.textContent).toBe(payload.originalRequest.text);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(container.querySelector("[class*='line-clamp']")).toBeNull();
    expect(container.querySelector("[class*='max-h-']")).toBeNull();
    expect(container.querySelector("[class*='overflow-y']")).toBeNull();
  });

  it("shows a long email draft whole, with no expander, where the page asks for it", () => {
    const body = emailDraftBody(2000);
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload(body)} full />));

    const draft = container.querySelector("[data-approval-draft]")!;
    expect(draft.querySelector("[data-approval-draft-body]")!.textContent).toBe(body);
    expect(draft.querySelector("button")).toBeNull();
    expect(draft.querySelector("[aria-expanded]")).toBeNull();
    expect(draft.querySelector("[class*='line-clamp']")).toBeNull();
    expect(draft.hasAttribute("tabindex")).toBe(false);
  });

  it("lets a summary used on its own expand and cut a long email draft", () => {
    const body = emailDraftBody(2000);
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload(body)} />));
    const shownBody = () => container.querySelector("[data-approval-draft-body]")!.textContent ?? "";

    expect(shownBody()).not.toContain(DRAFT_ENDING);
    act(() => button(`Show full reply (${body.length.toLocaleString()} characters)`)!.click());
    expect(shownBody()).toBe(body);
    act(() => button("Show less")!.click());
    expect(shownBody()).not.toContain(DRAFT_ENDING);
    expect(button(`Show full reply (${body.length.toLocaleString()} characters)`)).toBeDefined();
  });

  it("shows every skill of a hire and every risk of a strategy in full, where the page asks for it", () => {
    const desiredSkills = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
    act(() => root.render(<ApprovalDecisionSummary type="hire_agent" payload={{ name: "Clerk", desiredSkills }} full />));
    expect(container.querySelectorAll("[data-approval-hire] li")).toHaveLength(9);
    expect(container.querySelector("button")).toBeNull();

    act(() =>
      root.render(
        <ApprovalDecisionSummary
          type="approve_ceo_strategy"
          payload={{ plan: "Grow.", reasoning: Array.from({ length: 9 }, (_, i) => `Why ${i + 1}.`).join("\n"), risks: ["R1.", "R2.", "R3.", "R4."] }}
          full
        />,
      ),
    );
    expect(container.textContent).toContain("Why 9.");
    expect(container.textContent).toContain("R4.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("states the fields a Board approval leaves empty only where the summary is shown in full", () => {
    const payload = { title: "Approve the price page", risks: ["May rise."] };
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
    expect(container.textContent).not.toContain("Recommendation");
    expect(container.textContent).not.toContain("Original request");

    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} full />));
    expect(container.textContent).toContain("RecommendationNot supplied.");
    expect(container.textContent).toContain("Original requestNo original request was attached to this approval.");
    expect(container.textContent).toContain("WhyNot supplied.");
  });
});

describe("approval text helpers", () => {
  it("keeps identifiers, paths, link targets and nesting, and removes only markup", () => {
    expect(approvalReadableText("Set STRIPE__WEBHOOK_SECRET, call __init__ in pricing__rules.py, see ~/reports, 2**10")).toBe(
      "Set STRIPE__WEBHOOK_SECRET, call __init__ in pricing__rules.py, see ~/reports, 2**10",
    );
    expect(approvalReadableText("## Plan\n1. **Grow** wholesale\n   - sign `ten` shops\n\t- raise minimum\n---\n2. Cut returns")).toBe(
      "Plan\n1. Grow wholesale\n   \u2022 sign ten shops\n  \u2022 raise minimum\n2. Cut returns",
    );
    expect(approvalReadableText("See [the diff](https://example.test/a_b) and [x](x)")).toBe(
      "See the diff (https://example.test/a_b) and x",
    );
    expect(approvalReadableText("one\r\ntwo\rthree   ")).toBe("one\ntwo\nthree");
    expect(approvalReadableText("   ")).toBeNull();
    // A leading ">" or "+" may be a comparison or a sign, so neither is taken for markup.
    expect(approvalReadableText("> 30% margin\n+ 12% conversion\n- one bullet")).toBe(
      "> 30% margin\n+ 12% conversion\n\u2022 one bullet",
    );
  });

  it("makes a one-line title without deleting characters that carry meaning", () => {
    for (const title of [
      "Review pricing_rules before the sync",
      "Move ~/reports to the shared drive",
      "Raise the cap to 2**10 rows",
      "> 30% margin on the Q4 bundle",
      "+ 2 seats for ~$42/month",
      "Order #90210: 3 * 12 = 36",
    ]) {
      expect(approvalExcerpt(title)).toBe(title);
    }
    // Markup goes, link targets stay, and line breaks fold into single spaces.
    expect(approvalExcerpt("## **Approve** the `sync`\n\n1. Now\n2. Later")).toBe("Approve the sync 1. Now 2. Later");
    expect(approvalExcerpt("See [the diff](https://example.test/a_b)")).toBe("See the diff (https://example.test/a_b)");
    expect(approvalExcerpt("   ")).toBeNull();
    expect(approvalExcerpt(null)).toBeNull();

    // Cut at a word boundary, and never between the halves of one character.
    expect(approvalExcerpt("Approve the pricing_rules sync for the wholesale portal", 30)).toBe("Approve the pricing_rules sync\u2026");
    expect(approvalExcerpt("\u{1F600}".repeat(10), 5)).toBe(`${"\u{1F600}".repeat(2)}\u2026`);
    expect(approvalExcerpt("word ".repeat(5_000), Number.POSITIVE_INFINITY)).toBe("word ".repeat(5_000).trim());
  });

  it("strips exactly one leading list marker, and nothing that only looks like one", () => {
    expect(stripLeadingListMarker("- Dash")).toBe("Dash");
    expect(stripLeadingListMarker("* Star")).toBe("Star");
    expect(stripLeadingListMarker("\u2022 Dot")).toBe("Dot");
    expect(stripLeadingListMarker("1. Number")).toBe("Number");
    expect(stripLeadingListMarker("12) Paren")).toBe("Paren");
    expect(stripLeadingListMarker("- - Twice")).toBe("- Twice");
    for (const kept of ["-5% margin", "1.5x the cost", "+ 2 seats", "> 30% margin", "2026. A year, not a marker", "*bold*"]) {
      expect(stripLeadingListMarker(kept)).toBe(kept);
    }
  });

  it("stays fast on hostile input", () => {
    const started = performance.now();
    for (const input of ["x" + " ".repeat(100_000) + "y", "[".repeat(100_000), "**".repeat(50_000), "`".repeat(100_000)]) {
      approvalReadableText(input);
      approvalStrategyPlan({ plan: input });
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("cuts an outgoing draft only above 1,500 characters, at a word or line boundary", () => {
    expect(approvalDraftPreview("Hi Sam,\n\nShort reply.")).toBeNull();
    expect(approvalDraftPreview("x".repeat(1500))).toBeNull();
    // Trailing blank space hides no words.
    expect(approvalDraftPreview(`${"x".repeat(1500)}\n\n   \n`)).toBeNull();

    const words = "word ".repeat(400);
    const cut = approvalDraftPreview(words)!;
    expect(cut.endsWith("word\u2026")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(1501);
    expect(cut.length).toBeGreaterThan(1490);

    // Many short lines are not cut by a line count: only the length counts.
    const lines = "Line.\n".repeat(300);
    expect(approvalDraftPreview(lines)!.split("\n").length).toBeGreaterThan(240);

    // An unbroken run is cut at the limit, never between the halves of one character.
    expect(approvalDraftPreview("x".repeat(1501))).toBe(`${"x".repeat(1500)}\u2026`);
    expect(approvalDraftPreview(`x${"\u{1F600}".repeat(800)}`)).toBe(`x${"\u{1F600}".repeat(749)}\u2026`);
  });

  it("previews by lines and by length, on whole words, and reports every cut", () => {
    expect(approvalTextPreview("a\nb", 6, 480)).toEqual({ preview: "a\nb", truncated: false });
    expect(approvalTextPreview("1\n2\n3\n4", 2, 480)).toEqual({ preview: "1\n2\u2026", truncated: true });

    const paragraph = "word ".repeat(200).trim();
    const cut = approvalTextPreview(paragraph, 6, 480);
    expect(cut.truncated).toBe(true);
    expect(cut.preview.length).toBeLessThanOrEqual(481);
    expect(cut.preview.endsWith("word\u2026")).toBe(true);

    // An unbroken run is cut at the limit, never between the halves of one character.
    const emoji = "\u{1F600}".repeat(400);
    const cutEmoji = approvalTextPreview(emoji, 6, 481);
    expect(cutEmoji.truncated).toBe(true);
    expect(cutEmoji.preview.slice(0, -1)).toBe("\u{1F600}".repeat(240));
  });
});
