// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchParams: new URLSearchParams(),
}));

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
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => routerMock.navigate,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [routerMock.searchParams],
}));

import { ApprovalDetail } from "./ApprovalDetail";
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
  const render = async (approval: Approval) => {
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
    await vi.waitFor(() => expect(panel().textContent).toContain("Operations Lead"));
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
    expect(panel().textContent).toContain("Email · Sam Example · Requester-provided external source snapshot");
    // The draft is never offered as the original request.
    expect(source[0].textContent).not.toContain("Last line of the draft.");
    expect(controlsAboveDecision()).toEqual([]);
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
});
