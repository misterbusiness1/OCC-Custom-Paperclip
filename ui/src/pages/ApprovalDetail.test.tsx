// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval, ApprovalComment } from "@paperclipai/shared";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";

const mockApprovalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
// Mutable flag so a single test can exercise the legacy (flag-off) branch too.
const mockFlagState = vi.hoisted(() => ({ decisionCard: true }));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children?: ReactNode; to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ approvalId: "appr-1" }),
  useSearchParams: () => [new URLSearchParams(""), vi.fn()] as const,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../lib/featureFlags", () => ({
  FeatureFlags: { approvalsDecisionCard: "paperclip.approvals.decisionCard" },
  useFeatureFlag: () => mockFlagState.decisionCard,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span data-testid="identity">{name}</span>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string; asChild?: boolean }) => (
    <button {...props} type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

// Renders its subtree only when open, mirroring the real Sheet's mount behaviour so
// the raw-payload drawer is absent until the `v` shortcut (or trigger) opens it.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  SheetTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    updatedAt: new Date("2026-09-17T00:00:00.000Z"),
    ...overrides,
  };
}

function fireKeydown(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

describe("ApprovalDetail (decision card)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  async function renderApproval(approval: Approval) {
    mockApprovalsApi.get.mockResolvedValue(approval);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFlagState.decisionCard = true;
    mockApprovalsApi.get.mockResolvedValue(createApproval());
    mockApprovalsApi.listComments.mockResolvedValue([]);
    mockApprovalsApi.listIssues.mockResolvedValue([]);
    mockApprovalsApi.approve.mockResolvedValue(createApproval({ status: "approved" }));
    mockApprovalsApi.reject.mockResolvedValue(createApproval({ status: "rejected" }));
    mockApprovalsApi.requestRevision.mockResolvedValue(createApproval({ status: "revision_requested" }));
    mockApprovalsApi.resubmit.mockResolvedValue(createApproval());
    mockApprovalsApi.addComment.mockResolvedValue({} as ApprovalComment);
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Distributor Sync Monitor" }]);
    mockAgentsApi.remove.mockResolvedValue({ ok: true });
    mockNavigate.mockClear();
    mockSetBreadcrumbs.mockClear();
    mockSetSelectedCompanyId.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function expectNoHookOrderError() {
    expect(
      consoleErrorSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("React has detected a change in the order of Hooks"),
      ),
    ).toBe(false);
  }

  // (a) flag-on branch renders for a full-metadata approval …
  it("renders the decision card for a full-metadata approval", async () => {
    await renderApproval(
      createApproval({
        payload: {
          title: "Cash settle order #90210",
          summary: "Board asked to approve the refund.",
          gate: "Gate A",
          riskLevel: "high",
          slaHours: 24,
        },
      }),
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Board Approval: Cash settle order #90210");
      expect(container.textContent).toContain("Gate A");
      expect(container.textContent).toContain("high risk");
      expect(container.textContent).toContain("24h SLA");
      // requester name resolved from the agents list
      expect(container.textContent).toContain("Distributor Sync Monitor");
    });
    expectNoHookOrderError();
  });

  // … and for a degraded one (missing gate / risk / SLA / requester).
  it("degrades cleanly when gate, risk, SLA and requester are all absent", async () => {
    await renderApproval(
      createApproval({
        requestedByAgentId: null,
        payload: { summary: "No structured metadata on this one." },
      }),
    );

    await waitForAssertion(() => {
      // Base label still renders (no subject beyond the summary fallback is fine).
      expect(container.textContent).toContain("Board Approval");
      expect(container.textContent).toContain("No structured metadata on this one.");
      // Optional badges render nothing when their source is missing. (The static
      // "SLA / deadline" panel label still renders, but with an em-dash value.)
      expect(container.textContent).not.toContain("Gate A");
      expect(container.textContent).not.toContain("high risk");
      expect(container.textContent).not.toContain("h SLA");
      // "Decided" reads Pending for an undecided approval.
      expect(container.textContent).toContain("Pending");
    });
    // No requester agent id ⇒ no Identity chip rendered.
    expect(container.querySelector('[data-testid="identity"]')).toBeNull();
    expectNoHookOrderError();
  });

  // (b) sticky action-bar button set per status/type.
  it("shows approve/reject/request-revision for a pending approval", async () => {
    await renderApproval(createApproval({ status: "pending" }));

    await waitForAssertion(() => {
      const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
      expect(labels).toContain("Approve");
      expect(labels).toContain("Reject");
      expect(labels).toContain("Request revision");
      expect(labels).not.toContain("Mark resubmitted");
    });
  });

  it("shows approve/reject/mark-resubmitted for a revision_requested approval", async () => {
    await renderApproval(createApproval({ status: "revision_requested" }));

    await waitForAssertion(() => {
      const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
      expect(labels).toContain("Approve");
      expect(labels).toContain("Reject");
      expect(labels).toContain("Mark resubmitted");
      expect(labels).not.toContain("Request revision");
    });
  });

  it("routes a pending budget override to /costs instead of showing approve/reject", async () => {
    await renderApproval(
      createApproval({ type: "budget_override_required", status: "pending" }),
    );

    await waitForAssertion(() => {
      const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
      expect(container.textContent).toContain("Resolve this budget stop");
      expect(labels).not.toContain("Approve");
      expect(labels).not.toContain("Reject");
      // The costs link is present …
      const costsLink = container.querySelector('a[href="/costs"]');
      expect(costsLink).not.toBeNull();
    });
  });

  it("offers to delete a disapproved hire_agent approval with a linked agent", async () => {
    await renderApproval(
      createApproval({
        type: "hire_agent",
        status: "rejected",
        payload: { name: "Designer", agentId: "agent-xyz" },
      }),
    );

    await waitForAssertion(() => {
      const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
      expect(labels).toContain("Delete disapproved agent");
      expect(labels).not.toContain("Approve");
      expect(labels).not.toContain("Reject");
      expect(labels).not.toContain("Request revision");
    });
  });

  // (c) keydown dispatches the right mutation / toggles the raw payload.
  it("dispatches approve on the 'a' shortcut", async () => {
    await renderApproval(createApproval({ status: "pending" }));
    await waitForAssertion(() => expect(container.textContent).toContain("Approve"));

    await act(async () => {
      fireKeydown(window, "a");
    });

    expect(mockApprovalsApi.approve).toHaveBeenCalledTimes(1);
    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("appr-1");
    expect(mockApprovalsApi.reject).not.toHaveBeenCalled();
  });

  it("dispatches reject on the 'r' shortcut", async () => {
    await renderApproval(createApproval({ status: "pending" }));
    await waitForAssertion(() => expect(container.textContent).toContain("Reject"));

    await act(async () => {
      fireKeydown(window, "r");
    });

    expect(mockApprovalsApi.reject).toHaveBeenCalledTimes(1);
    expect(mockApprovalsApi.reject).toHaveBeenCalledWith("appr-1");
  });

  it("dispatches request-revision on the 'e' shortcut for a pending approval", async () => {
    await renderApproval(createApproval({ status: "pending" }));
    await waitForAssertion(() => expect(container.textContent).toContain("Request revision"));

    await act(async () => {
      fireKeydown(window, "e");
    });

    expect(mockApprovalsApi.requestRevision).toHaveBeenCalledTimes(1);
    expect(mockApprovalsApi.requestRevision).toHaveBeenCalledWith("appr-1");
  });

  it("toggles the raw-payload drawer on the 'v' shortcut", async () => {
    await renderApproval(
      createApproval({ payload: { title: "Peek me", gate: "Gate B" } }),
    );
    await waitForAssertion(() => expect(container.textContent).toContain("Board Approval: Peek me"));

    // Drawer is closed initially.
    expect(container.textContent).not.toContain("Raw approval payload");

    await act(async () => {
      fireKeydown(window, "v");
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Raw approval payload");
    });
  });

  it("suppresses shortcuts while typing in a field", async () => {
    await renderApproval(createApproval({ status: "pending" }));
    await waitForAssertion(() => expect(container.textContent).toContain("Approve"));

    const input = document.createElement("input");
    document.body.appendChild(input);

    await act(async () => {
      fireKeydown(input, "a");
    });

    expect(mockApprovalsApi.approve).not.toHaveBeenCalled();
    input.remove();
  });

  it("ignores modifier-key chords so browser/OS shortcuts are never shadowed", async () => {
    await renderApproval(createApproval({ status: "pending" }));
    await waitForAssertion(() => expect(container.textContent).toContain("Approve"));

    await act(async () => {
      fireKeydown(window, "a", { ctrlKey: true });
    });
    await act(async () => {
      fireKeydown(window, "a", { metaKey: true });
    });

    expect(mockApprovalsApi.approve).not.toHaveBeenCalled();
  });

  // Legacy branch still renders when the flag is off.
  it("renders the legacy layout without the sticky action bar when the flag is off", async () => {
    mockFlagState.decisionCard = false;
    await renderApproval(
      createApproval({ status: "pending", payload: { title: "Legacy view" } }),
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Board Approval: Legacy view");
      // Legacy branch keeps the "See full request" toggle rather than the raw-payload sheet.
      expect(container.textContent).toContain("See full request");
      const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
      expect(labels).toContain("Approve");
    });
    expectNoHookOrderError();
  });
});
