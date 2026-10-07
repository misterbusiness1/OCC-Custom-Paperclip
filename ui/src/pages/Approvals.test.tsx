// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
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
vi.mock("../components/PageTabBar", () => ({
  // Shows each tab's label, so the count badge beside "To decide" can be read.
  PageTabBar: ({ items }: { items: Array<{ value: string; label: ReactNode }> }) => (
    <div>
      {items.map((item) => (
        <span key={item.value} data-tab={item.value}>{item.label}</span>
      ))}
    </div>
  ),
}));
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

  describe("decision feedback", () => {
    type Sent = { resolve: (approval: Approval) => void; reject: (error: Error) => void };
    /** Holds every decision request open until the test settles it. */
    const holdOpen = (mock: typeof apiMocks.approve) => {
      const sent = new Map<string, Sent>();
      mock.mockImplementation(
        (id: string) => new Promise<Approval>((resolve, reject) => sent.set(id, { resolve, reject })),
      );
      return sent;
    };
    const decided = (id: string, status: Approval["status"]) =>
      ({ ...approvals.find((approval) => approval.id === id)!, status }) as Approval;
    const typeNote = (card: HTMLElement, value: string) =>
      act(async () => {
        const note = card.querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, value);
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const alerts = (scope: ParentNode = container) => [...scope.querySelectorAll("[role='alert']")];
    const announced = () => container.querySelector("[data-approval-announcements]")!.textContent;

    it("keeps each card's own busy state, error and note when two decisions are sent close together", async () => {
      const sent = holdOpen(apiMocks.approve);
      await render();

      await click(button(rows()[0], "Add a note"));
      await typeNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));
      await click(button(rows()[1], "Approve"));
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledTimes(2));

      // The first card stays locked while the second is also sending; the third is untouched.
      expect(button(rows()[0], "Approving...").disabled).toBe(true);
      expect(button(rows()[0], "Reject").disabled).toBe(true);
      expect(button(rows()[1], "Approving...").disabled).toBe(true);
      expect(button(rows()[2], "Approve").disabled).toBe(false);
      expect(button(rows()[2], "Approving...")).toBeUndefined();
      expect(alerts()).toHaveLength(0);

      await act(async () => sent.get("oldest")!.reject(new Error("Session expired")));
      await vi.waitFor(() => expect(alerts(rows()[0])).toHaveLength(1));
      // The error is on the card that failed, as an alert, and nowhere else on the page.
      expect(alerts(rows()[0])[0].textContent).toBe("Error while approving: Session expired");
      expect(alerts()).toHaveLength(1);
      expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
      expect(button(rows()[0], "Approve").disabled).toBe(false);
      expect(button(rows()[1], "Approving...").disabled).toBe(true);
      expect(announced()).toBe("Error while approving Request oldest: Session expired");

      await act(async () => sent.get("email")!.resolve(decided("email", "approved")));
      await vi.waitFor(() => expect(rows()[1].textContent).toContain("approved"));
      expect(rows()[1].querySelectorAll("button")).toHaveLength(0);
      expect(alerts(rows()[1])).toHaveLength(0);
      expect(announced()).toBe("Approved: Request email");
      // The failed card is still open for a retry, with its error and its note.
      expect(alerts(rows()[0])[0].textContent).toBe("Error while approving: Session expired");
      expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
      expect(order()).toEqual(["oldest", "email", "newest"]);
    });

    it("clears a card's error when the note is edited or the decision is sent again", async () => {
      apiMocks.reject.mockRejectedValue(new Error("Session expired"));
      await render();

      await click(button(rows()[0], "Reject"));
      await typeNote(rows()[0], "Too expensive");
      await click(button(rows()[0], "Reject request"));
      await vi.waitFor(() => expect(alerts(rows()[0])).toHaveLength(1));
      expect(alerts()[0].textContent).toBe("Error while rejecting: Session expired");
      expect(announced()).toBe("Error while rejecting Request oldest: Session expired");

      await typeNote(rows()[0], "Too expensive this quarter");
      expect(alerts()).toHaveLength(0);

      await click(button(rows()[0], "Reject request"));
      await vi.waitFor(() => expect(alerts(rows()[0])).toHaveLength(1));
      expect(apiMocks.reject).toHaveBeenLastCalledWith("oldest", "Too expensive this quarter");

      // A retry removes the old error for as long as the new request is on its way.
      const sent = holdOpen(apiMocks.reject);
      await click(button(rows()[0], "Reject request"));
      await vi.waitFor(() => expect(sent.has("oldest")).toBe(true));
      expect(alerts()).toHaveLength(0);
      expect(button(rows()[0], "Rejecting...").disabled).toBe(true);
      await act(async () => sent.get("oldest")!.resolve(decided("oldest", "rejected")));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("rejected"));
      expect(announced()).toBe("Rejected: Request oldest");
    });

    it("sends a request only one decision at a time", async () => {
      const sent = holdOpen(apiMocks.approve);
      generalSettingsMock.keyboardShortcutsEnabled = true;
      await render();

      // Two presses before the page has drawn the busy state, then the shortcut once it has.
      await act(async () => {
        button(rows()[0], "Approve").click();
        button(rows()[0], "Approve").click();
      });
      await act(async () => {
        rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true }));
      });
      await vi.waitFor(() => expect(sent.has("oldest")).toBe(true));
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(button(rows()[0], "Approving...").disabled).toBe(true);
    });

    it("keeps a request listed with its error when the reload shows it was decided anyway", async () => {
      // The server stores an approval before it runs what follows from it, so an error can come back for a stored decision.
      apiMocks.approve.mockImplementation(async (id: string) => {
        approvals = approvals.map((approval) => (approval.id === id ? decided(id, "approved") : approval));
        throw new Error("Agent not found");
      });
      await render();
      const listCalls = apiMocks.list.mock.calls.length;

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(alerts(rows()[0])).toHaveLength(1));
      await vi.waitFor(() => expect(apiMocks.list.mock.calls.length).toBeGreaterThan(listCalls));
      await vi.waitFor(() => expect(button(rows()[0], "Approve")).toBeUndefined());

      expect(order()).toEqual(["oldest", "email", "newest"]);
      expect(rows()[0].textContent).toContain("Request oldest");
      expect(rows()[0].textContent).toContain("approved");
      expect(alerts(rows()[0])[0].textContent).toBe("Error while approving: Agent not found");
      expect(alerts()).toHaveLength(1);
    });

    it("announces each landed decision in one polite live region", async () => {
      apiMocks.approve.mockImplementation(async (id: string) => decided(id, "approved"));
      apiMocks.reject.mockImplementation(async (id: string) => decided(id, "rejected"));
      apiMocks.requestRevision.mockImplementation(async (id: string) => decided(id, "revision_requested"));
      await render();

      const regions = container.querySelectorAll("[data-approval-announcements]");
      expect(regions).toHaveLength(1);
      expect(regions[0].getAttribute("aria-live")).toBe("polite");
      expect(regions[0].classList.contains("sr-only")).toBe(true);
      expect(announced()).toBe("");

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(announced()).toBe("Approved: Request oldest"));

      await click(button(rows()[1], "Request changes"));
      await typeNote(rows()[1], "Quote the delivery date");
      await click(button(rows()[1], "Send request"));
      await vi.waitFor(() => expect(announced()).toBe("Changes requested: Request email"));

      await click(button(rows()[2], "Reject"));
      await click(button(rows()[2], "Reject request"));
      await vi.waitFor(() => expect(announced()).toBe("Rejected: Request newest"));
    });

    it("reports a failure to load the list at the top of the page, as an alert", async () => {
      apiMocks.list.mockRejectedValue(new Error("Could not reach the server"));
      await act(async () => {
        root.render(<QueryClientProvider client={queryClient}><Approvals /></QueryClientProvider>);
      });
      await vi.waitFor(() => expect(alerts()).toHaveLength(1));
      expect(alerts()[0].textContent).toBe("Could not reach the server");
      expect(alerts()[0].closest("[data-approval-card]")).toBeNull();
    });
  });

  describe("requests sent back for changes", () => {
    const HOUR_MS = 60 * 60 * 1000;
    /** Created before every pending request, so the old rule would have put it at the top of the queue. */
    const sentBackApproval = (overrides: Partial<Approval> = {}) =>
      createApproval("sent-back", "2026-09-10T00:00:00.000Z", {
        status: "revision_requested",
        decisionNote: "Quote the delivery date.",
        decidedByUserId: "user-board-1",
        decidedAt: new Date(Date.now() - 2 * HOUR_MS - 60_000),
        updatedAt: new Date(Date.now() - 2 * HOUR_MS - 60_000),
        ...overrides,
      });
    const toDecideTab = () => container.querySelector("[data-tab='pending']")!.textContent;
    const section = () => container.querySelector<HTMLElement>("[data-approval-sent-back-section]");
    const sectionToggle = () => section()!.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const sentBackRows = () => [...container.querySelectorAll<HTMLElement>("[data-approval-sent-back-row]")];

    it("lists and counts only pending requests under To decide", async () => {
      approvals = [...approvals, sentBackApproval()];
      await render();

      expect(order()).toEqual(["oldest", "email", "newest"]);
      expect(toDecideTab()).toBe("To decide3");
      for (const card of rows()) expect(card.textContent).not.toContain("Request sent-back");
    });

    it("keeps them in a section below the queue that is folded away until asked for, without decision buttons", async () => {
      approvals = [...approvals, sentBackApproval()];
      await render();

      expect(sectionToggle().textContent).toBe("Waiting on the requester (1)");
      expect(sectionToggle().getAttribute("aria-expanded")).toBe("false");
      expect(sentBackRows()).toHaveLength(0);
      expect(container.textContent).not.toContain("Request sent-back");
      // The section sits after the last card of the queue.
      expect(rows().at(-1)!.compareDocumentPosition(section()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      await click(sectionToggle());
      expect(sectionToggle().getAttribute("aria-expanded")).toBe("true");
      expect(sentBackRows()).toHaveLength(1);
      const row = sentBackRows()[0];
      expect(row.textContent).toContain("revision requested");
      expect(row.textContent).toContain("Request sent-back");
      expect(row.textContent).toContain("Sent back 2h ago");
      expect(row.querySelector("[data-approval-changes-asked]")!.textContent).toBe(
        "Changes you asked forQuote the delivery date.",
      );
      expect(row.querySelectorAll("button")).toHaveLength(0);
      expect([...row.querySelectorAll("a")].map((anchor) => [anchor.textContent, anchor.getAttribute("href")])).toEqual([
        ["View details", "/approvals/sent-back"],
      ]);
      expect(row.textContent).not.toContain("user-board-1");
      expect(row.textContent).not.toContain("agent-requester");
      // The queue itself is unchanged.
      expect(order()).toEqual(["oldest", "email", "newest"]);

      await click(sectionToggle());
      expect(sectionToggle().getAttribute("aria-expanded")).toBe("false");
      expect(sentBackRows()).toHaveLength(0);
    });

    it("shows no such section when nothing is waiting on a requester", async () => {
      await render();
      expect(section()).toBeNull();
      expect(container.textContent).not.toContain("Waiting on the requester");
    });

    it("falls back to the last change for the time, and lists the longest-waiting first", async () => {
      approvals = [
        ...approvals,
        sentBackApproval({ decidedAt: new Date(Date.now() - 3 * HOUR_MS - 60_000) }),
        createApproval("sent-back-earlier", "2026-10-02T00:00:00.000Z", {
          status: "revision_requested",
          decisionNote: null,
          decidedAt: null,
          updatedAt: new Date(Date.now() - 5 * HOUR_MS - 60_000),
        }),
      ];
      await render();
      await click(sectionToggle());

      expect(sectionToggle().textContent).toBe("Waiting on the requester (2)");
      expect(sentBackRows().map((row) => row.dataset.approvalSentBackRow)).toEqual(["sent-back-earlier", "sent-back"]);
      expect(sentBackRows()[0].textContent).toContain("Sent back 5h ago");
      expect(sentBackRows()[0].textContent).not.toContain("Changes you asked for");
      expect(sentBackRows()[1].textContent).toContain("Sent back 3h ago");
    });

    it("applies the kind filter and the sort to the queue only", async () => {
      approvals = [
        ...approvals,
        sentBackApproval({ type: "hire_agent", payload: { name: "Pricing Analyst" } }),
      ];
      await render();
      await click(sectionToggle());

      // A kind that only a sent-back request has is not offered as a filter.
      expect(button(container, "Hire Agent")).toBeUndefined();
      await click(button(container, "Email replies"));
      expect(order()).toEqual(["email"]);
      expect(sentBackRows()).toHaveLength(1);
      await click(button(container, "Sort: Oldest first"));
      expect(sentBackRows().map((row) => row.dataset.approvalSentBackRow)).toEqual(["sent-back"]);
      expect(toDecideTab()).toBe("To decide3");
    });

    it("leaves them out of J and K", async () => {
      approvals = [...approvals, sentBackApproval()];
      await render();
      await click(sectionToggle());
      const press = (key: string) =>
        act(async () => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        });

      for (let step = 0; step < 5; step += 1) await press("j");
      expect(document.activeElement).toBe(rows()[2]);
      expect(sentBackRows()[0].contains(document.activeElement)).toBe(false);
      expect(sentBackRows()[0].hasAttribute("tabindex")).toBe(false);
    });

    it("says nothing needs a decision when every open request is waiting on its requester", async () => {
      approvals = [sentBackApproval()];
      await act(async () => {
        root.render(<QueryClientProvider client={queryClient}><Approvals /></QueryClientProvider>);
      });
      await vi.waitFor(() => expect(section()).not.toBeNull());

      expect(container.textContent).toContain("Nothing needs a decision.");
      expect(rows()).toHaveLength(0);
      expect(container.querySelector("[data-tab='pending']")!.textContent).toBe("To decide");
      expect(sectionToggle().textContent).toBe("Waiting on the requester (1)");
    });

    it("keeps a request sent back on this visit in its place, once, and takes it out of the count", async () => {
      apiMocks.requestRevision.mockImplementation(async (id: string, note: string) => {
        const decided = {
          ...approvals.find((approval) => approval.id === id)!,
          status: "revision_requested",
          decisionNote: note,
          decidedAt: new Date(),
          updatedAt: new Date(),
        } as Approval;
        approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
        return decided;
      });
      await render();
      expect(toDecideTab()).toBe("To decide3");

      await click(button(rows()[0], "Request changes"));
      await act(async () => {
        const note = rows()[0].querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Quote the delivery date.");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click(button(rows()[0], "Send request"));
      await vi.waitFor(() => expect(toDecideTab()).toBe("To decide2"));

      expect(order()).toEqual(["oldest", "email", "newest"]);
      expect(rows()[0].textContent).toContain("revision requested");
      expect(rows()[0].querySelectorAll("button")).toHaveLength(0);
      // It is already listed above, so it is not repeated below.
      expect(section()).toBeNull();

      // The requester resubmits during the visit: the request needs a decision again, so its card returns.
      approvals = approvals.map((approval) =>
        approval.id === "oldest"
          ? { ...approval, status: "pending", decisionNote: null, decidedAt: null, updatedAt: new Date(Date.now() + 1000) }
          : approval,
      );
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approvals", "company-1"] });
      });
      await vi.waitFor(() => expect(button(rows()[0], "Approve")).toBeDefined());
      expect(toDecideTab()).toBe("To decide3");
      expect(order()).toEqual(["oldest", "email", "newest"]);
    });

    it("shows them as cards without decision buttons under All decisions", async () => {
      routerMock.location.pathname = "/approvals/all";
      approvals = [...approvals, sentBackApproval()];
      await render();

      expect(section()).toBeNull();
      const card = rows().find((row) => row.dataset.approvalCard === "sent-back")!;
      expect(card.textContent).toContain("Waiting on the requester to revise");
      expect(card.textContent).toContain("Changes you asked forQuote the delivery date.");
      expect(button(card, "Approve")).toBeUndefined();
      expect(button(card, "Reject")).toBeUndefined();
      expect(button(rows().find((row) => row.dataset.approvalCard === "oldest")!, "Approve")).toBeDefined();
    });
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
