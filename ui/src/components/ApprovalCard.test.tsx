// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Agent, Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { ApprovalCard } from "./ApprovalCard";
import { ApprovalDecisionSummary } from "./ApprovalDecisionSummary";
import { createApprovalRevisionMemory } from "./ApprovalRevision";
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
/** What the Approve button says while an outgoing draft is still cut. */
const READ_TO_APPROVE = "Read full reply to approve";

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
    expect(text).toContain("Email · Sam Example · Quoted by the requesting agent, not verified");
    expect(text.indexOf("Original request")).toBeLessThan(text.indexOf("Draft reply"));
    expect(text.indexOf("Draft reply")).toBeLessThan(text.indexOf("ApproveReject"));
  });

  it("gives View details a 44px touch area that no decision button lies under", () => {
    render({
      approval: createApproval(),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
      detailLink: "/approvals/approval-1",
    });

    const details = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "View details")!;
    // Every request has such a link: its accessible name says which request it opens.
    expect(details.getAttribute("aria-label")).toBe("View details: Approve staging hosting spend");
    // 16px of text and 14px above and below it, no wider than the link. jsdom cannot evaluate
    // the media query, so the classes are checked.
    for (const name of [
      "relative",
      "pointer-coarse:after:absolute",
      "pointer-coarse:after:inset-x-0",
      "pointer-coarse:after:-inset-y-3.5",
    ]) {
      expect(details.classList.contains(name), name).toBe(true);
    }
    // The link itself is no taller, so the card keeps its height.
    expect(details.classList.contains("h-auto")).toBe(true);
    expect(details.className).not.toMatch(/min-h-|(^|[\s:])py-/);

    // Alone on a line under the buttons, the area reaches 2px into their group. The group is
    // drawn above it, so a tap on Approve or Reject never lands on the link.
    const decisions = container.querySelector<HTMLElement>("[data-approval-decision-buttons]")!;
    expect(decisions.classList.contains("pointer-coarse:relative")).toBe(true);
    expect(decisions.classList.contains("pointer-coarse:z-10")).toBe(true);
    expect([...decisions.querySelectorAll("button")].map((candidate) => candidate.textContent)).toEqual([
      "Approve",
      "Request changes",
      "Reject",
    ]);
    expect(decisions.contains(details)).toBe(false);
    expect(decisions.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("starts with a note it is handed, its panel open, without taking focus, and reports edits to it", () => {
    const onApprove = vi.fn();
    const onNoteChange = vi.fn();
    render({
      approval: createApproval(),
      onApprove,
      onReject: vi.fn(),
      defaultNote: "Month to month only",
      onNoteChange,
    });

    const field = container.querySelector("textarea")!;
    expect(field.value).toBe("Month to month only");
    expect(button("Remove note")!.getAttribute("aria-expanded")).toBe("true");
    // The card was put back by the page; the page decides where focus goes.
    expect(document.activeElement).not.toBe(field);
    expect(onNoteChange).not.toHaveBeenCalled();

    click("Approve");
    expect(onApprove).toHaveBeenLastCalledWith("Month to month only");

    // Every report names the panel the text sits in, so whoever keeps a copy can hand it back to that panel.
    type("Month to month, from March");
    expect(onNoteChange).toHaveBeenLastCalledWith("Month to month, from March", "note");
    click("Remove note");
    expect(onNoteChange).toHaveBeenLastCalledWith("", null);
    expect(container.querySelector("textarea")).toBeNull();
    click("Approve");
    expect(onApprove).toHaveBeenLastCalledWith(undefined);

    // A panel the board opens still takes the cursor.
    click("Add a note");
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it("hands a text back to the panel it was typed in, never to the approval note", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onRequestRevision = vi.fn();
    render({
      approval: createApproval(),
      onApprove,
      onReject,
      onRequestRevision,
      defaultNote: "No. Too expensive.",
      defaultNoteMode: "reject",
    });

    // The rejection is still being confirmed: Approve cannot send the reason as its note.
    expect(container.textContent).toContain("Reject this request?");
    expect(container.querySelector("textarea")!.value).toBe("No. Too expensive.");
    expect(button("Approve")!.disabled).toBe(true);
    expect(document.activeElement).not.toBe(container.querySelector("textarea"));
    click("Reject request");
    expect(onReject).toHaveBeenCalledExactlyOnceWith("No. Too expensive.");
    expect(onApprove).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    render({
      approval: createApproval(),
      onApprove,
      onReject,
      onRequestRevision,
      defaultNote: "Quote the delivery date",
      defaultNoteMode: "revision",
    });
    expect(container.textContent).toContain("What should change?");
    expect(button("Approve")!.disabled).toBe(true);
    click("Send request");
    expect(onRequestRevision).toHaveBeenCalledExactlyOnceWith("Quote the delivery date");

    // Where changes cannot be requested, a change request is not handed back as anything else.
    act(() => root.unmount());
    root = createRoot(container);
    render({
      approval: createApproval({ requestedByAgentId: null }),
      onApprove,
      onReject,
      onRequestRevision,
      defaultNote: "Quote the delivery date",
      defaultNoteMode: "revision",
    });
    expect(container.querySelector("textarea")).toBeNull();
    click("Approve");
    expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("reports the panel a text moves to, so a kept copy follows it", () => {
    const onNoteChange = vi.fn();
    render({
      approval: createApproval(),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
      onNoteChange,
    });

    // An empty panel is nothing to keep.
    click("Reject");
    expect(onNoteChange).not.toHaveBeenCalled();
    type("Too expensive");
    expect(onNoteChange).toHaveBeenLastCalledWith("Too expensive", "reject");
    click("Cancel");
    expect(onNoteChange).toHaveBeenLastCalledWith("", null);

    click("Add a note");
    type("Month to month only");
    expect(onNoteChange).toHaveBeenLastCalledWith("Month to month only", "note");
    // The note becomes the change request.
    click("Request changes");
    expect(onNoteChange).toHaveBeenLastCalledWith("Month to month only", "revision");
    click("Cancel");
    expect(onNoteChange).toHaveBeenLastCalledWith("", null);
  });

  it("brings its decision controls into view when a panel opens, and leaves a panel that starts open alone", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render({ approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), onRequestRevision: vi.fn() });
      expect(scrollIntoView).not.toHaveBeenCalled();

      click("Request changes");
      // The field and the buttons that send it, together; only as far as needed.
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
      const controls = scrollIntoView.mock.contexts[0] as HTMLElement;
      expect(controls.contains(container.querySelector("textarea"))).toBe(true);
      expect(controls.contains(button("Send request")!)).toBe(true);
      expect(controls.contains(button("Approve")!)).toBe(true);

      act(() => root.unmount());
      root = createRoot(container);
      scrollIntoView.mockReset();
      render({
        approval: createApproval(),
        onApprove: vi.fn(),
        onReject: vi.fn(),
        defaultNote: "Month to month only",
      });
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
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

  it("offers Request changes only where it can be handled", () => {
    render({ approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn() });
    expect(button("Request changes")).toBeUndefined();
    expect(button("Approve")).toBeDefined();
  });

  describe("sent back for changes", () => {
    const SENT_BACK = {
      status: "revision_requested",
      decisionNote: "Quote the delivery date.\nUse the November price list.",
      decidedByUserId: "user-board-1",
      decidedAt: new Date("2026-10-06T10:00:00.000Z"),
      updatedAt: new Date("2026-10-06T10:00:00.000Z"),
    } as const;
    const requester = { id: "agent-requester", name: "Pricing Agent" } as Agent;
    const sentBack = () => container.querySelector<HTMLElement>("[data-approval-sent-back]")!;

    it("offers no one-click decision and says who it is waiting on, since when, and what was asked", () => {
      const onApprove = vi.fn();
      const onReject = vi.fn();
      render({
        approval: createApproval(SENT_BACK),
        requesterAgent: requester,
        onApprove,
        onReject,
        onRequestRevision: vi.fn(),
        detailLink: "/approvals/approval-1",
        enableShortcuts: true,
      });

      for (const label of ["Approve", "Reject", "Request changes", "Add a note"]) {
        expect(button(label)).toBeUndefined();
      }
      expect(container.querySelectorAll("button")).toHaveLength(0);
      expect(sentBack().textContent).toContain("Waiting on Pricing Agent to revise");
      expect(sentBack().textContent).toContain("Sent back 2h ago");
      const asked = sentBack().querySelector("[data-approval-changes-asked]")!;
      expect(asked.textContent).toBe("Changes you asked forQuote the delivery date.\nUse the November price list.");
      // The note is the board's own text, shown as written with its line break.
      expect(asked.querySelectorAll("p")[1].className).toContain("whitespace-pre-wrap");
      expect(container.textContent).not.toContain("Decision note");
      // The board is not told it has kept the request waiting, and no id is shown.
      expect(container.textContent).not.toContain("Waiting 1 day");
      expect(container.textContent).not.toContain("user-board-1");
      expect(container.textContent).not.toContain("agent-requester");
      const details = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "View details");
      expect(details?.getAttribute("href")).toBe("/approvals/approval-1");
      expect(details?.classList.contains("pointer-coarse:after:-inset-y-3.5")).toBe(true);

      // The keyboard shortcuts decide nothing either.
      for (const key of ["A", "X", "C"]) {
        act(() => {
          container
            .querySelector("[data-approval-card]")!
            .dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true }));
        });
      }
      expect(onApprove).not.toHaveBeenCalled();
      expect(onReject).not.toHaveBeenCalled();
      expect(container.querySelector("textarea")).toBeNull();
    });

    it("names no one when the requester is unknown and falls back to the last change for the time", () => {
      render({
        approval: createApproval({
          ...SENT_BACK,
          decidedAt: null,
          decisionNote: null,
          updatedAt: new Date("2026-10-06T09:00:00.000Z"),
        }),
        onApprove: vi.fn(),
        onReject: vi.fn(),
      });
      expect(sentBack().textContent).toContain("Waiting on the requester to revise");
      expect(sentBack().textContent).toContain("Sent back 3h ago");
      expect(container.textContent).not.toContain("Changes you asked for");
      expect(button("Approve")).toBeUndefined();
    });

    it("keeps the error of a change request on the card, beside the link to its details", () => {
      render({
        approval: createApproval(SENT_BACK),
        onApprove: vi.fn(),
        onReject: vi.fn(),
        detailLink: "/approvals/approval-1",
        error: "Error while requesting changes: Session expired",
      });
      expect(container.querySelector("[role='alert']")!.textContent).toBe(
        "Error while requesting changes: Session expired",
      );
      expect(sentBack().textContent).toContain("Waiting on the requester to revise");
    });
  });

  describe("a revised request that carries the board's change request", () => {
    const REVISED = {
      status: "pending",
      decisionNote: "Quote the delivery date.\nUse the November price list.",
      decidedByUserId: null,
      decidedAt: null,
    } as const;
    const asked = () => container.querySelector<HTMLElement>("[data-approval-changes-asked]");

    it("shows the note as the changes asked for, above the summary and the buttons", () => {
      render({ approval: createApproval(REVISED), onApprove: vi.fn(), onReject: vi.fn() });

      expect(asked()!.textContent).toBe("Changes you asked forQuote the delivery date.\nUse the November price list.");
      // Never under the label of a decision: nothing has been decided on this version.
      expect(container.querySelector("[data-approval-decision-note]")).toBeNull();
      expect(container.textContent).not.toContain("Decision note");
      const approve = button("Approve")!;
      expect(approve).toBeDefined();
      expect(asked()!.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("prefers the note on the request over the copy the page kept", () => {
      render({
        approval: createApproval(REVISED),
        changesAskedFor: "An older copy",
        onApprove: vi.fn(),
        onReject: vi.fn(),
      });
      expect(asked()!.textContent).toContain("Quote the delivery date.");
      expect(container.textContent).not.toContain("An older copy");
    });

    it("falls back to the page's copy when the request carries no note", () => {
      render({
        approval: createApproval({ ...REVISED, decisionNote: null }),
        changesAskedFor: "Kept by the page",
        onApprove: vi.fn(),
        onReject: vi.fn(),
      });
      expect(asked()!.textContent).toBe("Changes you asked forKept by the page");
    });

    it("shows nothing for a blank note", () => {
      render({ approval: createApproval({ ...REVISED, decisionNote: "  \n " }), onApprove: vi.fn(), onReject: vi.fn() });
      expect(asked()).toBeNull();
      expect(container.textContent).not.toContain("Decision note");
    });
  });

  it("says when a closed request was decided, and never by whom as an id", () => {
    const decided = {
      decidedAt: new Date("2026-10-06T10:00:00.000Z"),
      decidedByUserId: "user-board-1",
      decisionNote: "Month to month only",
    };
    for (const [status, line] of [
      ["approved", "Approved 2h ago"],
      ["rejected", "Rejected 2h ago"],
      ["cancelled", "Cancelled 2h ago"],
    ] as const) {
      render({ approval: createApproval({ status, ...decided }) });
      expect(container.textContent).toContain(line);
      expect(container.textContent).not.toContain("Created");
      expect(container.textContent).not.toContain("user-board-1");
      // A closed request keeps the plain label for its note.
      expect(container.textContent).toContain("Decision note. Month to month only");
      expect(container.textContent).not.toContain("Changes you asked for");
    }

    // A note typed on several lines is shown with its lines, and a long unbroken run wraps.
    const lines = "1. Month to month only.\n2. Review in March.";
    render({ approval: createApproval({ status: "approved", ...decided, decisionNote: lines }) });
    const note = container.querySelector<HTMLElement>("[data-approval-decision-note]")!;
    expect(note.textContent).toBe(`Decision note. ${lines}`);
    expect(note.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(note.classList.contains("break-words")).toBe(true);

    // Without a recorded time the card falls back to when the request was created.
    render({ approval: createApproval({ status: "approved" }) });
    expect(container.textContent).toContain("Created 1d ago");
    // A request still open is not said to be decided.
    render({ approval: createApproval({ decidedAt: new Date("2026-10-06T10:00:00.000Z") }) });
    expect(container.textContent).toContain("Waiting 1 day");
    expect(container.textContent).not.toContain("2h ago");
  });

  describe("revised while open", () => {
    const NOTICE = "The requester revised this request while it was open. Review it before you decide.";
    const HELD_BACK = "Confirm that you have reviewed the revised request, then approve.";
    const LATER = new Date("2026-10-06T11:00:00.000Z");
    const scrollIntoView = vi.fn();
    const notice = () => container.querySelector<HTMLElement>("[data-approval-revised]");
    const heldBackMessage = () => container.querySelector("[role='status']")!.textContent;
    const revisedPayload = (recommendedAction: string) => ({
      ...(createApproval().payload as Record<string, unknown>),
      recommendedAction,
    });
    const pressApprove = () =>
      act(() => {
        const target = container.contains(document.activeElement)
          ? document.activeElement!
          : container.querySelector("[data-approval-card]")!;
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true }));
      });

    beforeEach(() => {
      // jsdom does not implement scrollIntoView.
      scrollIntoView.mockReset();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it("holds Approve back until the board confirms it has reviewed the revision, and keeps the typed note", () => {
      const onApprove = vi.fn();
      const onReject = vi.fn();
      const props = { onApprove, onReject, onRequestRevision: vi.fn(), enableShortcuts: true };
      render({ approval: createApproval(), ...props });
      click("Add a note");
      type("Month to month only");
      expect(notice()).toBeNull();

      render({
        approval: createApproval({
          updatedAt: LATER,
          payload: revisedPayload("Approve provider Y at twice the quoted price."),
        }),
        ...props,
      });

      // The new text is on the card, under a notice that says it changed.
      expect(container.textContent).toContain("Approve provider Y at twice the quoted price.");
      expect(notice()!.dataset.approvalRevised).toBe("unreviewed");
      expect(notice()!.querySelector("[role='alert']")!.textContent).toBe(NOTICE);
      const summary = [...container.querySelectorAll("h4")].find((p) => p.textContent === "Recommendation")!;
      expect(notice()!.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(container.querySelector("textarea")!.value).toBe("Month to month only");

      click("Approve");
      expect(onApprove).not.toHaveBeenCalled();
      expect(heldBackMessage()).toBe(HELD_BACK);
      // Focus lands on the notice, not on its button: a second Enter confirms nothing.
      expect(document.activeElement).toBe(notice());
      // Opening the note panel scrolled the controls into view earlier; this press brought the notice in.
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(notice());
      pressApprove();
      expect(onApprove).not.toHaveBeenCalled();

      click("I have reviewed it");
      expect(button("I have reviewed it")).toBeUndefined();
      expect(container.textContent).not.toContain(NOTICE);
      expect(notice()!.dataset.approvalRevised).toBe("reviewed");
      expect(container.querySelector("[role='alert']")).toBeNull();
      expect(heldBackMessage()).toBe("");
      // Focus stays inside the card when the button goes away.
      expect(document.activeElement).toBe(notice());
      expect(container.querySelector("textarea")!.value).toBe("Month to month only");

      click("Approve");
      expect(onApprove).toHaveBeenCalledExactlyOnceWith("Month to month only");
      expect(onReject).not.toHaveBeenCalled();
    });

    it("blocks Shift+A the same way and never holds back Reject or Request changes", () => {
      const onApprove = vi.fn();
      const onReject = vi.fn();
      const props = { onApprove, onReject, onRequestRevision: vi.fn(), enableShortcuts: true };
      render({ approval: createApproval(), ...props });
      render({
        approval: createApproval({ updatedAt: LATER, payload: revisedPayload("Approve provider Y.") }),
        ...props,
      });

      pressApprove();
      expect(onApprove).not.toHaveBeenCalled();
      expect(heldBackMessage()).toBe(HELD_BACK);

      click("Reject");
      click("Reject request");
      expect(onReject).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(onApprove).not.toHaveBeenCalled();
    });

    it("raises nothing when only the time changed, or when the payload is the same in another key order", () => {
      const onApprove = vi.fn();
      const props = { onApprove, onReject: vi.fn() };
      const first = createApproval();
      render({ approval: first, ...props });

      const samePayload = Object.fromEntries(Object.entries(first.payload).reverse());
      expect(Object.keys(samePayload)).not.toEqual(Object.keys(first.payload));
      render({ approval: createApproval({ updatedAt: LATER, payload: samePayload }), ...props });
      expect(notice()).toBeNull();
      expect(container.textContent).not.toContain(NOTICE);

      click("Approve");
      expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it("raises nothing for a decision, for older data, or for another request shown in the same place", () => {
      const props = { onApprove: vi.fn(), onReject: vi.fn() };
      render({ approval: createApproval(), ...props });

      // The reader's own decision changes the time and the status.
      render({
        approval: createApproval({ status: "approved", updatedAt: LATER, payload: revisedPayload("Changed.") }),
        ...props,
      });
      expect(notice()).toBeNull();

      render({ approval: createApproval(), ...props });
      render({
        approval: createApproval({
          updatedAt: new Date("2026-10-04T12:00:00.000Z"),
          payload: revisedPayload("An older version."),
        }),
        ...props,
      });
      expect(notice()).toBeNull();

      render({
        approval: createApproval({ id: "approval-2", updatedAt: LATER, payload: revisedPayload("Another request.") }),
        ...props,
      });
      expect(notice()).toBeNull();
      expect(button("Approve")).toBeDefined();
    });

    it("says so when a request sent back comes back revised, and again for each later revision", () => {
      const onApprove = vi.fn();
      const props = { onApprove, onReject: vi.fn() };
      render({ approval: createApproval(), ...props });
      render({
        approval: createApproval({ status: "revision_requested", updatedAt: new Date("2026-10-06T10:00:00.000Z") }),
        ...props,
      });
      expect(notice()).toBeNull();
      expect(button("Approve")).toBeUndefined();

      // Resubmitted unchanged: the board has read this version.
      render({ approval: createApproval({ updatedAt: new Date("2026-10-06T10:30:00.000Z") }), ...props });
      expect(notice()).toBeNull();

      render({ approval: createApproval({ updatedAt: LATER, payload: revisedPayload("Second version.") }), ...props });
      expect(notice()!.textContent).toContain(NOTICE);
      click("I have reviewed it");
      expect(container.textContent).not.toContain(NOTICE);

      render({
        approval: createApproval({
          updatedAt: new Date("2026-10-06T11:30:00.000Z"),
          payload: revisedPayload("Third version."),
        }),
        ...props,
      });
      expect(notice()!.textContent).toContain(NOTICE);
      click("Approve");
      expect(onApprove).not.toHaveBeenCalled();
      click("I have reviewed it");
      click("Approve");
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it("deals with the revision first and the cut draft second", () => {
      const onApprove = vi.fn();
      const props = { onApprove, onReject: vi.fn() };
      const body = emailDraftBody(2000);
      render({ approval: createApproval({ payload: emailPayload(body) }), ...props });
      const revisedBody = body.replace("ship the same day", "ship within a month");
      render({ approval: createApproval({ updatedAt: LATER, payload: emailPayload(revisedBody) }), ...props });
      const shownBody = () => container.querySelector("[data-approval-draft-body]")!.textContent ?? "";

      // While the revision is unconfirmed the press will not open the reply, so the button does not say it will.
      expect(button(READ_TO_APPROVE)).toBeUndefined();
      click("Approve");
      expect(heldBackMessage()).toBe(HELD_BACK);
      // The first press is about the revision only: the draft stays as it was.
      expect(shownBody()).not.toContain("ship within a month");
      expect(onApprove).not.toHaveBeenCalled();

      click("I have reviewed it");
      expect(button("Approve")).toBeUndefined();
      click(READ_TO_APPROVE);
      expect(heldBackMessage()).toBe("Read the full reply, then approve.");
      expect(shownBody()).toBe(revisedBody);
      expect(onApprove).not.toHaveBeenCalled();

      click("Approve");
      expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined);
    });
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
    // What is shown stays "Show more"; the name a screen reader gets says which section it opens.
    expect(button("Show more")!.getAttribute("aria-label")).toBe("Show more: Why");
    click("Show more");
    expect(container.textContent).toContain("Final sentence.");
    expect(button("Show less")!.getAttribute("aria-label")).toBe("Show less: Why");
    click("Show less");
    expect(container.textContent).not.toContain("Final sentence.");

    expect(container.textContent).not.toContain("Third pro.");
    expect(button("+1 more")!.getAttribute("aria-label")).toBe("+1 more: Pros");
    click("+1 more");
    expect(button("Show fewer")!.getAttribute("aria-label")).toBe("Show fewer: Pros");
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
    expect(container.textContent).toContain("Saved from the original comment · View comment");
    expect(container.textContent).not.toContain("snapshot");
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
      // The card is itself a group named by its title; the panels are the groups inside it.
      const group = () => container.querySelector("[data-approval-card] [role='group']")!;
      const groupLabel = () => document.getElementById(group().getAttribute("aria-labelledby")!)!;

      expect(container.querySelector("[data-approval-card] [role='group']")).toBeNull();
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
            ? click(button(READ_TO_APPROVE) ? READ_TO_APPROVE : "Approve")
            : act(() => {
                // The shortcut works from wherever focus is inside the card, the opened draft included.
                const target = container.contains(document.activeElement)
                  ? document.activeElement!
                  : container.querySelector("[data-approval-card]")!;
                target.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true }));
              });

        // Cut at a word boundary near 1,500 characters, behind a button that states the size.
        expect(shownBody()).not.toContain(DRAFT_ENDING);
        expect(shownBody().length).toBeGreaterThan(1400);
        expect(shownBody().length).toBeLessThanOrEqual(1500);
        // The body box holds the email's own characters and nothing else: no ellipsis to mistake for the email.
        expect(body.startsWith(shownBody())).toBe(true);
        expect(shownBody()).not.toContain("\u2026");
        // The cue sits under the body box, inside the draft block, above the button that opens the rest.
        const continues = draftBlock().querySelector<HTMLElement>("[data-approval-draft-continues]")!;
        expect(continues.textContent).toBe(
          `The reply continues: ${(body.length - shownBody().length).toLocaleString()} more characters.`,
        );
        const bodyBox = draftBlock().querySelector("[data-approval-draft-body]")!.parentElement!.parentElement!;
        expect(bodyBox.contains(continues)).toBe(false);
        expect(bodyBox.nextElementSibling).toBe(continues);
        expect(continues.nextElementSibling).toBe(button(showFullLabel(body)));
        expect(button(showFullLabel(body))!.getAttribute("aria-expanded")).toBe("false");
        expect(draftBlock().querySelector("[class*='line-clamp']")).toBeNull();
        expect(heldBackMessage()).toBe("");
        // The button says, before the press, that the press opens the reply and does not approve.
        expect(button("Approve")).toBeUndefined();
        expect(button(READ_TO_APPROVE)!.getAttribute("aria-label")).toBe(`${READ_TO_APPROVE}: Reply to wholesale request`);

        approve();
        expect(onApprove).not.toHaveBeenCalled();
        expect(shownBody()).toBe(body);
        expect(draftBlock().querySelector("[data-approval-draft-continues]")).toBeNull();
        expect(button(READ_TO_APPROVE)).toBeUndefined();
        expect(button("Approve")!.getAttribute("aria-label")).toBe("Approve: Reply to wholesale request");
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
      expect(draftBlock().querySelector("[data-approval-draft-continues]")).toBeNull();
      expect(draftBlock().querySelector("[class*='line-clamp']")).toBeNull();
      expect(draftBlock().hasAttribute("tabindex")).toBe(false);
      expect(button(READ_TO_APPROVE)).toBeUndefined();

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

      // Approve sends only while the whole draft is on the page, and the button says so again once it is cut.
      click("Show less");
      expect(shownBody()).not.toContain(DRAFT_ENDING);
      expect(button("Approve")).toBeUndefined();
      click(READ_TO_APPROVE);
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
      click(READ_TO_APPROVE);
      expect(onApprove).not.toHaveBeenCalled();
      click("Approve");
      expect(onApprove).toHaveBeenCalledExactlyOnceWith("Send it today");
    });
  });
});

describe("ApprovalCard as a collapsible queue row", () => {
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
    act(() => root.render(<ApprovalCard requesterAgent={null} collapsible {...props} />));
  const card = () => container.querySelector<HTMLElement>("[data-approval-card]")!;
  const header = () => container.querySelector<HTMLButtonElement>("h3 > button")!;
  const ask = () => container.querySelector("[data-approval-ask]")?.textContent ?? null;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      card().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true, ...init }));
    });

  it("is one row when closed: what it is, who asked, how long it has waited, and one line of what is asked", () => {
    const onOpenChange = vi.fn();
    render({
      approval: createApproval({ createdAt: new Date("2026-09-27T12:00:00.000Z") }),
      requesterAgent: { id: "agent-requester", name: "Pricing Analyst" } as Agent,
      linkedIssues: [{ id: ISSUE_ID, identifier: "DEMO-398", title: "Staging environment" }],
      open: false,
      onOpenChange,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
      detailLink: "/approvals/approval-1",
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Board Approval");
    expect(text).toContain("pending");
    expect(text).toContain("Requested by");
    expect(text).toContain("Pricing Analyst");
    expect(text).toContain("Waiting 9 days");
    expect(text).toContain("No original request attached");
    expect(text).not.toContain("agent-requester");
    expect(ask()).toBe("Recommendation: Approve provider X at the quoted monthly price.");
    // Title and the one line are cut to the row's width by the browser, not in the text.
    expect(header().querySelector("span")!.className).toContain("truncate");
    expect(container.querySelector("[data-approval-ask]")!.className).toContain("truncate");

    // The header is a real button inside the heading, and it says the card is closed.
    expect(container.querySelector("h3")!.textContent).toBe("Approve staging hosting spend");
    expect(header().getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(header().getAttribute("aria-controls")!)!;
    expect(body.hidden).toBe(true);
    expect(body.childElementCount).toBe(0);

    // The task chip stays a link of its own, outside the button.
    const chip = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "DEMO-398")!;
    expect(chip.getAttribute("href")).toBe("/issues/DEMO-398");
    expect(chip.closest("button")).toBeNull();
    expect(header().querySelector("a")).toBeNull();

    // Nothing can be decided, and nothing of the summary is drawn.
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("textarea")).toBeNull();
    expect(text).not.toContain("Provider X meets every condition");
    expect(text).not.toContain("View details");

    act(() => header().click());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("draws the summary and the decision controls only when open, and marks the open card", () => {
    const onOpenChange = vi.fn();
    const props = {
      approval: createApproval(),
      onOpenChange,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
    };
    render({ ...props, open: false });
    expect(card().className).not.toContain("ring-1");
    const closedHeader = header();

    render({ ...props, open: true });
    // The same button, so a keyboard user who opened the card is still on it.
    expect(header()).toBe(closedHeader);
    expect(header().getAttribute("aria-expanded")).toBe("true");
    const body = document.getElementById(header().getAttribute("aria-controls")!)!;
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain("Provider X meets every condition in the request.");
    expect(button("Approve")).toBeDefined();
    expect(button("Reject")).toBeDefined();
    expect(card().className).toContain("ring-1");
    // The mark of the open card uses the strong token: the usual ring colour is under 3:1 in the light theme.
    expect(card().className).toContain("border-primary");
    expect(card().className).toContain("ring-primary");
    expect(card().className).not.toContain("border-ring");
    // The one-line preview gives way to the full recommendation.
    expect(ask()).toBeNull();
    expect(header().querySelector("span")!.className).not.toContain("truncate");

    act(() => header().click());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("decides nothing from the keyboard while closed, and nothing on a held key", () => {
    const onApprove = vi.fn();
    const props = {
      approval: createApproval(),
      onApprove,
      onReject: vi.fn(),
      onRequestRevision: vi.fn(),
      enableShortcuts: true,
    };
    render({ ...props, open: false });
    expect(card().tabIndex).toBe(-1);
    press("A");
    press("C");
    press("X");
    expect(onApprove).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")).toBeNull();

    render({ ...props, open: true });
    press("A", { repeat: true });
    expect(onApprove).not.toHaveBeenCalled();
    press("A");
    expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("can take focus from the page when asked to, also with shortcuts off", () => {
    render({ approval: createApproval(), open: false });
    expect(card().hasAttribute("tabindex")).toBe(false);
    render({ approval: createApproval(), open: false, focusable: true });
    expect(card().tabIndex).toBe(-1);
  });

  it("gives the one line for a hire and for a strategy, and none when the request carries nothing to show", () => {
    render({
      approval: createApproval({
        type: "hire_agent",
        payload: { name: "Pricing Analyst", capabilities: "Tracks competitor prices weekly.\nWrites `weekly_report`." },
      }),
      open: false,
    });
    expect(container.querySelector("h3")!.textContent).toBe("Pricing Analyst");
    expect(ask()).toBe("What it will do: Tracks competitor prices weekly. Writes weekly_report.");

    render({
      approval: createApproval({
        type: "approve_ceo_strategy",
        payload: { title: "Q4 strategy", plan: "\n## Grow wholesale\n1. Hire one analyst.\n2. Cut returns." },
      }),
      open: false,
    });
    expect(ask()).toBe("Plan: Grow wholesale");

    render({
      approval: createApproval({
        type: "approve_ceo_strategy",
        payload: { title: "Q4 strategy", rationale: "Wholesale margins are higher.\nRetail is flat." },
      }),
      open: false,
    });
    expect(ask()).toBe("Plan: Wholesale margins are higher.");

    render({ approval: createApproval({ payload: { title: "Bare request", reasoning: "No action named." } }), open: false });
    expect(ask()).toBeNull();
    render({ approval: createApproval({ type: "hire_agent", payload: { name: "Pricing Analyst" } }), open: false });
    expect(ask()).toBeNull();

    // A request titled by its own recommendation does not say it twice.
    render({ approval: createApproval({ payload: { recommendedAction: "Approve provider X." } }), open: false });
    expect(container.querySelector("h3")!.textContent).toBe("Approve provider X.");
    expect(ask()).toBeNull();
  });

  it("says on the closed row that a decision is sending, that one failed, and when it was decided", () => {
    render({
      approval: createApproval(),
      open: false,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      isPending: true,
      pendingAction: "approve",
    });
    expect(container.textContent).toContain("Sending your decision...");

    render({
      approval: createApproval(),
      open: false,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      error: "Error while approving: Session expired",
    });
    expect(container.textContent).not.toContain("Sending your decision...");
    expect(container.querySelector("[role='alert']")!.textContent).toBe("Error while approving: Session expired");

    render({
      approval: createApproval({ status: "rejected", decidedAt: new Date("2026-10-06T09:00:00.000Z") }),
      open: false,
    });
    expect(container.textContent).toContain("Rejected 3h ago");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("says on the closed row that the request was revised, and asks for the review once it is opened", () => {
    const first = createApproval();
    const props = { onApprove: vi.fn(), onReject: vi.fn() };
    render({ approval: first, open: false, ...props });
    expect(container.textContent).not.toContain("Revised while this page was open");

    const revised = createApproval({
      updatedAt: new Date("2026-10-06T11:00:00.000Z"),
      payload: { ...(first.payload as Record<string, unknown>), recommendedAction: "Approve provider Y instead." },
    });
    render({ approval: revised, open: false, ...props });
    expect(container.textContent).toContain("Revised while this page was open");
    expect(ask()).toBe("Recommendation: Approve provider Y instead.");
    expect(button("I have reviewed it")).toBeUndefined();

    render({ approval: revised, open: true, ...props });
    expect(button("I have reviewed it")).toBeDefined();
    act(() => button("Approve")!.click());
    expect(props.onApprove).not.toHaveBeenCalled();
  });

  it("says on the closed row that a typed text was not sent, and which kind", () => {
    const props = { onApprove: vi.fn(), onReject: vi.fn(), onRequestRevision: vi.fn() };
    const marker = () => container.querySelector("[data-approval-unsent-note]")?.textContent ?? null;

    render({ approval: createApproval(), open: false, ...props });
    expect(marker()).toBeNull();
    render({ approval: createApproval(), open: false, unsentNote: "note", ...props });
    expect(marker()).toBe("Note not sent");
    render({ approval: createApproval(), open: false, unsentNote: "revision", ...props });
    expect(marker()).toBe("Change request not sent");
    render({ approval: createApproval(), open: false, unsentNote: "reject", ...props });
    expect(marker()).toBe("Rejection reason not sent");

    // The open card shows the text itself; a request that can no longer be decided here has nowhere to send it.
    render({ approval: createApproval(), open: true, unsentNote: "note", ...props });
    expect(marker()).toBeNull();
    render({ approval: createApproval({ status: "approved" }), open: false, unsentNote: "note", ...props });
    expect(marker()).toBeNull();
  });

  it("remembers the version first shown and a confirmed revision in the page's memory, across being drawn again", () => {
    const first = createApproval();
    const revised = createApproval({
      updatedAt: new Date("2026-10-06T11:00:00.000Z"),
      payload: { ...(first.payload as Record<string, unknown>), recommendedAction: "Approve provider Y instead." },
    });
    const notice = () => container.querySelector<HTMLElement>("[data-approval-revised]");
    const remount = (props: Partial<ComponentProps<typeof ApprovalCard>> & { approval: Approval }) => {
      act(() => root.unmount());
      root = createRoot(container);
      render(props);
    };
    const onApprove = vi.fn();
    const props = { onApprove, onReject: vi.fn() };

    // Without a memory a card drawn again knows only the version it is drawn with.
    render({ approval: first, ...props });
    remount({ approval: revised, ...props });
    expect(notice()).toBeNull();

    const revisionMemory = createApprovalRevisionMemory();
    remount({ approval: first, revisionMemory, ...props });
    expect(notice()).toBeNull();
    // The request leaves the page and returns in another version: the card that is drawn then is held back.
    remount({ approval: revised, revisionMemory, ...props });
    expect(notice()!.dataset.approvalRevised).toBe("unreviewed");
    act(() => button("Approve")!.click());
    expect(onApprove).not.toHaveBeenCalled();
    // Still unconfirmed when it is drawn once more, also as a closed row.
    remount({ approval: revised, revisionMemory, open: false, ...props });
    expect(container.textContent).toContain("Revised while this page was open");

    remount({ approval: revised, revisionMemory, ...props });
    act(() => button("I have reviewed it")!.click());
    expect(notice()!.dataset.approvalRevised).toBe("reviewed");
    // The confirmation is kept: drawn again, the card does not ask a second time.
    remount({ approval: revised, revisionMemory, ...props });
    expect(notice()!.dataset.approvalRevised).toBe("reviewed");
    act(() => button("Approve")!.click());
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("leaves a card that is not collapsible as it was: always open, with a plain heading", () => {
    act(() =>
      root.render(
        <ApprovalCard requesterAgent={null} approval={createApproval()} onApprove={vi.fn()} onReject={vi.fn()} open={false} />,
      ));
    expect(container.querySelector("h3")!.querySelector("button")).toBeNull();
    expect(button("Approve")).toBeDefined();
    expect(container.textContent).toContain("Provider X meets every condition in the request.");
    expect(card().className).not.toContain("ring-1");
  });

  it("is a group named by its title, open, closed and when it is not collapsible", () => {
    const props = { approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn() };
    const name = () => document.getElementById(card().getAttribute("aria-labelledby")!)!.textContent;

    render({ ...props, open: false });
    expect(card().getAttribute("role")).toBe("group");
    expect(name()).toBe("Approve staging hosting spend");
    // The header button is read with the row's kind, status and waiting time.
    const described = document.getElementById(header().getAttribute("aria-describedby")!)!;
    expect(described.textContent).toContain("Board Approval");
    expect(described.textContent).toContain("pending");
    expect(described.textContent).toContain("Waiting 1 day");

    render({ ...props, open: true });
    expect(card().getAttribute("role")).toBe("group");
    expect(name()).toBe("Approve staging hosting spend");

    // Under the h3 title, the labels of the open card's sections are h4 headings.
    expect(card().querySelector("h3")!.textContent).toBe("Approve staging hosting spend");
    expect([...card().querySelectorAll("h4")].map((heading) => heading.textContent)).toContain("Recommendation");

    act(() => root.render(<ApprovalCard requesterAgent={null} {...props} />));
    expect(card().getAttribute("role")).toBe("group");
    expect(name()).toBe("Approve staging hosting spend");
    expect(document.getElementById(card().getAttribute("aria-labelledby")!)!.tagName).toBe("H3");
  });

  it("decides with Caps Lock on, where Shift+A arrives as a lower-case letter, and never on a plain letter", () => {
    const onApprove = vi.fn();
    render({ approval: createApproval(), open: true, onApprove, onReject: vi.fn(), onRequestRevision: vi.fn(), enableShortcuts: true });

    // No Shift: nothing, whichever case the letter arrives in.
    press("a", { shiftKey: false });
    press("A", { shiftKey: false });
    press("x", { shiftKey: false });
    expect(onApprove).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Reject this request?");

    // Shift with Caps Lock on: "c", "x" and "a".
    press("c");
    expect(container.textContent).toContain("What should change?");
    act(() => button("Cancel")!.click());
    press("x");
    expect(container.textContent).toContain("Reject this request?");
    act(() => button("Cancel")!.click());

    const approveKey = new KeyboardEvent("keydown", { key: "a", shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      card().dispatchEvent(approveKey);
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    // Claimed, so the app-wide "c" (new task) and the like do not also fire.
    expect(approveKey.defaultPrevented).toBe(true);

    // Another modifier still decides nothing.
    press("a", { ctrlKey: true });
    press("a", { metaKey: true });
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("keeps the held-back message region on the page before it has text", () => {
    render({
      approval: createApproval({ payload: emailPayload(emailDraftBody(2000)) }),
      open: true,
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    const region = container.querySelector<HTMLElement>("[data-approval-held-back]")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    // Empty, it is hidden from sight only: `display: none` would take the region out of the
    // accessibility tree, and a message arriving in it would not be spoken.
    expect(region.className).toContain("empty:sr-only");
    expect(region.className).not.toContain("hidden");

    // The message arrives in the same node.
    act(() => button(READ_TO_APPROVE)!.click());
    expect(container.querySelector("[data-approval-held-back]")).toBe(region);
    expect(region.textContent).toBe("Read the full reply, then approve.");
  });

  it("reports its error as an alert unless the page says it announces outcomes itself", () => {
    const error = "Error while approving: Session expired";
    const props = { approval: createApproval(), onApprove: vi.fn(), onReject: vi.fn(), error };
    const line = () =>
      container.querySelector<HTMLElement>("[data-approval-decision-error], [data-approval-row-error]")!;

    // The detail page, the inbox and a task page have no announcer of their own: the line is an alert.
    for (const open of [true, false]) {
      render({ ...props, open });
      expect(line().textContent).toBe(error);
      expect(line().getAttribute("role")).toBe("alert");
    }
    render({ ...props, approval: createApproval({ status: "approved" }), open: true });
    expect(line().getAttribute("role")).toBe("alert");

    // The queue announces each outcome in its live region: the same lines are plain text there.
    for (const open of [true, false]) {
      render({ ...props, open, announceError: false });
      expect(line().textContent).toBe(error);
      expect(line().hasAttribute("role")).toBe(false);
      expect(container.querySelector("[role='alert']")).toBeNull();
    }
    render({ ...props, approval: createApproval({ status: "approved" }), open: true, announceError: false });
    expect(line().textContent).toBe(error);
    expect(container.querySelector("[role='alert']")).toBeNull();

    // Open, Approve stays described by the error either way.
    render({ ...props, open: true, announceError: false });
    expect(button("Approve")!.getAttribute("aria-describedby")).toBe(line().id);
    expect(header().getAttribute("aria-describedby")!.split(" ")).toHaveLength(1);
    // Closed, the header button is described by it, so the reader who tabs to the row hears it.
    render({ ...props, open: false, announceError: false });
    expect(header().getAttribute("aria-describedby")!.split(" ")).toContain(line().id);
  });

  it("keeps the task links, the times and the error out from under the header's click area", () => {
    render({
      approval: createApproval({ createdAt: new Date("2026-09-27T12:00:00.000Z") }),
      requesterAgent: { id: "agent-requester", name: "Pricing Analyst" } as Agent,
      linkedIssues: [{ id: ISSUE_ID, identifier: "DEMO-398", title: "Staging environment" }],
      open: false,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      error: "Error while approving: Session expired",
    });
    const classes = (element: Element) => element.className.split(/\s+/);

    // The click area is the header button's, stretched over the header.
    expect(classes(header())).toEqual(expect.arrayContaining(["after:absolute", "after:inset-0"]));
    // A task link is a target of its own: above that area and at least 24px tall.
    const chip = [...container.querySelectorAll("a")].find((link) => link.textContent === "DEMO-398")!;
    expect(classes(chip)).toEqual(expect.arrayContaining(["relative", "z-10", "inline-flex", "min-h-6", "items-center"]));
    // The line with the requester and the waiting time is above it too: its exact time shows on
    // hover and its text can be selected.
    const waiting = [...container.querySelectorAll("span")].find((span) => span.textContent === "Waiting 9 days")!;
    expect(waiting.getAttribute("title")).toBe(new Date("2026-09-27T12:00:00.000Z").toLocaleString());
    expect(classes(waiting.parentElement!)).toEqual(expect.arrayContaining(["relative", "z-10"]));
    // So is the error a closed row shows.
    const error = container.querySelector("[data-approval-row-error]")!;
    expect(classes(error)).toEqual(expect.arrayContaining(["relative", "z-10"]));
    // Two lines at most, so a long message does not push the card being read down the page; the
    // whole message is on hover, and above the buttons once the card is open.
    expect(classes(error)).toContain("line-clamp-2");
    expect(error.getAttribute("title")).toBe(error.textContent);
    // The title and the one line of what is asked stay the place to click.
    expect(classes(header().querySelector("span")!)).not.toContain("z-10");
    expect(classes(container.querySelector("[data-approval-ask]")!)).not.toContain("z-10");

    // A card that is not collapsible has no stretched area, and nothing is raised.
    act(() =>
      root.render(
        <ApprovalCard
          requesterAgent={null}
          approval={createApproval()}
          linkedIssues={[{ id: ISSUE_ID, identifier: "DEMO-398", title: "Staging environment" }]}
        />,
      ));
    const plainChip = [...container.querySelectorAll("a")].find((link) => link.textContent === "DEMO-398")!;
    expect(classes(plainChip)).not.toContain("z-10");
    expect(classes(plainChip)).toContain("min-h-6");
  });

  it("marks the card that holds focus when shortcuts act on it and it is not collapsible", () => {
    act(() =>
      root.render(
        <ApprovalCard requesterAgent={null} approval={createApproval()} onApprove={vi.fn()} onReject={vi.fn()} enableShortcuts />,
      ));
    expect(card().className).toContain("focus-within:ring-1");
    act(() =>
      root.render(
        <ApprovalCard requesterAgent={null} approval={createApproval()} onApprove={vi.fn()} onReject={vi.fn()} />,
      ));
    expect(card().className).not.toContain("focus-within:ring-1");
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

    const continues = () => container.querySelector("[data-approval-draft-continues]")?.textContent ?? null;

    expect(shownBody()).not.toContain(DRAFT_ENDING);
    expect(shownBody()).not.toContain("\u2026");
    expect(continues()).toBe(
      `The reply continues: ${(body.length - shownBody().length).toLocaleString()} more characters.`,
    );
    act(() => button(`Show full reply (${body.length.toLocaleString()} characters)`)!.click());
    expect(shownBody()).toBe(body);
    expect(continues()).toBeNull();
    act(() => button("Show less")!.click());
    expect(shownBody()).not.toContain(DRAFT_ENDING);
    expect(continues()).not.toBeNull();
    expect(button(`Show full reply (${body.length.toLocaleString()} characters)`)).toBeDefined();
  });

  it("counts a single hidden character in the singular", () => {
    act(() =>
      root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload("x".repeat(1501))} />),
    );
    expect(container.querySelector("[data-approval-draft-body]")!.textContent).toBe("x".repeat(1500));
    expect(container.querySelector("[data-approval-draft-continues]")!.textContent).toBe(
      "The reply continues: 1 more character.",
    );
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

  const labels = () => [...container.querySelectorAll("h4, p, dt")].map((element) => element.textContent);
  const summaryOf = (payload: Record<string, unknown>, type = "request_board_approval") =>
    act(() => root.render(<ApprovalDecisionSummary type={type} payload={payload} />));

  it("leads with the summary when the request says it nowhere else", () => {
    // The shape the agent instructions show: the cost sits in `summary`, beside a title and a rationale.
    render({
      approval: createApproval({
        payload: {
          title: "Approve staging hosting spend",
          summary: "Estimated cost is $42/month for provider X.",
          recommendedAction: "Approve provider X.",
          reasoning: "Provider X meets every condition in the request.",
          pros: ["Fixed monthly commitment."],
          risks: ["The bill rises if traffic doubles."],
        },
      }),
    });

    const text = container.textContent ?? "";
    expect(text).toContain("SummaryEstimated cost is $42/month for provider X.");
    expect(text.indexOf("SummaryEstimated cost")).toBeLessThan(text.indexOf("RecommendationApprove provider X."));
    expect(text).toContain("WhyProvider X meets every condition in the request.");
  });

  it("shows a long summary by its first lines, as plain text, and whole where the page asks for it", () => {
    const summary = `**Cost:** ${"The provider bills per seat and per region. ".repeat(12)}Total is $420/month.`;
    const payload = { title: "Approve hosting", summary, recommendedAction: "Approve.", reasoning: "It fits." };
    summaryOf(payload);
    expect(container.textContent).not.toContain("Total is $420/month.");
    expect(container.textContent).not.toContain("**");
    expect(container.querySelector("strong")).toBeNull();
    const more = button("Show more")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(container.textContent).toContain("Total is $420/month.");

    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} full />));
    expect(container.textContent).toContain("Total is $420/month.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("does not repeat a summary that is already shown as the rationale, the recommendation or the title", () => {
    // With no rationale of its own, the request's summary is what "Why" shows.
    summaryOf({ title: "Approve hosting", summary: "Costs $42/month.", recommendedAction: "Approve." });
    expect(labels()).not.toContain("Summary");
    expect(container.textContent).toContain("WhyCosts $42/month.");
    expect((container.textContent ?? "").split("Costs $42/month.")).toHaveLength(2);

    // The same words as the recommendation, whatever the case and spacing.
    summaryOf({ title: "Approve hosting", summary: "  approve   provider X. ", recommendedAction: "Approve provider X.", reasoning: "It fits." });
    expect(labels()).not.toContain("Summary");

    // With no title, the summary is the title the card already shows.
    render({ approval: createApproval({ payload: { summary: "Costs $42/month.", recommendedAction: "Approve.", reasoning: "It fits." } }) });
    expect(container.querySelector("h3")!.textContent).toBe("Costs $42/month.");
    expect(labels()).not.toContain("Summary");

    // A title cuts a long subject; a summary too long to be shown whole as the title is not dropped.
    const long = `${"The provider bills per seat and per region. ".repeat(4)}Total is $420/month.`;
    render({ approval: createApproval({ payload: { summary: long, recommendedAction: "Approve.", reasoning: "It fits." } }) });
    expect(container.querySelector("h3")!.textContent).not.toContain("Total is $420/month.");
    expect(labels()).toContain("Summary");
    expect(container.textContent).toContain("Total is $420/month.");

    // Hire and strategy approvals have their own summaries.
    summaryOf({ name: "Clerk", summary: "Costs $42/month.", capabilities: "Files invoices." }, "hire_agent");
    expect(labels()).not.toContain("Summary");
    summaryOf({ plan: "Grow.", summary: "Costs $42/month.", reasoning: "It fits." }, "approve_ceo_strategy");
    expect(labels()).not.toContain("Summary");
  });

  it("labels the channel of an email draft Via, and shows From only for a sender the request names", () => {
    const envelope = () =>
      [...container.querySelectorAll("[data-approval-draft] dl > div")].map((row) => [
        row.querySelector("dt")!.textContent,
        row.querySelector("dd")!.textContent,
      ]);

    summaryOf({ ...emailPayload("Hi Sam."), channel: "email from info@" });
    expect(envelope()).toEqual([
      ["Via", "email from info@"],
      ["To", "buyer@example.test"],
      ["Subject", "Re: Wholesale price list"],
    ]);

    summaryOf({ ...emailPayload("Hi Sam."), channel: "email from info@", from: "info@example.test" });
    expect(envelope()).toEqual([
      ["Via", "email from info@"],
      ["From", "info@example.test"],
      ["To", "buyer@example.test"],
      ["Subject", "Re: Wholesale price list"],
    ]);

    // A sender that is not text is not shown.
    summaryOf({ ...emailPayload("Hi Sam."), from: { address: "info@example.test" } });
    expect(envelope().map(([label]) => label)).toEqual(["To", "Subject"]);
  });

  it("says what approving an email reply does, only while it is open and only when nobody else has said it", () => {
    const effect = () => container.querySelector("[data-approval-reply-effect]");
    const summary = (
      payload: Record<string, unknown>,
      props: { status?: string; requestedByAgentId?: string | null } = {},
    ) =>
      act(() =>
        root.render(
          <ApprovalDecisionSummary
            type="request_board_approval"
            payload={payload}
            status="pending"
            requestedByAgentId="agent-requester"
            {...props}
          />,
        ),
      );

    // On the card: after the draft, before the buttons.
    render({ approval: createApproval({ payload: emailPayload("Hi Sam.") }), onApprove: vi.fn(), onReject: vi.fn() });
    expect(effect()!.textContent).toBe("If approved, the requester is told to send this reply to buyer@example.test.");
    const draft = container.querySelector("[data-approval-draft]")!;
    expect(draft.compareDocumentPosition(effect()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(effect()!.compareDocumentPosition(button("Approve")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The sentence claims no sending by Paperclip itself.
    expect(effect()!.textContent).not.toMatch(/is sent|will be sent|sends/);

    // The agent's own line is the one shown.
    summary({ ...emailPayload("Hi Sam."), nextActionOnApproval: "I send the reply and close the ticket." });
    expect(effect()).toBeNull();
    expect(container.textContent).toContain("If approvedI send the reply and close the ticket.");

    // A decision wakes the requesting agent and nobody else: with no such agent, nobody is told.
    summary(emailPayload("Hi Sam."), { requestedByAgentId: null });
    expect(effect()).toBeNull();
    render({ approval: createApproval({ requestedByAgentId: null, payload: emailPayload("Hi Sam.") }), onApprove: vi.fn(), onReject: vi.fn() });
    expect(effect()).toBeNull();

    // Only while the decision is open.
    for (const status of ["approved", "rejected", "revision_requested", "cancelled"]) {
      summary(emailPayload("Hi Sam."), { status });
      expect(effect()).toBeNull();
    }
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload("Hi Sam.")} requestedByAgentId="agent-requester" />));
    expect(effect()).toBeNull();

    // Without a recipient there is nobody to name; a request that is not an email has no such line.
    const { recipient: _recipient, ...noRecipient } = emailPayload("Hi Sam.");
    summary(noRecipient);
    expect(container.querySelector("[data-approval-draft]")).not.toBeNull();
    expect(effect()).toBeNull();
    summary({ title: "Approve hosting", recommendedAction: "Approve.", recipient: "buyer@example.test" });
    expect(effect()).toBeNull();

    // A recipient written over several lines stays one sentence.
    summary({ ...emailPayload("Hi Sam."), recipient: "Sam Example\n  <sam@example.test>" });
    expect(effect()!.textContent).toBe(
      "If approved, the requester is told to send this reply to Sam Example <sam@example.test>.",
    );
  });

  describe("who sent the original request", () => {
    const AGENT_ID = "44444444-4444-4444-8444-444444444444";
    const UNKNOWN_ID = "55555555-5555-4555-8555-555555555555";
    const SENT_AT = "2026-10-07T01:23:48.000Z";
    const provenance = () =>
      [...container.querySelectorAll("h4")].find((p) => p.textContent === "Original request")!.nextElementSibling!
        .textContent ?? "";
    const withSource = (source: Record<string, unknown>) => ({
      title: "Approve staging hosting spend",
      recommendedAction: "Approve provider X.",
      reasoning: "It meets the request.",
      pros: ["Fixed cost."],
      risks: ["May rise."],
      originalRequest: { text: "Use provider X if it stays under $50.", source },
    });
    const comment = (sender?: string) =>
      withSource({
        kind: "paperclip_comment",
        commentId: COMMENT_ID,
        issueId: ISSUE_ID,
        ...(sender ? { sender } : {}),
        sentAt: SENT_AT,
        reference: `paperclip-comment:${COMMENT_ID}`,
        snapshotOrigin: "server",
      });
    const resolveAgentName = (agentId: string) => (agentId === AGENT_ID ? "Operations Lead" : null);
    const time = new Date(SENT_AT).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

    it("names the agent that wrote the comment, and prints the time to the minute", () => {
      render({ approval: createApproval({ payload: comment(AGENT_ID) }), resolveAgentName });
      expect(provenance()).toBe(`Operations Lead · ${time} · Saved from the original comment · View comment`);
      expect(provenance()).not.toMatch(/\d:\d\d:\d\d/);
      expect(container.querySelector("time")!.getAttribute("datetime")).toBe(SENT_AT);
      expect(container.textContent).not.toContain(AGENT_ID);
    });

    it("shows Board for the local board user and never prints an id it cannot resolve", () => {
      render({ approval: createApproval({ payload: comment("local-board") }), resolveAgentName });
      expect(provenance()).toBe(`Board · ${time} · Saved from the original comment · View comment`);
      expect(container.textContent).not.toContain("local-board");

      // An agent the list does not hold, a list that is not loaded yet, and no resolver at all.
      for (const [sender, resolver] of [
        [UNKNOWN_ID, resolveAgentName],
        [AGENT_ID, () => undefined],
        [AGENT_ID, undefined],
      ] as const) {
        render({ approval: createApproval({ payload: comment(sender) }), resolveAgentName: resolver });
        expect(provenance()).toBe(`${time} · Saved from the original comment · View comment`);
        expect(container.textContent).not.toContain(sender);
      }

      // A comment written by a board user (its id is not an agent's) is the Board's, also while agents load.
      for (const [sender, resolver] of [
        ["u_8Hq2LmZx0PaYt4Wc", resolveAgentName],
        ["local-implicit", resolveAgentName],
        ["u_8Hq2LmZx0PaYt4Wc", undefined],
      ] as const) {
        render({ approval: createApproval({ payload: comment(sender) }), resolveAgentName: resolver });
        expect(provenance()).toBe(`Board · ${time} · Saved from the original comment · View comment`);
        expect(container.textContent).not.toContain(sender);
      }

      render({ approval: createApproval({ payload: comment() }), resolveAgentName });
      expect(provenance()).toBe(`${time} · Saved from the original comment · View comment`);
    });

    it("keeps a sender an external source names, unless it is an id, and says the text is not verified", () => {
      const external = (sender: string) =>
        withSource({ kind: "external", channel: "Email", sender, sentAt: SENT_AT, reference: "thread 8841", snapshotOrigin: "requester" });
      render({ approval: createApproval({ payload: external("Sam Example <sam@example.test>") }), resolveAgentName });
      expect(provenance()).toBe(
        `Email · Sam Example <sam@example.test> · ${time} · thread 8841 · Quoted by the requesting agent, not verified`,
      );

      render({ approval: createApproval({ payload: external(AGENT_ID) }), resolveAgentName });
      expect(provenance()).toBe(`Email · Operations Lead · ${time} · thread 8841 · Quoted by the requesting agent, not verified`);

      for (const sender of [UNKNOWN_ID, "local-board-2"]) {
        render({ approval: createApproval({ payload: external(sender) }), resolveAgentName });
        expect(provenance()).toBe(`Email · ${time} · thread 8841 · Quoted by the requesting agent, not verified`);
      }
    });

    it("leaves out a time that is not a date", () => {
      render({
        approval: createApproval({
          payload: withSource({ kind: "external", sender: "Sam Example", sentAt: "last Tuesday", snapshotOrigin: "requester" }),
        }),
      });
      expect(provenance()).toBe("Sam Example · Quoted by the requesting agent, not verified");
      expect(container.querySelector("time")).toBeNull();
    });
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

    // The preview is the draft's own first characters: nothing is added to mark the cut.
    const words = "word ".repeat(400);
    const cut = approvalDraftPreview(words)!;
    expect(cut.endsWith("word")).toBe(true);
    expect(words.startsWith(cut)).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(1500);
    expect(cut.length).toBeGreaterThan(1490);

    // Many short lines are not cut by a line count: only the length counts.
    const lines = "Line.\n".repeat(300);
    expect(approvalDraftPreview(lines)!.split("\n").length).toBeGreaterThan(240);

    // An unbroken run is cut at the limit, never between the halves of one character.
    expect(approvalDraftPreview("x".repeat(1501))).toBe("x".repeat(1500));
    expect(approvalDraftPreview(`x${"\u{1F600}".repeat(800)}`)).toBe(`x${"\u{1F600}".repeat(749)}`);
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
