// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchParams: new URLSearchParams(),
  /** What the link that opened the page carried. "View details" in the queue carries the queue's address. */
  location: { state: null as unknown },
}));

const breadcrumbMock = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(),
  agentsList: vi.fn(),
  agentsRemove: vi.fn(),
}));

vi.mock("../api/approvals", () => ({ approvalsApi: apiMocks }));
vi.mock("../api/agents", () => ({
  agentsApi: { list: apiMocks.agentsList, remove: apiMocks.agentsRemove },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
  // The "Full request" section renders Markdown, which reads the company list when there is one.
  useOptionalCompany: () => null,
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbMock,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => routerMock.location,
  useNavigate: () => routerMock.navigate,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [routerMock.searchParams],
}));

import { ApprovalDetail, MARK_RESUBMITTED_CONFIRM } from "./ApprovalDetail";
import { ThemeProvider } from "../context/ThemeContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MANAGER_ID = "11111111-1111-4111-8111-111111111111";

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

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    routerMock.navigate.mockReset();
    routerMock.location.state = null;
    breadcrumbMock.setBreadcrumbs.mockReset();
    apiMocks.listComments.mockResolvedValue([]);
    apiMocks.listIssues.mockResolvedValue([]);
    apiMocks.agentsList.mockResolvedValue([
      { id: "agent-requester", name: "Operations Lead" },
      { id: MANAGER_ID, name: "Chief Executive" },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  /** The panel the board decides from: everything above "Full request". */
  const panel = () => container.querySelector<HTMLElement>("section[aria-labelledby='approval-title']")!;
  const render = async (approval: Approval, requesterName = "Operations Lead") => {
    apiMocks.get.mockResolvedValue(approval);
    await act(async () => {
      root.render(
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <ApprovalDetail />
          </QueryClientProvider>
        </ThemeProvider>,
      );
    });
    await vi.waitFor(() => expect(panel()).not.toBeNull());
    // The agent list resolves names (requester, a hire's manager).
    await vi.waitFor(() => expect(panel().textContent).toContain(requesterName));
  };
  /** The label of the last breadcrumb the page set. */
  const lastCrumb = () => {
    const crumbs = breadcrumbMock.setBreadcrumbs.mock.lastCall![0] as Array<{ label: string; href?: string }>;
    // Not opened from the queue: the way back is To decide, at this request.
    expect(crumbs[0]).toEqual({ label: "Approvals", href: "/approvals/pending#approval-approval-1" });
    expect(crumbs).toHaveLength(2);
    return crumbs[1].label;
  };
  const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  const isBefore = (first: Node, second: Node) =>
    Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  /** Controls above the decision buttons: in a summary shown in full there are none. */
  const controlsAboveDecision = () => {
    const approve = button(panel(), "Approve");
    expect(approve).toBeDefined();
    return [...panel().querySelectorAll("button, summary, [aria-expanded]")]
      .filter((control) => isBefore(control, approve))
      .map((control) => control.textContent);
  };

  it("shows a long rationale, every pro and every risk of a Board approval, with nothing to expand", async () => {
    const reasoning = `${"Provider X meets every condition in the request. ".repeat(20)}Final sentence of the rationale.`;
    expect(reasoning.length).toBeGreaterThan(1000);
    const recommendation = `${"Approve provider X on a month to month term. ".repeat(10)}Final sentence of the recommendation.`;
    const nextAction = `${"The agent signs up and records the invoice. ".repeat(10)}Final sentence of the next action.`;
    const title = `${"Approve the staging hosting spend for the wholesale portal ".repeat(4)}before Friday`;
    await render(
      createApproval({
        payload: {
          title,
          recommendedAction: recommendation,
          reasoning,
          pros: ["Pro one.", "Pro two.", "Pro three.", "Pro four.", "Pro five."],
          risks: ["Risk one.", "Risk two.", "Risk three.", "Risk four.", "1. Risk five, written as a numbered item."],
          nextActionOnApproval: nextAction,
        },
      }),
    );

    const text = panel().textContent ?? "";
    // The heading is the whole title, however long.
    expect(panel().querySelector("h1")?.textContent).toBe(title.trim());
    expect(text).toContain(recommendation);
    expect(text).toContain(reasoning);
    expect(text).toContain(nextAction);
    for (const point of ["Pro four.", "Pro five.", "Risk four.", "Risk five, written as a numbered item."]) {
      expect(text).toContain(point);
    }
    expect(panel().querySelectorAll("li")).toHaveLength(10);
    // A numbered risk sits beside the bullet without its own number.
    expect(text).not.toContain("1. Risk five");
    // Nothing is cut, so nothing offers to expand.
    expect(text).not.toContain("…");
    expect(controlsAboveDecision()).toEqual([]);
    expect(panel().querySelector("[class*='line-clamp']")).toBeNull();
    expect(panel().querySelector("[class*='max-h-']")).toBeNull();
    // All of it is above the decision buttons.
    const lastRisk = [...panel().querySelectorAll("li")].at(-1)!;
    expect(isBefore(lastRisk, button(panel(), "Approve"))).toBe(true);
  });

  it("shows the whole email draft and the whole original request above the decision buttons", async () => {
    // Longer than the 1,500 characters a card or inbox row shows before "Show full reply".
    const body = `Hi Sam,\n\n${"Our wholesale price list is attached. ".repeat(60)}\n\nLast line of the draft.`;
    expect(body.length).toBeGreaterThan(1500);
    const original = `${"Could you send your wholesale price list?\n".repeat(40)}Stop and ask before going any further.`;
    await render(
      createApproval({
        payload: {
          title: "Reply to wholesale request",
          recommendedAction: "Send the drafted reply.",
          reasoning: "Both answers are in the published terms.",
          pros: ["Answers both questions."],
          risks: ["The price list changes next month."],
          channel: "Email from info@",
          recipient: "buyer@example.test",
          subject: "Re: Wholesale price list",
          body,
          originalRequest: {
            text: original,
            source: { kind: "external", channel: "Email", sender: "Sam Example", snapshotOrigin: "requester" },
          },
        },
      }),
    );

    const draft = panel().querySelector<HTMLElement>("[data-approval-draft]")!;
    expect(draft.textContent).toContain("Tobuyer@example.test");
    expect(draft.textContent).toContain("SubjectRe: Wholesale price list");
    expect(draft.textContent).toContain(body);
    expect(draft.querySelector("[class*='line-clamp']")).toBeNull();
    expect(isBefore(draft, button(panel(), "Approve"))).toBe(true);

    // The source is the only <pre> in the panel, whole, with no clamp and no inner scroll box.
    const source = panel().querySelectorAll("pre");
    expect(source).toHaveLength(1);
    expect(source[0].textContent).toBe(original);
    expect(source[0].className).not.toMatch(/line-clamp|max-h-|overflow-/);
    expect(isBefore(source[0], draft)).toBe(true);
    expect(panel().textContent).toContain("Email · Sam Example · Quoted by the requesting agent, not verified");
    // The channel is a description of how the reply goes out, not a sender address.
    expect(draft.textContent).toContain("ViaEmail from info@");
    expect(draft.textContent).not.toContain("From");
    // The request has a requesting agent and no "If approved" line of its own: the page states what approval does.
    const effect = panel().querySelector<HTMLElement>("[data-approval-reply-effect]")!;
    expect(effect.textContent).toBe("If approved, the requester is told to send this reply to buyer@example.test.");
    expect(isBefore(draft, effect)).toBe(true);
    expect(isBefore(effect, button(panel(), "Approve"))).toBe(true);
    // The draft is never offered as the original request.
    expect(source[0].textContent).not.toContain("Last line of the draft.");
    expect(controlsAboveDecision()).toEqual([]);
  });

  it("names who wrote the original comment instead of printing an id, above the buttons and in Full request", async () => {
    const sentAt = "2026-10-07T01:23:48.000Z";
    await render(
      createApproval({
        payload: {
          title: "Approve staging hosting spend",
          summary: "Estimated cost is $42/month for provider X.",
          recommendedAction: "Approve provider X.",
          reasoning: "Provider X meets every condition in the request.",
          pros: ["Fixed monthly commitment."],
          risks: ["The bill rises if traffic doubles."],
          originalRequest: {
            text: "Use provider X if it stays under $50.",
            source: {
              kind: "paperclip_comment",
              commentId: "22222222-2222-4222-8222-222222222222",
              issueId: "33333333-3333-4333-8333-333333333333",
              sender: MANAGER_ID,
              sentAt,
              snapshotOrigin: "server",
            },
          },
        },
      }),
    );

    const time = new Date(sentAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const line = `Chief Executive · ${time} · Saved from the original comment · View comment`;
    expect(panel().textContent).toContain(line);
    // The summary leads the panel: the cost an agent puts there is in front of the board.
    const text = panel().textContent ?? "";
    expect(text).toContain("SummaryEstimated cost is $42/month for provider X.");
    expect(text.indexOf("SummaryEstimated cost")).toBeLessThan(text.indexOf("RecommendationApprove provider X."));

    const fullRequest = container.querySelector("details")!;
    expect(fullRequest.textContent).toContain(line);
    // Only the raw payload, a technical view inside Full request, still holds the id.
    expect(panel().textContent).not.toContain(MANAGER_ID);
    expect(panel().textContent).not.toContain("snapshot");
  });

  it("states that no original request was attached, and which fields the request leaves empty", async () => {
    await render(
      createApproval({
        payload: { title: "Approve staging hosting spend", risks: ["The bill rises if traffic doubles."] },
      }),
    );

    const text = panel().textContent ?? "";
    expect(text).toContain("Original requestNo original request was attached to this approval.");
    expect(panel().querySelector("pre")).toBeNull();
    expect(text).toContain("RecommendationNot supplied.");
    expect(text).toContain("WhyNot supplied.");
    expect(text).toContain("ProsNot supplied.");
    expect(text).toContain("The bill rises if traffic doubles.");
  });

  it("shows a hire with every skill and the described work in full", async () => {
    const capabilities = Array.from({ length: 9 }, (_, index) => `${index + 1}. Duty number ${index + 1}.`).join("\n");
    await render(
      createApproval({
        type: "hire_agent",
        payload: {
          name: "Pricing Analyst",
          role: "researcher",
          reportsTo: MANAGER_ID,
          capabilities,
          budgetMonthlyCents: 5000,
          desiredSkills: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"],
          agentId: "agent-pending",
        },
      }),
    );

    const hire = panel().querySelector<HTMLElement>("[data-approval-hire]")!;
    expect(panel().querySelector("h1")?.textContent).toBe("Pricing Analyst");
    await vi.waitFor(() => expect(hire.textContent).toContain("Reports toChief Executive"));
    expect(hire.textContent).not.toContain(MANAGER_ID.slice(0, 8));
    expect(hire.textContent).toContain("Monthly budget$50.00");
    expect(hire.textContent).toContain(capabilities);
    expect(hire.querySelectorAll("li")).toHaveLength(8);
    expect(hire.textContent).toContain("If rejectedThe pending agent is terminated.");
    expect(controlsAboveDecision()).toEqual([]);
  });

  it("shows a strategy plan in full, with the decision fields it carries", async () => {
    const plan = Array.from({ length: 14 }, (_, index) => `${index + 1}. Step ${index + 1} of the plan.`).join("\n");
    await render(
      createApproval({
        type: "approve_ceo_strategy",
        payload: {
          title: "Q4 strategy",
          plan,
          recommendedAction: "Approve the shift for Q4.",
          risks: ["Runway one.", "Runway two.", "Runway three."],
        },
      }),
    );

    const block = panel().querySelector<HTMLElement>("[data-approval-plan]")!;
    expect(block.querySelector("p.whitespace-pre-wrap")?.textContent).toBe(plan);
    expect(panel().textContent).toContain("RecommendationApprove the shift for Q4.");
    expect(panel().textContent).toContain("Runway three.");
    expect(controlsAboveDecision()).toEqual([]);
  });

  it("shows a budget stop by its scope and amounts, with no decision buttons", async () => {
    await render(
      createApproval({
        type: "budget_override_required",
        requestedByAgentId: "agent-requester",
        payload: {
          scopeName: "Pricing Analyst",
          windowKind: "calendar_month_utc",
          metric: "billed_cents",
          budgetAmount: 5000,
          observedAmount: 5200,
          guidance: "Raise the budget and resume, or keep the scope paused.",
        },
      }),
    );

    const text = panel().textContent ?? "";
    expect(text).toContain("ScopePricing Analyst");
    expect(text).toContain("Limit $50.00 · Observed $52.00");
    expect(text).toContain("Raise the budget and resume, or keep the scope paused.");
    expect(text).toContain("Resolve this budget stop in Costs.");
    expect(panel().querySelectorAll("button")).toHaveLength(0);
  });

  describe("names, never ids", () => {
    const APPROVAL_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const UNKNOWN_AGENT_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
    const ISSUE_ID = "5d4c3b2a-1f0e-4d9c-8b7a-665544332211";
    /** Everything the page shows, without the one line that is labelled as an id and the technical raw payload. */
    const shownText = () => {
      const copy = container.cloneNode(true) as HTMLElement;
      const requestId = [...copy.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Request ID:"))!;
      expect(requestId.textContent).toBe(`Request ID: ${APPROVAL_ID}`);
      requestId.remove();
      copy.querySelector("pre")!.closest("details")!.remove();
      return copy.textContent ?? "";
    };

    describe("the way back to the queue", () => {
      const backLink = () => container.querySelector<HTMLAnchorElement>("a[data-approval-back-to-queue]")!;
      const firstCrumb = () =>
        (breadcrumbMock.setBreadcrumbs.mock.lastCall![0] as Array<{ label: string; href?: string }>)[0];

      it.each([
        ["/PAP/approvals/pending?kind=email_reply&sort=newest", "/PAP/approvals/pending?kind=email_reply&sort=newest#approval-approval-1"],
        ["/PAP/approvals/all?sort=oldest", "/PAP/approvals/all?sort=oldest#approval-approval-1"],
        ["/approvals/pending", "/approvals/pending#approval-approval-1"],
      ])("leads to the view the request was opened from (%s), at its card", async (queue, target) => {
        routerMock.location.state = { queue };
        await render(createApproval({ id: APPROVAL_ID }));

        expect(backLink().textContent).toBe("Back to the queue");
        expect(backLink().getAttribute("href")).toBe(target);
        expect(firstCrumb()).toEqual({ label: "Approvals", href: target });
        // It stands above the request, and navigates only: nothing is decided by it.
        expect(isBefore(backLink(), panel())).toBe(true);
        expect(routerMock.navigate).not.toHaveBeenCalled();
      });

      it.each([
        ["nothing", null],
        ["what the sidebar's links carry", { paperclipSidebarScrollReset: true }],
        ["an address that is not the queue's", { queue: "/PAP/inbox" }],
        ["an address on another site", { queue: "https://example.test/approvals/pending" }],
      ])("leads to To decide, at this request, when the link that opened the page carried %s", async (_what, state) => {
        routerMock.location.state = state;
        await render(createApproval({ id: APPROVAL_ID }));

        expect(backLink().getAttribute("href")).toBe("/approvals/pending#approval-approval-1");
        expect(firstCrumb()).toEqual({ label: "Approvals", href: "/approvals/pending#approval-approval-1" });
      });

      it("is as easy to tap as View details in the queue, and no taller", async () => {
        await render(createApproval({ id: APPROVAL_ID }));
        for (const name of [
          "relative",
          "h-auto",
          "pointer-coarse:after:absolute",
          "pointer-coarse:after:inset-x-0",
          "pointer-coarse:after:-inset-y-3.5",
        ]) {
          expect(backLink().classList.contains(name), name).toBe(true);
        }
      });
    });

    it("names the request in the breadcrumb by its subject, cut to about 40 characters", async () => {
      await render(createApproval({ id: APPROVAL_ID }));
      expect(lastCrumb()).toBe("Approve staging hosting spend");
    });

    it("cuts a long subject in the breadcrumb at a word boundary", async () => {
      const title = "Approve the staging hosting spend for the wholesale portal before Friday";
      await render(createApproval({ id: APPROVAL_ID, payload: { title, recommendedAction: "Approve." } }));

      const crumb = lastCrumb();
      expect(crumb).toBe("Approve the staging hosting spend for\u2026");
      expect(crumb.length).toBeLessThanOrEqual(41);
      // The heading still carries the whole title.
      expect(panel().querySelector("h1")?.textContent).toBe(title);
    });

    it("falls back to the kind of request in the breadcrumb when the request has no subject", async () => {
      await render(createApproval({ id: APPROVAL_ID, payload: { reasoning: "No title was given." } }));
      expect(lastCrumb()).toBe("Board Approval");
    });

    it("names a hire in the breadcrumb by the agent, not by an id", async () => {
      await render(
        createApproval({ id: APPROVAL_ID, type: "hire_agent", payload: { name: "Support Clerk", role: "general" } }),
      );
      expect(lastCrumb()).toBe("Support Clerk");
    });

    it("never puts the approval id, or a piece of it, in any breadcrumb it sets", async () => {
      await render(createApproval({ id: APPROVAL_ID }));
      const labels = breadcrumbMock.setBreadcrumbs.mock.calls.flatMap(([crumbs]) =>
        (crumbs as Array<{ label: string }>).map((crumb) => crumb.label),
      );
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label).not.toContain(APPROVAL_ID.slice(0, 8));
        // While the request loads, the route's id is not shown either.
        expect(label).not.toContain("approval-1");
      }
    });

    it("shows a requester and comment authors it cannot name as \"An agent\", and a user as \"Board\"", async () => {
      apiMocks.listComments.mockResolvedValue([
        { id: "comment-1", authorAgentId: UNKNOWN_AGENT_ID, authorUserId: null, body: "From a removed agent.", createdAt: new Date("2026-10-05T13:00:00.000Z") },
        { id: "comment-2", authorAgentId: MANAGER_ID, authorUserId: null, body: "From the manager.", createdAt: new Date("2026-10-05T14:00:00.000Z") },
        { id: "comment-3", authorAgentId: null, authorUserId: "user-42", body: "From a board member.", createdAt: new Date("2026-10-05T15:00:00.000Z") },
      ]);
      apiMocks.listIssues.mockResolvedValue([
        { id: ISSUE_ID, identifier: null, title: "Pick a hosting provider" },
        { id: "issue-2", identifier: "OPS-7", title: "Renew the domain" },
      ]);
      await render(createApproval({ id: APPROVAL_ID, requestedByAgentId: UNKNOWN_AGENT_ID }), "An agent");
      await vi.waitFor(() => expect(container.textContent).toContain("From a board member."));
      await vi.waitFor(() => expect(container.textContent).toContain("Pick a hosting provider"));
      // The agent list has loaded and does not hold the requester.
      await vi.waitFor(() => expect(container.textContent).toContain("Chief Executive"));

      const header = panel().querySelector("header")!;
      expect(header.textContent).toContain("Requested by");
      expect(header.querySelector("[title='An agent']")).not.toBeNull();

      const authors = [...container.querySelectorAll("details")]
        .find((details) => details.querySelector("summary")?.textContent?.startsWith("Discussion"))!;
      const names = [...authors.querySelectorAll("[title]")].map((identity) => identity.getAttribute("title"));
      expect(names).toEqual(["An agent", "Chief Executive", "Board"]);
      // An unnamed agent's comment still leads to that agent's page.
      expect(authors.querySelector("a")!.getAttribute("href")).toBe(`/agents/${UNKNOWN_AGENT_ID}`);

      // A task without an identifier is named by its title only.
      const tasks = [...container.querySelectorAll("a")].filter((link) => link.getAttribute("href")?.startsWith("/issues/"));
      expect(tasks.map((link) => link.textContent)).toEqual(["Pick a hosting provider", "OPS-7Renew the domain"]);

      const text = shownText();
      for (const id of [APPROVAL_ID, UNKNOWN_AGENT_ID, MANAGER_ID, ISSUE_ID, "user-42"]) {
        expect(text).not.toContain(id.slice(0, 8));
      }
    });

    it("uses one set of words for the top panel and Full request", async () => {
      await render(
        createApproval({
          id: APPROVAL_ID,
          payload: {
            title: "Reply to wholesale request",
            recommendedAction: "Send the drafted reply.",
            reasoning: "Nothing in the reply commits to a delivery date.",
            nextActionOnApproval: "The agent sends the reply.",
            recipient: "buyer@example.test",
            subject: "Re: Wholesale price list",
            body: "Hi Sam, the price list is attached.",
          },
        }),
      );

      const fullRequest = [...container.querySelectorAll("details")]
        .find((details) => details.querySelector("summary")?.textContent === "Full request")!;
      for (const scope of [panel(), fullRequest]) {
        expect(scope.textContent).toContain("RecommendationSend the drafted reply.");
        expect(scope.textContent).toContain("Draft reply");
        expect(scope.textContent).not.toContain("Recommended action");
        expect(scope.textContent).not.toContain("Proposed reply");
        expect(scope.textContent).not.toContain("On approval");
      }
      expect(panel().textContent).toContain("If approvedThe agent sends the reply.");
    });

    it("says that no pros or risks were recorded, without calling the request old", async () => {
      await render(createApproval({ id: APPROVAL_ID, payload: { title: "Approve staging hosting spend" } }));
      expect(panel().textContent).toContain("No pros or risks were recorded.");
      expect(container.textContent).not.toContain("Older request");
    });
  });

  describe("sent back for changes, and revised while the page is open", () => {
    const NOTICE = "The requester revised this request while it was open. Review it before you decide.";
    const notice = () => panel().querySelector<HTMLElement>("[data-approval-revised]");
    const typeInto = (field: HTMLTextAreaElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    /** What a live update does: the server holds a new version and the page reloads it. */
    const reload = async (approval: Approval) => {
      apiMocks.get.mockResolvedValue(approval);
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approvals", "detail", "approval-1"] });
      });
    };
    const revisedPayload = {
      title: "Approve staging hosting spend",
      recommendedAction: "Approve provider Y at twice the quoted price.",
      reasoning: "Provider X withdrew its offer.",
      pros: ["Available today."],
      risks: ["Twice the monthly cost."],
    };

    it("keeps Approve and Reject for a request that was sent back, and labels the note as the board's own request", async () => {
      apiMocks.approve.mockResolvedValue(createApproval({ status: "approved" }));
      await render(
        createApproval({
          status: "revision_requested",
          decisionNote: "Quote the delivery date.",
          decidedAt: new Date("2026-10-06T10:00:00.000Z"),
          updatedAt: new Date("2026-10-06T10:00:00.000Z"),
        }),
      );

      expect(panel().textContent).toContain("Changes you asked forQuote the delivery date.");
      expect(panel().textContent).not.toContain("Decision note");
      expect(button(panel(), "Approve")).toBeDefined();
      expect(button(panel(), "Reject")).toBeDefined();
      expect(button(panel(), "Request changes")).toBeUndefined();
      expect(notice()).toBeNull();

      await act(async () => button(panel(), "Approve").click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledExactlyOnceWith("approval-1"));
    });

    it("ignores a pointer press on Approve just after the page is drawn, and takes it after that", async () => {
      // The press that opened this page (a row title, "View details") can be followed by a second,
      // slower press at the same point, where Approve now is. This page sends at once, with no undo.
      let now = 1_700_000_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        apiMocks.approve.mockResolvedValue(createApproval({ status: "approved" }));
        await render(createApproval({ status: "revision_requested", decisionNote: "Quote the delivery date." }));
        const press = () =>
          act(async () => {
            button(panel(), "Approve").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
          });

        now += 450;
        await press();
        now += 250;
        await press();
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // A press by the keyboard reports no click count and is not held up; here the moment has passed.
        now += 100;
        await press();
        await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledExactlyOnceWith("approval-1"));
      } finally {
        clock.mockRestore();
      }
    });

    it("shows the board's own note with its line breaks, for a change request and for a decision note", async () => {
      const note = "1. Quote the delivery date.\n2. Use the November price list.\n\nKeep the tone as it is.";
      const unbroken = "x".repeat(400);
      for (const [status, label] of [
        ["revision_requested", "Changes you asked for"],
        // Resubmitted: the server kept the change request on the revised request.
        ["pending", "Changes you asked for"],
        ["approved", "Decision note"],
        ["rejected", "Decision note"],
      ] as const) {
        await render(
          createApproval({
            status,
            decisionNote: `${note}\n${unbroken}`,
            decidedAt: new Date("2026-10-06T10:00:00.000Z"),
            updatedAt: new Date("2026-10-06T10:00:00.000Z"),
          }),
        );
        const shown = panel().querySelector<HTMLElement>("[data-approval-decision-note]")!;
        // The text node holds the note as typed, and the paragraph keeps its lines and breaks a long run.
        expect(shown.textContent).toBe(`${note}\n${unbroken}`);
        expect(shown.classList.contains("whitespace-pre-wrap")).toBe(true);
        expect(shown.classList.contains("break-words")).toBe(true);
        expect(shown.previousElementSibling?.textContent).toBe(label);
        // Plain text: nothing in a note is rendered as markup.
        expect(shown.children).toHaveLength(0);
        act(() => root.unmount());
        root = createRoot(container);
        queryClient.clear();
      }
    });

    it("holds Approve back after a revision arrives, until the board confirms it has reviewed it", async () => {
      apiMocks.approve.mockResolvedValue(createApproval({ status: "approved" }));
      await render(createApproval());
      await act(async () => button(panel(), "Add a note").click());
      await typeInto(panel().querySelector("textarea")!, "Month to month only");
      expect(notice()).toBeNull();

      await reload(createApproval({ updatedAt: new Date("2026-10-06T11:00:00.000Z"), payload: revisedPayload }));
      await vi.waitFor(() => expect(panel().textContent).toContain("Approve provider Y at twice the quoted price."));

      expect(notice()!.querySelector("[role='alert']")!.textContent).toBe(NOTICE);
      const recommendation = [...panel().querySelectorAll("p")].find((p) => p.textContent === "Recommendation")!;
      expect(isBefore(notice()!, recommendation)).toBe(true);
      expect(panel().querySelector("textarea")!.value).toBe("Month to month only");

      await act(async () => button(panel(), "Approve").click());
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(panel().querySelector("[role='status']")!.textContent).toBe(
        "Confirm that you have reviewed the revised request, then approve.",
      );
      expect(document.activeElement).toBe(notice());

      await act(async () => button(panel(), "I have reviewed it").click());
      expect(panel().textContent).not.toContain(NOTICE);
      expect(panel().querySelector("[role='status']")!.textContent).toBe("");
      expect(panel().contains(document.activeElement)).toBe(true);
      expect(panel().querySelector("textarea")!.value).toBe("Month to month only");

      await act(async () => button(panel(), "Approve").click());
      await vi.waitFor(() =>
        expect(apiMocks.approve).toHaveBeenCalledExactlyOnceWith("approval-1", "Month to month only"));
    });

    it("raises no notice when only the time changed", async () => {
      await render(createApproval());
      await reload(createApproval({ updatedAt: new Date("2026-10-06T11:00:00.000Z") }));
      await vi.waitFor(() => expect(apiMocks.get.mock.calls.length).toBeGreaterThan(1));
      await act(async () => {});
      expect(notice()).toBeNull();
      expect(panel().textContent).not.toContain(NOTICE);
    });

    it("keeps the note the board was typing when a request it sent back is resubmitted", async () => {
      apiMocks.approve.mockResolvedValue(createApproval({ status: "approved" }));
      await render(
        createApproval({
          status: "revision_requested",
          decisionNote: "Quote the delivery date.",
          decidedAt: new Date("2026-10-06T10:00:00.000Z"),
          updatedAt: new Date("2026-10-06T10:00:00.000Z"),
        }),
      );
      await act(async () => button(panel(), "Reject").click());
      await typeInto(panel().querySelector("textarea")!, "Still no delivery date");

      await reload(createApproval({ updatedAt: new Date("2026-10-06T11:00:00.000Z"), payload: revisedPayload }));
      await vi.waitFor(() => expect(notice()).not.toBeNull());

      expect(notice()!.textContent).toContain(NOTICE);
      // The reject panel is still open with what was typed, and the board's old request is gone with the old version.
      expect(panel().textContent).toContain("Reject this request?");
      expect(panel().querySelector("textarea")!.value).toBe("Still no delivery date");
      expect(panel().textContent).not.toContain("Changes you asked for");
    });
  });

  describe("Mark resubmitted", () => {
    const sentBack = (overrides: Partial<Approval> = {}) =>
      createApproval({
        status: "revision_requested",
        decisionNote: "Quote the delivery date.",
        decidedAt: new Date("2026-10-06T10:00:00.000Z"),
        updatedAt: new Date("2026-10-06T10:00:00.000Z"),
        ...overrides,
      });
    let confirm: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      confirm = vi.spyOn(window, "confirm");
      apiMocks.resubmit.mockResolvedValue(createApproval());
    });
    afterEach(() => confirm.mockRestore());

    it("says what it does and sends nothing when the board declines", async () => {
      confirm.mockReturnValue(false);
      await render(sentBack());

      await act(async () => button(panel(), "Mark resubmitted").click());

      expect(confirm).toHaveBeenCalledExactlyOnceWith(MARK_RESUBMITTED_CONFIRM);
      // The three things the press does, in the board's words.
      expect(MARK_RESUBMITTED_CONFIRM).toContain("returns to the queue unchanged");
      expect(MARK_RESUBMITTED_CONFIRM).toContain("Your change request stays on it");
      expect(MARK_RESUBMITTED_CONFIRM).not.toContain("deleted");
      expect(MARK_RESUBMITTED_CONFIRM).toContain("the requester can no longer resubmit");
      expect(apiMocks.resubmit).not.toHaveBeenCalled();
      // The note is still on the page and the button can be pressed again.
      expect(panel().textContent).toContain("Quote the delivery date.");
      expect(button(panel(), "Mark resubmitted").disabled).toBe(false);
    });

    it("resubmits once the board confirms", async () => {
      confirm.mockReturnValue(true);
      await render(sentBack());

      await act(async () => button(panel(), "Mark resubmitted").click());

      expect(confirm).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(apiMocks.resubmit).toHaveBeenCalledExactlyOnceWith("approval-1"));
    });

    it("asks the same question for a budget stop, which has no other buttons", async () => {
      confirm.mockReturnValue(false);
      await render(sentBack({ type: "budget_override_required", payload: { scopeName: "Research" } }));

      await act(async () => button(panel(), "Mark resubmitted").click());
      expect(confirm).toHaveBeenCalledExactlyOnceWith(MARK_RESUBMITTED_CONFIRM);
      expect(apiMocks.resubmit).not.toHaveBeenCalled();

      confirm.mockReturnValue(true);
      await act(async () => button(panel(), "Mark resubmitted").click());
      await vi.waitFor(() => expect(apiMocks.resubmit).toHaveBeenCalledExactlyOnceWith("approval-1"));
    });
  });

  describe("when something fails", () => {
    const alerts = (scope: ParentNode = container) => [...scope.querySelectorAll("[role='alert']")];
    const typeInto = (field: HTMLTextAreaElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });

    it("reports a failed decision inside the decision controls, directly above the buttons, and keeps the note", async () => {
      apiMocks.reject.mockRejectedValue(new Error("Session expired"));
      await render(createApproval());

      await act(async () => button(panel(), "Reject").click());
      await typeInto(panel().querySelector("textarea")!, "Outside this quarter's budget");
      await act(async () => button(panel(), "Reject request").click());
      await vi.waitFor(() => expect(alerts()).toHaveLength(1));

      const [alert] = alerts();
      expect(alert.textContent).toBe("Error while rejecting: Session expired");
      const approve = button(panel(), "Approve");
      // The same control holds the error and the buttons, and the button row follows the error.
      expect(alert.closest("[aria-busy]")).toBe(approve.closest("[aria-busy]"));
      expect(alert.closest("[aria-busy]")).not.toBeNull();
      expect(alert.nextElementSibling!.contains(approve)).toBe(true);
      expect(alert.nextElementSibling!.contains(button(panel(), "Reject"))).toBe(true);
      expect(panel().querySelector("textarea")!.value).toBe("Outside this quarter's budget");
      expect(apiMocks.reject).toHaveBeenCalledExactlyOnceWith("approval-1", "Outside this quarter's budget");

      // Editing the note takes the error away until the decision is sent again.
      await typeInto(panel().querySelector("textarea")!, "Outside this year's budget");
      expect(alerts()).toHaveLength(0);
    });

    it("keeps the error on the page when the reload shows the decision was stored anyway", async () => {
      await render(createApproval());
      // The server stores an approval before it runs what follows from it.
      apiMocks.approve.mockImplementation(async () => {
        apiMocks.get.mockResolvedValue(createApproval({ status: "approved" }));
        throw new Error("Agent not found");
      });

      await act(async () => button(panel(), "Approve").click());
      await vi.waitFor(() => expect(alerts()).toHaveLength(1));
      await vi.waitFor(() => expect(button(panel(), "Approve")).toBeUndefined());

      expect(alerts(panel()).map((alert) => alert.textContent)).toEqual(["Error while approving: Agent not found"]);
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it("reports a comment that could not be posted beside the comment field, not on the decision", async () => {
      apiMocks.addComment.mockRejectedValue(new Error("Comment too long"));
      await render(createApproval());

      const comment = container.querySelector<HTMLTextAreaElement>("textarea[id^='approval-comment-']")!;
      await typeInto(comment, "Please confirm the term.");
      await act(async () => button(container, "Post comment").click());
      await vi.waitFor(() => expect(alerts()).toHaveLength(1));

      expect(alerts()[0].textContent).toBe("Comment too long");
      expect(alerts(panel())).toHaveLength(0);
      expect(alerts()[0].closest("details")!.contains(comment)).toBe(true);
      expect(comment.value).toBe("Please confirm the term.");
    });
  });
});
