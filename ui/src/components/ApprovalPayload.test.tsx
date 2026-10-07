// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import {
  APPROVAL_TITLE_LENGTH,
  ApprovalPayloadRenderer,
  approvalDecisionBrief,
  approvalDraftPreview,
  approvalEmailDraft,
  approvalExcerpt,
  approvalLabel,
  approvalOriginalRequestSender,
  approvalSummaryText,
  approvalTextPreview,
  isEmailReplyPayload,
} from "./ApprovalPayload";
import { ThemeProvider } from "../context/ThemeContext";

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

describe("approvalDecisionBrief", () => {
  it("normalizes explicit reasoning, benefits, and tradeoffs without duplicates", () => {
    expect(
      approvalDecisionBrief({
        recommendedAction: "Approve the bounded test.",
        rationale: "It isolates the decision.",
        benefits: ["Fast feedback", "Fast feedback", "  Reversible  "],
        risks: ["May miss a long-tail case"],
        riskAssessment: "Rollback must remain available",
        tradeoffs: "Requires one follow-up check",
        nextActionOnApproval: "Run the dry test.",
      }),
    ).toEqual({
      recommendation: "Approve the bounded test.",
      reasoning: "It isolates the decision.",
      pros: ["Fast feedback", "Reversible"],
      cons: [
        "May miss a long-tail case",
        "Rollback must remain available",
        "Requires one follow-up check",
      ],
      nextAction: "Run the dry test.",
    });
  });

  it("uses the summary as reasoning when no explicit rationale is supplied", () => {
    expect(approvalDecisionBrief({ summary: "A concise decision summary." }).reasoning).toBe(
      "A concise decision summary.",
    );
  });
});

describe("approvalExcerpt", () => {
  it("removes lightweight markdown and truncates at a word boundary", () => {
    expect(approvalExcerpt("**Approve:** [Run the bounded check](https://example.test) now.", 32)).toBe(
      "Approve: Run the bounded check…",
    );
  });

  it("keeps a link target and the characters that are not markup", () => {
    expect(approvalExcerpt("**Approve:** [Run the bounded check](https://example.test/run_v2) now.")).toBe(
      "Approve: Run the bounded check (https://example.test/run_v2) now.",
    );
    expect(approvalExcerpt("Costs ~$42/month; run deploy_prod_v2 against orders_2026_q4")).toBe(
      "Costs ~$42/month; run deploy_prod_v2 against orders_2026_q4",
    );
    expect(approvalExcerpt("Margin is 3 * 12 = 36")).toBe("Margin is 3 * 12 = 36");
  });

  it("preserves order numbers and comparison symbols", () => {
    expect(approvalExcerpt("Order #90210: margin > cost")).toBe("Order #90210: margin > cost");
  });

  it("leaves a trace of an embedded image and does not rewrite numbers written with two asterisks", () => {
    expect(approvalExcerpt("see ![](https://files.example/receipt.png) attached")).toBe(
      "see [image] (https://files.example/receipt.png) attached",
    );
    expect(approvalExcerpt("see ![receipt](https://files.example/receipt.png) attached")).toBe(
      "see [image: receipt] (https://files.example/receipt.png) attached",
    );
    expect(approvalExcerpt("Compute grows from 2**10 to 2**12 units")).toBe("Compute grows from 2**10 to 2**12 units");
    expect(approvalExcerpt("Glob src/**/a.ts and test/**/b.ts")).toBe("Glob src/**/a.ts and test/**/b.ts");
    expect(approvalExcerpt("Rate: **$5**/unit")).toBe("Rate: $5/unit");
  });
});

describe("ApprovalCard", () => {
  it("states once that a request carries no source, pros or risks, without guessing its age", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalCard
          approval={{
            id: "approval-legacy",
            companyId: "company-1",
            type: "request_board_approval",
            requestedByAgentId: null,
            requestedByUserId: null,
            status: "pending",
            payload: { title: "Legacy decision" },
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            createdAt: new Date("2026-03-11T09:00:00.000Z"),
            updatedAt: new Date("2026-03-11T09:00:00.000Z"),
          } satisfies Approval}
          requesterAgent={null}
        />,
      );
    });

    expect(container.textContent).toContain("No original request attached");
    expect(container.textContent).toContain("No pros or risks were recorded.");
    // The interface cannot know when a request was filed: it says what is missing and nothing about why.
    expect(container.textContent).not.toContain("Older request");
    expect(container.textContent).not.toContain("Not supplied.");
    act(() => root.unmount());
    container.remove();
  });
});

describe("a cut never falls inside one character as the reader sees it", () => {
  const ACCENTED = "e\u0301"; // e with a combining acute accent
  const FLAG = "\u{1F1FA}\u{1F1F8}"; // two regional indicators
  const KEYCAP = "1\uFE0F\u20E3";
  const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  const THUMB = "\u{1F44D}\u{1F3FD}"; // thumbs up with a skin tone
  const clusters: Array<[string, string]> = [
    ["a letter and its accent", ACCENTED],
    ["a flag", FLAG],
    ["a keycap", KEYCAP],
    ["a joined emoji", FAMILY],
    ["an emoji and its skin tone", THUMB],
  ];
  /** Where the reader's characters start, read with the platform's own segmentation. */
  const boundaries = (text: string) => {
    const starts = new Set<number>([text.length]);
    for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) starts.add(part.index);
    return starts;
  };

  it.each(clusters)("keeps %s whole at the end of a one-line excerpt", (_name, cluster) => {
    // No space near the limit, and the cluster lies across it at every possible offset.
    for (let before = 120 - cluster.length + 1; before < 120; before += 1) {
      const text = `${"x".repeat(before)}${cluster}${"y".repeat(60)}`;
      expect(approvalExcerpt(text, 120)).toBe(`${"x".repeat(before)}\u2026`);
    }
    // A cluster that ends at the limit, or starts at it, is not touched.
    expect(approvalExcerpt(`${"x".repeat(120 - cluster.length)}${cluster}${"y".repeat(60)}`, 120)).toBe(
      `${"x".repeat(120 - cluster.length)}${cluster}\u2026`,
    );
    expect(approvalExcerpt(`${"x".repeat(120)}${cluster}${"y".repeat(60)}`, 120)).toBe(`${"x".repeat(120)}\u2026`);
  });

  it("pairs flag letters from the start of the text, not from the cut", () => {
    // Thirty flags fill 120 characters exactly; one letter in front moves every pair by one.
    expect(approvalExcerpt(FLAG.repeat(50), 120)).toBe(`${FLAG.repeat(30)}\u2026`);
    expect(approvalExcerpt(`a${FLAG.repeat(50)}`, 120)).toBe(`a${FLAG.repeat(29)}\u2026`);
    expect(approvalExcerpt(`ab${FLAG.repeat(50)}`, 120)).toBe(`ab${FLAG.repeat(29)}\u2026`);
  });

  it("ends a Thai title on a whole syllable wherever the limit falls", () => {
    const sentence = "\u0E15\u0E31\u0E49\u0E07\u0E41\u0E15\u0E48\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E1C\u0E39\u0E49\u0E08\u0E31\u0E14\u0E01\u0E32\u0E23\u0E2D\u0E19\u0E38\u0E21\u0E31\u0E15\u0E34\u0E04\u0E33\u0E02\u0E2D\u0E19\u0E35\u0E49".repeat(8);
    let movedBack = 0;
    for (let offset = 0; offset < 60; offset += 1) {
      const text = sentence.slice(offset);
      if (!boundaries(sentence).has(offset)) continue;
      const excerpt = approvalExcerpt(text, 120)!;
      const kept = excerpt.slice(0, -1);
      expect(excerpt.endsWith("\u2026")).toBe(true);
      expect(text.startsWith(kept)).toBe(true);
      expect(boundaries(text).has(kept.length)).toBe(true);
      expect(kept.length).toBeGreaterThan(110);
      if (kept.length < 120) movedBack += 1;
    }
    // The limit does fall inside a syllable for some of these starts: the check above is not idle.
    expect(movedBack).toBeGreaterThan(5);
  });

  it.each(clusters)("keeps %s whole at the end of a preview and of a draft preview", (_name, cluster) => {
    for (let before = 480 - cluster.length + 1; before < 480; before += 1) {
      const text = `${"x".repeat(before)}${cluster}${"y".repeat(60)}`;
      expect(approvalTextPreview(text, 6, 480)).toEqual({ preview: `${"x".repeat(before)}\u2026`, truncated: true });
    }
    // The draft is cut from its first characters only; the cut still sees the character it would split.
    for (let before = 1500 - cluster.length + 1; before < 1500; before += 1) {
      expect(approvalDraftPreview(`${"x".repeat(before)}${cluster}${"y".repeat(600)}`)).toBe("x".repeat(before));
    }
    expect(approvalDraftPreview(`${"x".repeat(1500 - cluster.length)}${cluster}${"y".repeat(600)}`)).toBe(
      `${"x".repeat(1500 - cluster.length)}${cluster}`,
    );
  });

  it("cuts a run of stacked marks at the limit and does not drop the whole text", () => {
    const stacked = `e${"\u0301".repeat(500)}`;
    expect(approvalExcerpt(stacked, 120)).toBe(`${stacked.slice(0, 120)}\u2026`);
    expect(approvalTextPreview(stacked, 6, 480).preview).toBe(`${stacked.slice(0, 480)}\u2026`);
  });

  it("still keeps the halves of a surrogate pair together in a browser without Intl.Segmenter", async () => {
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    Object.defineProperty(Intl, "Segmenter", { ...segmenter, value: undefined });
    try {
      vi.resetModules();
      const fallback = await import("./ApprovalPayload");
      expect(fallback.approvalExcerpt("\u{1F600}".repeat(10), 5)).toBe(`${"\u{1F600}".repeat(2)}\u2026`);
      expect(fallback.approvalExcerpt(`${"x".repeat(119)}${FLAG}${"y".repeat(60)}`, 120)).toBe(`${"x".repeat(119)}\u2026`);
      expect(fallback.approvalDraftPreview(`x${"\u{1F600}".repeat(800)}`)).toBe(`x${"\u{1F600}".repeat(749)}`);
      expect(fallback.approvalTextPreview("word ".repeat(200).trim(), 6, 480).preview.endsWith("word\u2026")).toBe(true);
      // Without it a letter loses its accent, as before: nothing throws and no half character is left.
      expect(fallback.approvalExcerpt(`${"x".repeat(119)}${ACCENTED}${"y".repeat(60)}`, 120)).toBe(`${"x".repeat(119)}e\u2026`);
    } finally {
      Object.defineProperty(Intl, "Segmenter", segmenter);
      vi.resetModules();
    }
  });
});

describe("approvalSummaryText", () => {
  const brief = { recommendedAction: "Approve provider X.", reasoning: "It meets every condition." };

  it("returns the summary when the surface shows it nowhere else", () => {
    expect(
      approvalSummaryText({ title: "Hosting spend", summary: " Estimated cost is $42/month. ", ...brief }, "request_board_approval"),
    ).toBe("Estimated cost is $42/month.");
    expect(approvalSummaryText({ title: "Hosting spend", ...brief })).toBeNull();
    expect(approvalSummaryText({ title: "Hosting spend", summary: "   ", ...brief })).toBeNull();
    expect(approvalSummaryText({ title: "Hosting spend", summary: 42, ...brief })).toBeNull();
    expect(approvalSummaryText(null)).toBeNull();
  });

  it("returns nothing for a summary shown as the rationale, the recommendation or the title", () => {
    // `reasoning` falls back to the summary, which is then shown under "Why".
    expect(approvalSummaryText({ title: "Hosting spend", summary: "Costs $42/month.", recommendedAction: "Approve." })).toBeNull();
    expect(approvalSummaryText({ title: "Hosting spend", summary: "it  MEETS\nevery condition.", ...brief })).toBeNull();
    expect(approvalSummaryText({ title: "Hosting spend", summary: "**Approve** provider X.", ...brief })).toBeNull();
    expect(approvalSummaryText({ title: "Hosting  spend", summary: "hosting spend", ...brief })).toBeNull();
    expect(approvalSummaryText({ summary: "Costs $42/month.", ...brief })).toBeNull();
  });

  it("returns a summary that is the title when the title is too long to be shown whole", () => {
    const fits = "x".repeat(APPROVAL_TITLE_LENGTH);
    expect(approvalSummaryText({ summary: fits, ...brief })).toBeNull();
    expect(approvalSummaryText({ summary: `${fits}y`, ...brief })).toBe(`${fits}y`);
  });
});

describe("approvalEmailDraft", () => {
  it("reads the channel as the way the reply goes out and the sender only from `from`", () => {
    expect(
      approvalEmailDraft({ channel: "email from info@", recipient: "a@example.com", subject: "Hello", body: "Hi" }),
    ).toEqual({ via: "email from info@", from: null, to: "a@example.com", subject: "Hello", body: "Hi" });
    expect(approvalEmailDraft({ from: " info@example.test ", subject: "Hello", body: "Hi" })).toEqual({
      via: null,
      from: "info@example.test",
      to: null,
      subject: "Hello",
      body: "Hi",
    });
    expect(approvalEmailDraft({ from: ["info@example.test"], subject: "Hello", body: "Hi" })?.from).toBeNull();
  });
});

describe("approvalOriginalRequestSender", () => {
  const agentId = "44444444-4444-4444-8444-444444444444";
  const resolve = (id: string) => (id === agentId ? "Operations Lead" : null);

  it("resolves the id the server stores for a Paperclip comment, or shows nothing", () => {
    const comment = (sender?: string) => ({ kind: "paperclip_comment" as const, sender });
    expect(approvalOriginalRequestSender(comment(agentId), resolve)).toBe("Operations Lead");
    expect(approvalOriginalRequestSender(comment("local-board"), resolve)).toBe("Board");
    expect(approvalOriginalRequestSender(comment("local-board"))).toBe("Board");
    expect(approvalOriginalRequestSender(comment(agentId))).toBeNull();
    expect(approvalOriginalRequestSender(comment(agentId), () => undefined)).toBeNull();
    expect(approvalOriginalRequestSender(comment(), resolve)).toBeNull();
  });

  it("shows Board for a comment a board user wrote, and never the user's id", () => {
    const comment = (sender?: string) => ({ kind: "paperclip_comment" as const, sender });
    // A user id is free text; an agent id is a UUID. Whatever a user id looks like, it is not printed.
    for (const userId of ["u_8Hq2LmZx0PaYt4Wc", "local-implicit-board", "kP3x9QmB2vLz7RtYw1Na5Hc8Dg4Js6Uf", "sam@example.test"]) {
      expect(approvalOriginalRequestSender(comment(userId), resolve)).toBe("Board");
      expect(approvalOriginalRequestSender(comment(userId), () => undefined)).toBe("Board");
      expect(approvalOriginalRequestSender(comment(userId))).toBe("Board");
    }
    // An agent id the list does not hold may be a removed agent: it is not called the Board.
    const removedAgent = "55555555-5555-4555-8555-555555555555";
    expect(approvalOriginalRequestSender(comment(removedAgent), resolve)).toBeNull();
    expect(approvalOriginalRequestSender(comment(removedAgent.toUpperCase()), resolve)).toBeNull();
  });

  it("keeps the sender of an external source as written unless it is an id", () => {
    const external = (sender: string) => ({ kind: "external" as const, sender });
    expect(approvalOriginalRequestSender(external("Sam Example <sam@example.test>"), resolve)).toBe(
      "Sam Example <sam@example.test>",
    );
    expect(approvalOriginalRequestSender(external("Customer"))).toBe("Customer");
    expect(approvalOriginalRequestSender(external(agentId), resolve)).toBe("Operations Lead");
    expect(approvalOriginalRequestSender(external("55555555-5555-4555-8555-555555555555"), resolve)).toBeNull();
    expect(approvalOriginalRequestSender(external("local-implicit"), resolve)).toBeNull();
    expect(approvalOriginalRequestSender(external("local-board"), resolve)).toBe("Board");
  });

  it("keeps an external sender that only starts with local-, and never calls an external sender Board by guess", () => {
    const external = (sender: string) => ({ kind: "external" as const, sender });
    expect(approvalOriginalRequestSender(external("local-pickup@shop.example"), resolve)).toBe("local-pickup@shop.example");
    expect(approvalOriginalRequestSender(external("Local-Pickup Desk <local-pickup@shop.example>"), resolve)).toBe(
      "Local-Pickup Desk <local-pickup@shop.example>",
    );
    expect(approvalOriginalRequestSender(external("local-pickup desk"), resolve)).toBe("local-pickup desk");
    // A bare local user id is still an id: left out, not printed and not named.
    expect(approvalOriginalRequestSender(external("local-implicit-board"), resolve)).toBeNull();
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
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
              reasoning: "The bounded reply is reversible and has no external side effects.",
              recommendedAction: "Approve the frog reply.",
              nextActionOnApproval: "Post the frog comment on the issue.",
              pros: ["The reply is clear and scoped."],
              risks: "The frog might be too powerful.",
              proposedComment: "(o)<",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("The bounded reply is reversible and has no external side effects.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("Pros");
    expect(container.textContent).toContain("The reply is clear and scoped.");
    expect(container.textContent).toContain("Risks");
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
        <ThemeProvider>
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
              pros: ["The customer gets a direct choice."],
              risks: "Customer may expect a firm restock date.",
              body: "Hi Marcus,\n\nThank you for your order #90210. The three boxes are briefly on backorder.",
            }}
          />
        </ThemeProvider>,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Update on Oxford Cigar order #90210");
    expect(text).toContain("ToMarcus Bellweather <m@example.com>");
    // `channel` describes how the reply goes out; it is not a sender address and is not labelled as one.
    expect(text).toContain("Viaemail from info@");
    expect(text).not.toContain("From");
    expect(text).toContain("WooCommerce order #90210");
    expect(text).toContain("Gate B");
    expect(text).toContain("Hi Marcus,");
    expect(text).toContain("Thank you for your order #90210.");
    expect(text).not.toContain("\"body\":");
    expect(text).toContain("Hold-vs-cancel choice for backordered Padrón lines.");
    expect(text).toContain("Send as written.");
    expect(text).toContain("The customer gets a direct choice.");
    expect(text).toContain("Customer may expect a firm restock date.");

    act(() => {
      root.unmount();
    });
  });

  it("renders markdown in board approval prose fields", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "**Bold** and `code` and [a link](https://example.com).",
              recommendedAction: "Approve the **frog** reply.",
              nextActionOnApproval: "Post the `frog` comment.",
              risks: ["The **frog** might be too powerful."],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(4);

    const summary = bodies[0];
    expect(summary.querySelector("strong")?.textContent).toBe("Bold");
    expect(summary.querySelector("code")?.textContent).toBe("code");
    const link = summary.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.textContent).toBe("a link");

    // The raw markdown characters must not survive into the rendered text.
    expect(container.textContent).not.toContain("**Bold**");
    expect(container.textContent).not.toContain("[a link](https://example.com)");

    // "Full request" uses the words of the panel above it: "Recommendation" and "If approved".
    const fullRequestText = container.textContent ?? "";
    expect(fullRequestText).toContain("RecommendationApprove the frog reply.");
    expect(fullRequestText).toContain("If approvedPost the frog comment.");
    expect(fullRequestText).not.toContain("Recommended action");
    expect(fullRequestText).not.toContain("On approval");

    // Fork layout order: recommendation, "Risks" list, then "If approved".
    expect(bodies[1].querySelector("strong")?.textContent).toBe("frog");
    expect(bodies[2].querySelector("strong")?.textContent).toBe("frog");
    expect(bodies[3].querySelector("code")?.textContent).toBe("frog");

    act(() => {
      root.unmount();
    });
  });

  it("does not nest a second bullet when a risk is authored as a markdown list item", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              risks: [
                "- **Leading dash** risk.",
                "* Leading star risk.",
                "• Leading dot risk.",
                "1. Leading number risk.",
                "2) Leading paren risk.",
              ],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(5);
    for (const body of bodies) {
      expect(body.querySelector("ul")).toBeNull();
      expect(body.querySelector("ol")).toBeNull();
      expect(body.querySelector("li")).toBeNull();
    }

    expect(bodies[0].querySelector("strong")?.textContent).toBe("Leading dash");
    expect(container.textContent).toContain("Leading star risk.");
    expect(container.textContent).toContain("Leading dot risk.");
    expect(container.textContent).toContain("Leading number risk.");
    expect(container.textContent).toContain("Leading paren risk.");
    expect(container.textContent).not.toContain("- **Leading dash**");

    act(() => {
      root.unmount();
    });
  });

  it("renders every risk when two entries collapse to the same text after marker stripping", () => {
    const root = createRoot(container);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      act(() => {
        root.render(
          <ThemeProvider>
            <ApprovalPayloadRenderer
              type="request_board_approval"
              payload={{
                title: "Reply with an ASCII frog",
                risks: ["- Low probability", "* Low probability"],
              }}
            />
          </ThemeProvider>,
        );
      });

      expect(container.querySelectorAll(".paperclip-markdown").length).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
      act(() => {
        root.unmount();
      });
    }
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            hidePrimaryTitle
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("shows the sender an email-reply approval names under From, beside the channel under Via", () => {
    const root = createRoot(container);
    const render = (payload: Record<string, unknown>) =>
      act(() => {
        root.render(
          <ThemeProvider>
            <ApprovalPayloadRenderer type="request_board_approval" payload={payload} />
          </ThemeProvider>,
        );
      });
    const payload = { channel: "email from info@", recipient: "m@example.com", subject: "Order update", body: "Hi Marcus." };

    render({ ...payload, from: "info@example.test" });
    expect(container.textContent).toContain("Viaemail from info@Frominfo@example.testTom@example.comSubjectOrder update");

    render({ ...payload, from: 42 });
    expect(container.textContent).toContain("Viaemail from info@Tom@example.comSubjectOrder update");
    expect(container.textContent).not.toContain("From");

    act(() => {
      root.unmount();
    });
  });

  it("resolves the author of a Paperclip comment in the full request, and prints no id", () => {
    const root = createRoot(container);
    const authorId = "44444444-4444-4444-8444-444444444444";
    const render = (sender: string, resolveAgentName?: (agentId: string) => string | null) =>
      act(() => {
        root.render(
          <ThemeProvider>
            <ApprovalPayloadRenderer
              type="request_board_approval"
              resolveAgentName={resolveAgentName}
              payload={{
                title: "Approve staging hosting spend",
                recommendedAction: "Approve provider X.",
                originalRequest: {
                  text: "Use provider X if it stays under $50.",
                  source: { kind: "paperclip_comment", sender, snapshotOrigin: "server" },
                },
              }}
            />
          </ThemeProvider>,
        );
      });

    render(authorId, (agentId) => (agentId === authorId ? "Operations Lead" : null));
    expect(container.textContent).toContain("Original requestOperations Lead · Saved from the original comment");

    render("local-board");
    expect(container.textContent).toContain("Original requestBoard · Saved from the original comment");
    expect(container.textContent).not.toContain("local-board");

    render(authorId);
    expect(container.textContent).toContain("Original requestSaved from the original comment");
    expect(container.textContent).not.toContain(authorId);

    act(() => {
      root.unmount();
    });
  });

  it("renders the verbatim original request as inert multiline text in decision order", () => {
    const root = createRoot(container);
    const original = "First line\n<script>alert('no')</script>\n**keep markdown markers**";

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              subject: "Synthetic request",
              recipient: "board@example.test",
              body: "Proposed outgoing reply — not the source",
              recommendedAction: "Approve the reply.",
              reasoning: "The response is bounded.",
              pros: ["Closes the loop"],
              risks: ["Could need revision"],
              originalRequest: {
                text: original,
                source: {
                  kind: "external",
                  sender: "Synthetic Sender",
                  sentAt: "2026-10-03T12:00:00.000Z",
                  reference: "fixture-message-1",
                  snapshotOrigin: "requester",
                },
              },
            }}
          />
        </ThemeProvider>,
      );
    });

    const text = container.textContent ?? "";
    // The email renderer of "Full request" uses the top panel's words: "Recommendation" and "Draft reply".
    expect(text).toContain("RecommendationApprove the reply.");
    expect(text).toContain("Draft replyProposed outgoing reply");
    expect(text).not.toContain("Recommended action");
    expect(text).not.toContain("Proposed reply");
    expect(text.indexOf("Recommendation")).toBeLessThan(text.indexOf("Original request"));
    expect(text.indexOf("Original request")).toBeLessThan(text.indexOf("Why"));
    expect(text.indexOf("Why")).toBeLessThan(text.indexOf("Pros"));
    expect(text.indexOf("Pros")).toBeLessThan(text.indexOf("Draft reply"));

    const proseBodies = Array.from(container.querySelectorAll("pre"));
    const originalRequest = proseBodies.find((element) => element.textContent === original);
    expect(originalRequest).toBeDefined();
    expect(originalRequest?.classList.contains("text-sm")).toBe(true);
    expect(originalRequest?.classList.contains("whitespace-pre-wrap")).toBe(true);
    // Long unbroken strings must wrap without splitting ordinary words mid-word.
    expect(originalRequest?.classList.contains("wrap-anywhere")).toBe(true);
    expect(originalRequest?.classList.contains("break-all")).toBe(false);
    expect(originalRequest?.classList.contains("font-mono")).toBe(false);
    expect(originalRequest?.classList.contains("text-xs")).toBe(false);
    // The whole text flows in the page: no height cap, no inner scroll box, no clamp.
    expect(originalRequest?.className).not.toMatch(/max-h-|overflow-|line-clamp/);

    const proposedReply = proseBodies.find(
      (element) => element.textContent === "Proposed outgoing reply — not the source",
    );
    expect(proposedReply).toBeDefined();
    expect(proposedReply?.classList.contains("text-sm")).toBe(true);
    expect(proposedReply?.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(proposedReply?.classList.contains("wrap-anywhere")).toBe(true);
    expect(proposedReply?.classList.contains("font-mono")).toBe(false);
    expect(proposedReply?.classList.contains("text-xs")).toBe(false);
    expect(proposedReply?.className).not.toMatch(/max-h-|overflow-|line-clamp/);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(original);
    expect(text).toContain("Quoted by the requesting agent, not verified");
    expect(text).not.toContain("snapshot");
    // The time is printed to the minute.
    const sentAt = container.querySelector("time")!;
    expect(sentAt.getAttribute("datetime")).toBe("2026-10-03T12:00:00.000Z");
    expect(sentAt.textContent).toBe(
      new Date("2026-10-03T12:00:00.000Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    );
    expect(sentAt.textContent).not.toMatch(/\d:\d\d:\d\d/);
    expect(text).toContain(`Synthetic Sender · ${sentAt.textContent} · fixture-message-1 · Quoted by the requesting agent, not verified`);

    act(() => {
      root.unmount();
    });
  });

  it("shows a long original request, proposed reply and proposed comment whole, with no button", () => {
    const root = createRoot(container);
    const original = `${"A long request line that the board must read to its end.\n".repeat(60)}Stop and ask first.`;
    const body = `${"A long reply line.\n".repeat(60)}Last line of the reply.`;
    const proposedComment = `${"A long comment line.\n".repeat(60)}Last line of the comment.`;
    const source = { kind: "external", sender: "Synthetic Sender" };

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{ subject: "Synthetic request", body, originalRequest: { text: original, source } }}
          />
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{ title: "Post a comment", proposedComment, originalRequest: { text: original, source } }}
          />
        </ThemeProvider>,
      );
    });

    const blocks = Array.from(container.querySelectorAll("pre"));
    expect(blocks.map((block) => block.textContent)).toEqual([original, body, original, proposedComment]);
    for (const block of blocks) {
      expect(block.className).not.toMatch(/max-h-|overflow-|line-clamp/);
      expect(block.classList.contains("whitespace-pre-wrap")).toBe(true);
      expect(block.classList.contains("wrap-anywhere")).toBe(true);
    }
    expect(container.querySelector("button")).toBeNull();
    act(() => root.unmount());
  });

  it("shows a strategy plan whole, and a plan that is not text as the request's data", () => {
    const root = createRoot(container);
    const plan = `${"A long plan line.\n".repeat(60)}Last line of the plan.`;

    act(() => {
      root.render(<ApprovalPayloadRenderer type="approve_ceo_strategy" payload={{ title: "Q4", plan }} />);
    });
    expect(container.textContent).toContain(plan);
    expect(container.querySelector("[class*='max-h-']")).toBeNull();

    act(() => {
      root.render(
        <ApprovalPayloadRenderer type="approve_ceo_strategy" payload={{ plan: { goals: ["Grow wholesale"] } }} />,
      );
    });
    expect(container.textContent).not.toContain("[object Object]");
    expect(container.textContent).toContain('"goals"');
    expect(container.textContent).toContain("Grow wholesale");
    expect(container.querySelector("[class*='max-h-']")).toBeNull();
    act(() => root.unmount());
  });

  it("does not relabel a draft body as the original request when the source is absent", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              subject: "Legacy email approval",
              recipient: "board@example.test",
              body: "Draft reply only",
              recommendedAction: "Approve",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("No original request was attached to this approval.");
    expect(container.textContent).toContain("Draft replyDraft reply only");
    expect(container.textContent).not.toContain("Proposed reply");
    act(() => root.unmount());
  });
});
