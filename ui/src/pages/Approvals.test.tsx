// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({
  location: { pathname: "/approvals/pending", search: "", hash: "" },
  navigate: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  listIssues: vi.fn(),
  agentsList: vi.fn(),
}));

const generalSettingsMock = vi.hoisted(() => ({ keyboardShortcutsEnabled: true }));

vi.mock("../api/approvals", () => ({ approvalsApi: apiMocks }));
vi.mock("../api/agents", () => ({ agentsApi: { list: apiMocks.agentsList } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../context/GeneralSettingsContext", () => ({
  useGeneralSettings: () => generalSettingsMock,
}));
vi.mock("../components/PageTabBar", () => ({ PageTabBar: () => null }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => routerMock.location,
  useNavigate: () => routerMock.navigate,
}));

import { Approvals } from "./Approvals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createApproval(id: string, createdAt: string, overrides: Partial<Approval> = {}): Approval {
  return {
    id,
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-requester",
    requestedByUserId: null,
    status: "pending",
    payload: {
      title: `Request ${id}`,
      recommendedAction: "Approve it.",
      reasoning: "It fits the request.",
      pros: ["A pro."],
      risks: ["A risk."],
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ...overrides,
  };
}

describe("Approvals", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let approvals: Approval[];

  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    routerMock.navigate.mockReset();
    routerMock.location.pathname = "/approvals/pending";
    generalSettingsMock.keyboardShortcutsEnabled = true;
    approvals = [
      createApproval("newest", "2026-10-05T00:00:00.000Z"),
      createApproval("oldest", "2026-09-20T00:00:00.000Z"),
      createApproval("email", "2026-10-01T00:00:00.000Z", {
        payload: {
          title: "Request email",
          recommendedAction: "Send the reply.",
          reasoning: "It answers the question.",
          pros: ["A pro."],
          risks: ["A risk."],
          recipient: "buyer@example.test",
          body: "Draft body",
        },
      }),
      createApproval("done", "2026-09-01T00:00:00.000Z", { status: "approved" }),
    ];
    apiMocks.list.mockImplementation(async () => approvals);
    apiMocks.agentsList.mockResolvedValue([]);
    apiMocks.listIssues.mockImplementation(async (id: string) =>
      id === "oldest" ? [{ id: "issue-1", identifier: "DEMO-7", title: "Linked task" }] : []);
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

  const render = async () => {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Approvals /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Request oldest"));
  };
  const rows = () => [...container.querySelectorAll<HTMLElement>("[data-approval-card]")];
  const order = () => rows().map((row) => row.dataset.approvalCard);
  const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  const click = (element: HTMLElement) => act(async () => element.click());

  it("lists the longest-waiting request first and lets the board reverse the order", async () => {
    await render();
    expect(order()).toEqual(["oldest", "email", "newest"]);

    await click(button(container, "Sort: Oldest first"));
    expect(order()).toEqual(["newest", "email", "oldest"]);
    expect(button(container, "Sort: Newest first")).toBeDefined();
  });

  it("filters the queue by kind of request", async () => {
    await render();
    await click(button(container, "Email replies"));
    expect(order()).toEqual(["email"]);
    expect(button(container, "Email replies").getAttribute("aria-pressed")).toBe("true");

    await click(button(container, "All"));
    expect(order()).toEqual(["oldest", "email", "newest"]);
  });

  it("shows each request's linked task on its card", async () => {
    await render();
    await vi.waitFor(() => expect(rows()[0].textContent).toContain("DEMO-7"));
    expect(apiMocks.listIssues).toHaveBeenCalledWith("oldest");
  });

  it("keeps the board in the queue after a decision and leaves a compact record of it", async () => {
    apiMocks.approve.mockImplementation(async (id: string, note?: string) => {
      const decided = { ...approvals.find((approval) => approval.id === id)!, status: "approved", decisionNote: note ?? null } as Approval;
      approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
      return decided;
    });
    await render();

    const card = rows()[0];
    await click(button(card, "Add a note"));
    await act(async () => {
      const note = card.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Month to month only");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(card, "Approve"));

    await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only"));
    await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
    expect(routerMock.navigate).not.toHaveBeenCalled();
    // The decided request holds its place as one line; the others are untouched.
    expect(order()).toEqual(["oldest", "email", "newest"]);
    expect(rows()[0].textContent).toContain("Request oldest");
    expect(rows()[0].textContent).toContain("Your note. Month to month only");
    expect(rows()[0].querySelectorAll("button")).toHaveLength(0);
    expect(rows()[0].tabIndex).toBe(-1);
    expect(rows()[0].querySelector("a")?.getAttribute("href")).toBe("/approvals/oldest");
    expect(button(rows()[1], "Approve")).toBeDefined();
  });

  it("sends a rejection only after it is confirmed", async () => {
    apiMocks.reject.mockImplementation(async (id: string) => (
      { ...approvals.find((approval) => approval.id === id)!, status: "rejected" } as Approval
    ));
    await render();

    await click(button(rows()[0], "Reject"));
    expect(apiMocks.reject).not.toHaveBeenCalled();
    await click(button(rows()[0], "Reject request"));
    await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest"));
  });

  it("moves between requests with J and K when shortcuts are enabled", async () => {
    await render();
    const press = (key: string) =>
      act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    await press("j");
    expect(document.activeElement).toBe(rows()[0]);
    await press("j");
    expect(document.activeElement).toBe(rows()[1]);
    await press("k");
    expect(document.activeElement).toBe(rows()[0]);
    expect(container.textContent).toContain("Shift+A approve");
  });

  it("leaves the keyboard alone when shortcuts are disabled", async () => {
    generalSettingsMock.keyboardShortcutsEnabled = false;
    await render();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    expect(rows().includes(document.activeElement as HTMLElement)).toBe(false);
    expect(container.textContent).not.toContain("Shift+A approve");
    expect(rows()[0].hasAttribute("tabindex")).toBe(false);

    // The compact row left by a decision follows the same rule.
    apiMocks.approve.mockImplementation(async (id: string) => (
      { ...approvals.find((approval) => approval.id === id)!, status: "approved" } as Approval
    ));
    await click(button(rows()[0], "Approve"));
    await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
    expect(rows()[0].hasAttribute("tabindex")).toBe(false);
  });
});
