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
    routerMock.location.hash = "";
    window.localStorage.clear();
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

  const render = async (firstTitle = "Request oldest") => {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Approvals /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(container.textContent).toContain(firstTitle));
  };
  const VIEW_KEY = "paperclip.approvals.view";
  /** The reader chose "Full cards" on an earlier visit: every card under To decide is open. */
  const chooseFullCards = () => window.localStorage.setItem(VIEW_KEY, "full");
  /** The button in a collapsible card's header; a compact decided row has none. */
  const header = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("h3 > button[aria-expanded]");
  const openIds = () =>
    rows().filter((row) => header(row)?.getAttribute("aria-expanded") === "true").map((row) => row.dataset.approvalCard);
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
      // Two cards are open at once only in the "Full cards" view.
      chooseFullCards();
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
      // Its card returns closed: the request after it opened when this one was sent back.
      await vi.waitFor(() => expect(header(rows()[0])).not.toBeNull());
      expect(openIds()).toEqual(["email"]);
      await click(header(rows()[0])!);
      expect(button(rows()[0], "Approve")).toBeDefined();
      expect(toDecideTab()).toBe("To decide3");
      expect(order()).toEqual(["oldest", "email", "newest"]);
    });

    it("shows them as cards without decision buttons under All decisions", async () => {
      routerMock.location.pathname = "/approvals/all";
      approvals = [...approvals, sentBackApproval()];
      await render();

      expect(section()).toBeNull();
      const cardFor = (id: string) => rows().find((row) => row.dataset.approvalCard === id)!;
      // Every card under All decisions starts closed; each is opened to be read.
      await click(header(cardFor("sent-back"))!);
      const card = cardFor("sent-back");
      expect(card.textContent).toContain("Waiting on the requester to revise");
      expect(card.textContent).toContain("Changes you asked forQuote the delivery date.");
      expect(button(card, "Approve")).toBeUndefined();
      expect(button(card, "Reject")).toBeUndefined();
      await click(header(cardFor("oldest"))!);
      expect(button(cardFor("oldest"), "Approve")).toBeDefined();
    });
  });

  describe("a queue that can be scanned and keeps the reader's place", () => {
    const press = (key: string, target: EventTarget = document, init: KeyboardEventInit = {}) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
      });
    const approveAs = (status: Approval["status"] = "approved") =>
      apiMocks.approve.mockImplementation(async (id: string) => {
        const decided = {
          ...approvals.find((approval) => approval.id === id)!,
          status,
          decidedAt: new Date(),
        } as Approval;
        approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
        return decided;
      });
    /** `count` pending requests, r01 the longest waiting. */
    const pendingRequests = (count: number) =>
      Array.from({ length: count }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        return createApproval(`r${number}`, `2026-09-${number}T00:00:00.000Z`);
      });
    const cards = () => rows().filter((row) => !row.hasAttribute("data-approval-decided-row"));
    const showMore = () =>
      [...container.querySelectorAll("button")].find((candidate) => /^Show \d+ more$/.test(candidate.textContent ?? ""));
    const progress = () => container.querySelector("[data-approval-progress]")?.textContent ?? null;
    const blur = () => act(async () => (document.activeElement as HTMLElement | null)?.blur());

    it("opens the first request on load and shows the others as compact rows that cannot be decided", async () => {
      await render();

      expect(openIds()).toEqual(["oldest"]);
      expect(button(rows()[0], "Approve")).toBeDefined();
      expect(rows()[0].textContent).toContain("It fits the request.");

      for (const row of rows().slice(1)) {
        expect(header(row)!.getAttribute("aria-expanded")).toBe("false");
        expect(row.querySelectorAll("button")).toHaveLength(1);
        expect(row.querySelector("textarea")).toBeNull();
        // The row still says what the request is and what it asks, in one line.
        expect(row.textContent).toContain("Waiting");
        expect(row.textContent).not.toContain("It fits the request.");
        expect(row.textContent).not.toContain("It answers the question.");
      }
      expect(header(rows()[1])!.textContent).toBe("Request email");
      expect(rows()[1].querySelector("[data-approval-ask]")!.textContent).toBe("Recommendation: Send the reply.");
      expect(rows()[1].textContent).toContain("Email reply");
      // The draft is part of the open card only.
      expect(rows()[1].textContent).not.toContain("Draft body");
      expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Approve")).toHaveLength(1);
    });

    it("opens a request from its header, closes the one that was open, and closes an open one again", async () => {
      await render();

      await click(header(rows()[2])!);
      expect(openIds()).toEqual(["newest"]);
      expect(button(rows()[2], "Approve")).toBeDefined();
      expect(button(rows()[0], "Approve")).toBeUndefined();

      await click(header(rows()[2])!);
      expect(openIds()).toEqual([]);
      expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Approve")).toHaveLength(0);
    });

    it("opens each request J and K move to", async () => {
      await render();

      await press("j");
      expect(document.activeElement).toBe(rows()[0]);
      expect(openIds()).toEqual(["oldest"]);
      await press("j");
      expect(document.activeElement).toBe(rows()[1]);
      expect(openIds()).toEqual(["email"]);
      expect(button(rows()[1], "Approve")).toBeDefined();
      expect(button(rows()[0], "Approve")).toBeUndefined();
      await press("k");
      expect(document.activeElement).toBe(rows()[0]);
      expect(openIds()).toEqual(["oldest"]);
    });

    it("carries on from the row that last held focus when focus has dropped to the page", async () => {
      await render();
      await press("j");
      await press("j");
      expect(document.activeElement).toBe(rows()[1]);

      await blur();
      expect(document.activeElement).toBe(document.body);
      await press("j");
      expect(document.activeElement).toBe(rows()[2]);
      expect(openIds()).toEqual(["newest"]);

      // The same from a control outside the list.
      await act(async () => button(container, "Sort: Oldest first").focus());
      await press("k");
      expect(document.activeElement).toBe(rows()[1]);
      expect(openIds()).toEqual(["email"]);
    });

    it("remembers a row the reader clicked into, not only one reached with J", async () => {
      await render();
      await click(header(rows()[1])!);
      await act(async () => header(rows()[1])!.focus());
      await blur();

      await press("j");
      expect(document.activeElement).toBe(rows()[2]);
    });

    it("ignores Shift+A, Shift+C and Shift+X on a collapsed row", async () => {
      approveAs();
      await render();

      await act(async () => rows()[1].focus());
      await press("A", rows()[1], { shiftKey: true });
      await press("X", rows()[1], { shiftKey: true });
      await press("C", rows()[1], { shiftKey: true });
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(container.querySelector("textarea")).toBeNull();

      // Open, the same key decides.
      await click(header(rows()[1])!);
      await press("A", rows()[1], { shiftKey: true });
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("email"));
    });

    it("opens the next undecided request after a decision and moves focus to it", async () => {
      approveAs();
      await render();

      await act(async () => button(rows()[0], "Approve").focus());
      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));

      expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(true);
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);
      expect(rows()[1].tabIndex).toBe(-1);
      // J now goes on from there, not back to the top.
      await press("j");
      expect(document.activeElement).toBe(rows()[2]);
      expect(openIds()).toEqual(["newest"]);
    });

    it("falls back to the nearest undecided request before the decided one, then to the decided row itself", async () => {
      approveAs();
      await render();

      await click(header(rows()[2])!);
      await click(button(rows()[2], "Approve"));
      await vi.waitFor(() => expect(rows()[2].textContent).toContain("approved"));
      // Nothing undecided follows "newest": the nearest one before it opens.
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);

      await click(button(rows()[1], "Approve"));
      await vi.waitFor(() => expect(rows()[1].textContent).toContain("approved"));
      expect(openIds()).toEqual(["oldest"]);
      expect(document.activeElement).toBe(rows()[0]);

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
      // Nothing is left to open; focus rests on the row just decided, never on the page.
      expect(cards()).toHaveLength(0);
      expect(document.activeElement).toBe(rows()[0]);
    });

    it("takes the reader on when focus sits on the pane around the list, as it does after the page opens", async () => {
      approveAs();
      await render();
      // The app shell focuses its main pane after navigation; a tap on Approve need not move focus off it.
      container.tabIndex = -1;
      await act(async () => container.focus());

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);
    });

    it("leaves focus where the reader put it when they moved on before the decision landed", async () => {
      let land: (approval: Approval) => void = () => {};
      apiMocks.approve.mockImplementation(
        (id: string) =>
          new Promise<Approval>((resolve) => {
            land = () => resolve({ ...approvals.find((approval) => approval.id === id)!, status: "approved" } as Approval);
          }),
      );
      await render();

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("oldest"));
      // The reader opens the last request while the first is still sending.
      await click(header(rows()[2])!);
      await act(async () => button(rows()[2], "Add a note").focus());
      expect(rows()[0].textContent).toContain("Sending your decision...");

      await act(async () => land({} as Approval));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
      expect(openIds()).toEqual(["newest"]);
      expect(document.activeElement).toBe(button(rows()[2], "Add a note"));
    });

    it("shows a failed decision on its row when the reader has opened another request", async () => {
      let fail: () => void = () => {};
      apiMocks.approve.mockImplementation(
        () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
      );
      await render();

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("oldest"));
      await click(header(rows()[1])!);
      await act(async () => fail());

      await vi.waitFor(() => expect(rows()[0].querySelector("[role='alert']")).not.toBeNull());
      expect(rows()[0].querySelector("[role='alert']")!.textContent).toBe("Error while approving: Session expired");
      expect(openIds()).toEqual(["email"]);
    });

    it("brings the next request into view, and the decided row to the top first when its card began above the screen", async () => {
      approveAs();
      const scrolls: Array<[string | undefined, ScrollLogicalPosition | undefined]> = [];
      const scrollIntoView = vi.fn(function (this: HTMLElement, options?: ScrollIntoViewOptions) {
        scrolls.push([this.dataset.approvalCard, options?.block]);
      });
      const prototype = HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
      const original = prototype.scrollIntoView;
      prototype.scrollIntoView = scrollIntoView;
      try {
        await render();

        // A card that fits the screen: only the next request is scrolled, and only as far as needed.
        await click(button(rows()[0], "Approve"));
        await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
        expect(scrolls).toEqual([["email", "nearest"]]);

        // A tall card whose top has scrolled off: the row it becomes goes to the top before the next is shown.
        scrolls.length = 0;
        rows()[1].getBoundingClientRect = () => ({ top: -900 }) as DOMRect;
        await click(button(rows()[1], "Approve"));
        await vi.waitFor(() => expect(rows()[1].textContent).toContain("approved"));
        expect(scrolls).toEqual([["email", "start"], ["newest", "nearest"]]);
      } finally {
        prototype.scrollIntoView = original;
      }
    });

    it("keeps every card open in the Full cards view, remembers the choice, and still keeps the reader's place", async () => {
      approveAs();
      await render();
      const viewButton = (label: string) => button(container, label);
      expect(viewButton("Compact").getAttribute("aria-pressed")).toBe("true");
      expect(viewButton("Full cards").getAttribute("aria-pressed")).toBe("false");

      await click(viewButton("Full cards"));
      expect(window.localStorage.getItem(VIEW_KEY)).toBe("full");
      expect(viewButton("Full cards").getAttribute("aria-pressed")).toBe("true");
      // Cards as before: all open, no header button.
      for (const row of rows()) {
        expect(header(row)).toBeNull();
        expect(button(row, "Approve")).toBeDefined();
      }

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
      expect(document.activeElement).toBe(rows()[1]);
      expect(progress()).toBe("1 decided this visit · 2 left to decide");

      // The choice holds on the next visit.
      act(() => root.unmount());
      root = createRoot(container);
      await render("Request email");
      expect(button(container, "Full cards").getAttribute("aria-pressed")).toBe("true");
      expect(button(rows().find((row) => row.dataset.approvalCard === "newest")!, "Approve")).toBeDefined();

      await click(button(container, "Compact"));
      expect(window.localStorage.getItem(VIEW_KEY)).toBe("compact");
      expect(openIds()).toHaveLength(1);
    });

    it("works without storage for the view choice", async () => {
      const blocked = () => {
        throw new Error("storage is blocked");
      };
      const setItem = vi.fn(blocked);
      vi.stubGlobal("localStorage", { getItem: vi.fn(blocked), setItem, clear: () => {} });
      try {
        await render();
        expect(openIds()).toEqual(["oldest"]);
        await click(button(container, "Full cards"));
        expect(setItem).toHaveBeenCalledWith(VIEW_KEY, "full");
        for (const row of rows()) expect(button(row, "Approve")).toBeDefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("counts only undecided requests against the page, so each decision brings the next one in", async () => {
      approveAs();
      approvals = pendingRequests(23);
      await render("Request r01");

      expect(rows()).toHaveLength(20);
      expect(showMore()!.textContent).toBe("Show 3 more");
      expect(container.textContent).not.toContain("Request r21");

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
      // The compact row does not use up the page: 20 undecided requests are still on it.
      expect(rows()).toHaveLength(21);
      expect(cards()).toHaveLength(20);
      expect(cards().at(-1)!.dataset.approvalCard).toBe("r21");
      expect(showMore()!.textContent).toBe("Show 2 more");

      await click(button(rows()[1], "Approve"));
      await vi.waitFor(() => expect(rows()[1].textContent).toContain("approved"));
      expect(cards()).toHaveLength(20);
      expect(showMore()!.textContent).toBe("Show 1 more");
      expect(progress()).toBe("2 decided this visit · 21 left to decide");
    });

    it("moves focus to the first request that Show more brings in", async () => {
      approvals = pendingRequests(23);
      await render("Request r01");

      await act(async () => showMore()!.focus());
      await click(showMore()!);
      expect(rows()).toHaveLength(23);
      expect(showMore()).toBeUndefined();
      const firstNew = rows()[20];
      expect(firstNew.dataset.approvalCard).toBe("r21");
      expect(document.activeElement).toBe(firstNew);
      expect(openIds()).toEqual(["r21"]);
    });

    it("says how many were decided this visit and how many are left, once there is one", async () => {
      approveAs();
      apiMocks.reject.mockImplementation(async (id: string) => {
        const decided = { ...approvals.find((approval) => approval.id === id)!, status: "rejected" } as Approval;
        approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
        return decided;
      });
      await render();
      expect(progress()).toBeNull();

      await click(button(rows()[0], "Approve"));
      await vi.waitFor(() => expect(progress()).toBe("1 decided this visit · 2 left to decide"));

      await click(button(rows()[1], "Reject"));
      await click(button(rows()[1], "Reject request"));
      await vi.waitFor(() => expect(progress()).toBe("2 decided this visit · 1 left to decide"));
    });

    it("starts every card under All decisions closed, in both views, with its decided time on the row", async () => {
      approveAs();
      chooseFullCards();
      routerMock.location.pathname = "/approvals/all";
      approvals = approvals.map((approval) =>
        approval.id === "done" ? { ...approval, decidedAt: new Date(Date.now() - 3 * 60 * 60 * 1000 - 60_000) } : approval,
      );
      await render();

      expect(order()).toEqual(["newest", "email", "oldest", "done"]);
      expect(openIds()).toEqual([]);
      expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Approve")).toHaveLength(0);
      // The view choice belongs to the queue; it is not offered here.
      expect(button(container, "Full cards")).toBeUndefined();
      const done = rows()[3];
      expect(done.textContent).toContain("approved");
      expect(done.textContent).toContain("Approved 3h ago");

      // A decided request can be opened to read it; it has nothing to decide.
      await click(header(done)!);
      expect(openIds()).toEqual(["done"]);
      expect(done.textContent).toContain("It fits the request.");
      expect(button(done, "Approve")).toBeUndefined();

      // A pending one is decided only once it is open, and the reader is not sent down the history afterwards.
      await press("A", rows()[2], { shiftKey: true });
      expect(apiMocks.approve).not.toHaveBeenCalled();
      await click(header(rows()[2])!);
      await click(button(rows()[2], "Approve"));
      await vi.waitFor(() => expect(rows()[2].hasAttribute("data-approval-decided-row")).toBe(true));
      expect(openIds()).toEqual([]);
      expect(document.activeElement).toBe(rows()[2]);
    });

    it("opens and focuses the request a link points at, and puts it on the page", async () => {
      approvals = pendingRequests(45);
      routerMock.location.hash = "#approval-r43";
      await render("Request r01");

      // 43 is on the third page of 20.
      await vi.waitFor(() => expect(openIds()).toEqual(["r43"]));
      expect(rows()).toHaveLength(45);
      const target = rows().find((row) => row.dataset.approvalCard === "r43")!;
      expect(document.activeElement).toBe(target);
      expect(button(target, "Approve")).toBeDefined();
      expect(showMore()).toBeUndefined();
    });

    it("ignores a link to a request that is not listed, and unfolds the section a sent-back one sits in", async () => {
      routerMock.location.hash = "#approval-done";
      await render();
      expect(openIds()).toEqual(["oldest"]);
      expect(rows().includes(document.activeElement as HTMLElement)).toBe(false);

      act(() => root.unmount());
      root = createRoot(container);
      approvals = [
        ...approvals,
        createApproval("sent-back", "2026-09-10T00:00:00.000Z", { status: "revision_requested" }),
      ];
      routerMock.location.hash = "#approval-sent-back";
      await render();
      await vi.waitFor(() =>
        expect(container.querySelector("[data-approval-sent-back-row='sent-back']")).not.toBeNull());
      expect(openIds()).toEqual(["oldest"]);
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
    expect(openIds()).toEqual(["oldest"]);
    expect(container.textContent).not.toContain("Shift+A approve");
    await act(async () => {
      rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true }));
    });
    expect(apiMocks.approve).not.toHaveBeenCalled();

    // The page still keeps the reader's place after a decision: the next card opens and takes focus,
    // and the compact row left behind can take focus too.
    apiMocks.approve.mockImplementation(async (id: string) => (
      { ...approvals.find((approval) => approval.id === id)!, status: "approved" } as Approval
    ));
    await click(button(rows()[0], "Approve"));
    await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
    expect(rows()[0].tabIndex).toBe(-1);
    expect(openIds()).toEqual(["email"]);
    expect(document.activeElement).toBe(rows()[1]);
  });
});
