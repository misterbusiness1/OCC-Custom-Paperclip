// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalPayloadRenderer,
  approvalLabel,
  isEmailReplyPayload,
  extractApprovalMeta,
} from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("extractApprovalMeta", () => {
  it("normalises gate and risk from assorted payload spellings", () => {
    expect(extractApprovalMeta({ payload: { gate: "Gate A" } }).gate).toBe("A");
    expect(extractApprovalMeta({ payload: { gate: "b" } }).gate).toBe("B");
    expect(extractApprovalMeta({ payload: { riskLevel: "HIGH risk" } }).risk).toBe("high");
    expect(extractApprovalMeta({ payload: { severity: "moderate" } }).risk).toBe("medium");
  });

  it("builds an SLA label from slaHours and reads deadlines/timestamps", () => {
    const meta = extractApprovalMeta({
      payload: { slaHours: 24, dueAt: "2026-09-18T00:00:00.000Z" },
      requestedByAgentId: "agent-1",
      createdAt: "2026-09-17T00:00:00.000Z",
      decidedAt: null,
    });
    expect(meta.slaLabel).toBe("24h SLA");
    expect(meta.deadline).toBe("2026-09-18T00:00:00.000Z");
    expect(meta.requestedAt).toBe("2026-09-17T00:00:00.000Z");
    expect(meta.requestedByAgentId).toBe("agent-1");
    expect(meta.decidedAt).toBeNull();
  });

  it("degrades cleanly to nulls when no metadata is present", () => {
    expect(extractApprovalMeta({ payload: {} })).toEqual({
      gate: null,
      risk: null,
      slaLabel: null,
      deadline: null,
      requestedByAgentId: null,
      requestedAt: null,
      decidedAt: null,
    });
  });
});

describe("isEmailReplyPayload", () => {
  it("detects email replies by a body plus at least one envelope field", () => {
    expect(isEmailReplyPayload({ body: "Hi there", subject: "Re: order #90210" })).toBe(true);
    expect(isEmailReplyPayload({ body: "Hi there", recipient: "a@example.com" })).toBe(true);
    expect(isEmailReplyPayload({ body: "Hi there", channel: "email from info@" })).toBe(true);
  });

  it("ignores payloads without a body or without an envelope field", () => {
    expect(isEmailReplyPayload({ subject: "Re: order #90210", recipient: "a@example.com" })).toBe(false);
    expect(isEmailReplyPayload({ body: "Hi there" })).toBe(false);
    expect(isEmailReplyPayload({ body: "   ", subject: "Re: order #90210" })).toBe(false);
    expect(isEmailReplyPayload({})).toBe(false);
    expect(isEmailReplyPayload(null)).toBe(false);
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("renders an email-reply approval as an email preview with reasoning beneath", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Gate B approval: info@ reply for order #90210",
            channel: "email from info@",
            recipient: "Marcus Bellweather <m@example.com>",
            subject: "Update on Oxford Cigar order #90210",
            threadOrOrderRef: "WooCommerce order #90210",
            gate: "Gate B",
            intent: "Hold-vs-cancel choice for backordered Padrón lines.",
            recommendedAction: "Send as written.",
            risks: ["Customer may expect a firm restock date."],
            body: "Hi Marcus,\n\nThank you for your order #90210. The three boxes are briefly on backorder.",
          }}
        />,
      );
    });

    const text = container.textContent ?? "";
    // Envelope
    expect(text).toContain("Update on Oxford Cigar order #90210");
    expect(text).toContain("Marcus Bellweather <m@example.com>");
    expect(text).toContain("email from info@");
    expect(text).toContain("WooCommerce order #90210");
    expect(text).toContain("Gate B");
    // Body rendered as prose (not raw JSON)
    expect(text).toContain("Hi Marcus,");
    expect(text).toContain("Thank you for your order #90210.");
    expect(text).not.toContain("\"body\":");
    // Reasoning kept beneath
    expect(text).toContain("Hold-vs-cancel choice for backordered Padrón lines.");
    expect(text).toContain("Send as written.");
    expect(text).toContain("Customer may expect a firm restock date.");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});
