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
const toastMock = vi.hoisted(() => ({ pushToast: vi.fn() }));

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
vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => toastMock,
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

import { APPROVE_AFTER_ADVANCE_MS, APPROVE_HOLD_MS } from "../components/ApprovalHold";
import { APPROVAL_SHORTCUT_HINT, Approvals } from "./Approvals";

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
    // An approval is held for a few seconds before it is sent; the tests move the clock past that.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    toastMock.pushToast.mockReset();
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
    vi.useRealTimers();
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
  /** Lets the undo window that follows Approve run out, so the held approval is sent. */
  const endHold = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_HOLD_MS);
    });
  /**
   * Lets the moment pass in which an Approve on the card the page has just opened by itself is
   * taken for the second half of a double click and ignored.
   */
  const pastDoubleClick = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_AFTER_ADVANCE_MS);
    });
  const KEEPALIVE = { keepalive: true };
  /** The compact rows of approvals that are held for undo or on their way. */
  const heldRows = () => [...container.querySelectorAll<HTMLElement>("[data-approval-held-row]")];

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
    await endHold();

    await vi.waitFor(() =>
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", KEEPALIVE));
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

  it("shows a note typed on several lines with its lines, in the held row and in the decided row", async () => {
    apiMocks.approve.mockImplementation(async (id: string, note?: string) => {
      const decided = { ...approvals.find((approval) => approval.id === id)!, status: "approved", decisionNote: note ?? null } as Approval;
      approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
      return decided;
    });
    await render();
    const typed = "1. Month to month only.\n2. Review in March.";

    const card = rows()[0];
    await click(button(card, "Add a note"));
    await act(async () => {
      const note = card.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, typed);
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(card, "Approve"));

    const rowNote = () => rows()[0].querySelector<HTMLElement>("[data-approval-row-note]")!;
    expect(heldRows()).toHaveLength(1);
    expect(rowNote().textContent).toBe(`Your note. ${typed}`);
    expect(rowNote().classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(rowNote().classList.contains("break-words")).toBe(true);

    await endHold();
    await vi.waitFor(() => expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(true));
    expect(rowNote().textContent).toBe(`Your note. ${typed}`);
    expect(rowNote().classList.contains("whitespace-pre-wrap")).toBe(true);
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
    // Every line that reports an error. On this page a card's own error line is not an alert: the
    // page's live region announces each outcome once (see "announces a failure once" below).
    const alerts = (scope: ParentNode = container) => [
      ...scope.querySelectorAll("[role='alert'], [data-approval-decision-error], [data-approval-row-error]"),
    ];
    const announced = () => container.querySelector("[data-approval-announcements]")!.textContent;

    it("keeps each card's own busy state, error and note when two decisions are sent close together", async () => {
      const sent = holdOpen(apiMocks.approve);
      // Two cards are open at once only in the "Full cards" view.
      chooseFullCards();
      await render();

      await click(button(rows()[0], "Add a note"));
      await typeNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));
      await pastDoubleClick();
      await click(button(rows()[1], "Approve"));
      await endHold();
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledTimes(2));

      // Both are compact rows with nothing left to press while they are sending; the third is untouched.
      expect(rows()[0].textContent).toContain("Approving...");
      expect(rows()[0].querySelectorAll("button")).toHaveLength(0);
      expect(rows()[1].textContent).toContain("Approving...");
      expect(rows()[1].querySelectorAll("button")).toHaveLength(0);
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
      expect(rows()[1].textContent).toContain("Approving...");
      expect(rows()[1].querySelectorAll("button")).toHaveLength(0);
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
      // One hold was started, not two.
      expect(heldRows()).toHaveLength(1);
      await endHold();
      await vi.waitFor(() => expect(sent.has("oldest")).toBe(true));
      await endHold();
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(rows()[0].textContent).toContain("Approving...");
      expect(rows()[0].querySelectorAll("button")).toHaveLength(0);
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
      await endHold();
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
      // Held first: the announcement says it can still be undone.
      expect(announced()).toBe("Approving in 5 seconds. Shift+Z undoes it. Request oldest");
      await endHold();
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
      // A link to this request moves focus to the row, so the row says what it holds.
      expect(row.tabIndex).toBe(-1);
      expect(row.getAttribute("aria-label")).toBe("Revision requested: Request sent-back");
      expect(row.tagName).toBe("LI");
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
      // A link can bring focus to the row, but it is not a stop of its own in the tab order.
      expect(sentBackRows()[0].tabIndex).toBe(-1);
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
    const cards = () =>
      rows().filter(
        (row) => !row.hasAttribute("data-approval-decided-row") && !row.hasAttribute("data-approval-held-row"),
      );
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
      // Nothing was held for sending either.
      expect(heldRows()).toHaveLength(0);
      await endHold();
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(container.querySelector("textarea")).toBeNull();

      // Open, the same key decides.
      await click(header(rows()[1])!);
      await press("A", rows()[1], { shiftKey: true });
      await endHold();
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("email", undefined, KEEPALIVE));
    });

    it("opens the next undecided request after a decision and moves focus to it", async () => {
      approveAs();
      await render();

      await act(async () => button(rows()[0], "Approve").focus());
      await click(button(rows()[0], "Approve"));
      // The reader is taken on as soon as the approval is held, before anything is sent.
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);

      await endHold();
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
      await endHold();
      await vi.waitFor(() => expect(rows()[2].textContent).toContain("approved"));
      // Nothing undecided follows "newest": the nearest one before it opens.
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);

      await click(button(rows()[1], "Approve"));
      await endHold();
      await vi.waitFor(() => expect(rows()[1].textContent).toContain("approved"));
      expect(openIds()).toEqual(["oldest"]);
      expect(document.activeElement).toBe(rows()[0]);

      await click(button(rows()[0], "Approve"));
      // Nothing is left to open: focus rests on the held row, and stays on it when the approval lands.
      expect(document.activeElement).toBe(rows()[0]);
      await endHold();
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
      await endHold();
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
      await endHold();
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, KEEPALIVE));
      // The reader opens the last request while the first is still sending.
      await click(header(rows()[2])!);
      await act(async () => button(rows()[2], "Add a note").focus());
      expect(rows()[0].textContent).toContain("Approving...");

      await act(async () => land({} as Approval));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
      expect(openIds()).toEqual(["newest"]);
      expect(document.activeElement).toBe(button(rows()[2], "Add a note"));
    });

    it("shows a failed decision on its row when the reader has opened another request", async () => {
      let fail: () => void = () => {};
      apiMocks.reject.mockImplementation(
        () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
      );
      await render();

      await click(button(rows()[0], "Reject"));
      await click(button(rows()[0], "Reject request"));
      await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest"));
      await click(header(rows()[1])!);
      expect(rows()[0].textContent).toContain("Sending your decision...");
      await act(async () => fail());

      await vi.waitFor(() => expect(rows()[0].querySelector("[data-approval-row-error]")).not.toBeNull());
      expect(rows()[0].querySelector("[data-approval-row-error]")!.textContent).toBe("Error while rejecting: Session expired");
      expect(openIds()).toEqual(["email"]);
    });

    it("announces a failure once: the error line is not an alert that speaks again each time its card is opened or closed", async () => {
      let fail: () => void = () => {};
      apiMocks.reject.mockImplementation(
        () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
      );
      await render();
      const announcements = container.querySelector("[data-approval-announcements]")!;
      const list = () => container.querySelector<HTMLElement>("[data-approval-card]")!.parentElement!;
      const errorLines = () => [
        ...list().querySelectorAll<HTMLElement>("[data-approval-decision-error], [data-approval-row-error]"),
      ];

      await click(button(rows()[0], "Reject"));
      await click(button(rows()[0], "Reject request"));
      await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest"));
      await act(async () => fail());
      await vi.waitFor(() => expect(errorLines()).toHaveLength(1));

      // One announcer: the page's polite region. The line on the card is text, not a second alert.
      expect(announcements.textContent).toBe("Error while rejecting Request oldest: Session expired");
      expect(announcements.getAttribute("aria-live")).toBe("polite");
      expect(errorLines()[0].textContent).toBe("Error while rejecting: Session expired");
      expect(list().querySelectorAll("[role='alert']")).toHaveLength(0);
      // Approve is still described by the error, for a reader who lands on the button.
      expect(button(rows()[0], "Approve").getAttribute("aria-describedby")).toContain(errorLines()[0].id);

      // Closing the card, opening another and coming back each draw the line again; none of them is an alert.
      for (const step of [1, 0, 0, 0]) {
        await click(header(rows()[step])!);
        expect(errorLines()).toHaveLength(1);
        expect(errorLines()[0].textContent).toBe("Error while rejecting: Session expired");
        expect(list().querySelectorAll("[role='alert']")).toHaveLength(0);
      }
      // Nothing was added to the live region by any of it.
      expect(announcements.textContent).toBe("Error while rejecting Request oldest: Session expired");
    });

    it("says in the hint line that the decision keys act on the open request while focus is inside it", async () => {
      // The approval held at the end is sent when the page is left.
      approveAs();
      await render();
      const hint = [...container.querySelectorAll("span")].find((span) => span.textContent === APPROVAL_SHORTCUT_HINT)!;
      expect(hint).toBeDefined();
      expect(APPROVAL_SHORTCUT_HINT).toBe(
        "J / K move to a request and open it · With focus in the open request: Shift+A approve, Shift+C request changes, Shift+X reject · Shift+Z undo approve",
      );

      // The words match the handlers: the first card is open, but focus is on the page, and Shift+A does nothing.
      expect(openIds()).toEqual(["oldest"]);
      expect(document.activeElement).toBe(document.body);
      await press("A", document.body, { shiftKey: true });
      expect(heldRows()).toHaveLength(0);
      // J puts focus in the open request; the same key now approves it.
      await press("j");
      expect(document.activeElement).toBe(rows()[0]);
      await press("A", rows()[0], { shiftKey: true });
      expect(heldRows().map((row) => row.dataset.approvalCard)).toEqual(["oldest"]);
    });

    it("works with Caps Lock on: J, K, Shift+A and Shift+Z arrive in the other case", async () => {
      approveAs();
      await render();

      // Caps Lock turns a plain j into "J" (no Shift) and a Shift+A into "a" (with Shift).
      await press("J");
      expect(document.activeElement).toBe(rows()[0]);
      await press("J");
      expect(document.activeElement).toBe(rows()[1]);
      expect(openIds()).toEqual(["email"]);
      await press("K");
      expect(document.activeElement).toBe(rows()[0]);
      expect(openIds()).toEqual(["oldest"]);

      // A plain letter decides nothing, in either case, and neither does a plain z undo.
      await press("a", rows()[0]);
      await press("A", rows()[0]);
      expect(heldRows()).toHaveLength(0);

      const approveKey = new KeyboardEvent("keydown", { key: "a", shiftKey: true, bubbles: true, cancelable: true });
      await act(async () => {
        rows()[0].dispatchEvent(approveKey);
      });
      expect(heldRows().map((row) => row.dataset.approvalCard)).toEqual(["oldest"]);
      // The key is claimed, so the app-wide shortcuts leave it alone.
      expect(approveKey.defaultPrevented).toBe(true);

      await press("z");
      await press("Z");
      expect(heldRows()).toHaveLength(1);
      await press("z", document, { shiftKey: true });
      expect(heldRows()).toHaveLength(0);
      expect(openIds()).toEqual(["oldest"]);
      expect(apiMocks.approve).not.toHaveBeenCalled();

      // Shift+J and Shift+K stay unused, with or without Caps Lock.
      await press("J", document, { shiftKey: true });
      await press("j", document, { shiftKey: true });
      expect(document.activeElement).toBe(rows()[0]);
      expect(openIds()).toEqual(["oldest"]);
    });

    it("names every row the page moves focus to: the card, the held row and the decided row", async () => {
      approveAs();
      await render();

      // The card: a group named by its title, whose header button is described by its status line.
      const card = rows()[0];
      expect(card.getAttribute("role")).toBe("group");
      expect(document.getElementById(card.getAttribute("aria-labelledby")!)!.textContent).toBe("Request oldest");
      const described = document.getElementById(header(card)!.getAttribute("aria-describedby")!)!;
      expect(described.textContent).toContain("pending");
      expect(described.textContent).toContain("Waiting");
      // A closed row is named the same way.
      expect(document.getElementById(rows()[1].getAttribute("aria-labelledby")!)!.textContent).toBe("Request email");

      // Held: the name says what the row is and does not count down.
      await press("j");
      await press("A", rows()[0], { shiftKey: true });
      const held = rows()[0];
      expect(held.dataset.approvalHeldRow).toBe("holding");
      expect(held.getAttribute("role")).toBe("group");
      expect(held.getAttribute("aria-label")).toBe("Approval held: Request oldest");
      // Focus went to the next card, which has a name.
      expect(document.activeElement).toBe(rows()[1]);
      expect(rows()[1].getAttribute("role")).toBe("group");

      // Decided: named by its status.
      await endHold();
      await vi.waitFor(() => expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(true));
      expect(rows()[0].getAttribute("role")).toBe("group");
      expect(rows()[0].getAttribute("aria-label")).toBe("Approved: Request oldest");
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
        // The move is made when the approval is held; nothing moves again when it lands.
        expect(scrolls).toEqual([["email", "nearest"]]);
        await endHold();
        await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
        expect(scrolls).toEqual([["email", "nearest"]]);

        // A tall card whose top has scrolled off: the row it becomes goes to the top before the next is shown.
        scrolls.length = 0;
        rows()[1].getBoundingClientRect = () => ({ top: -900 }) as DOMRect;
        await click(button(rows()[1], "Approve"));
        expect(scrolls).toEqual([["email", "start"], ["newest", "nearest"]]);
        await endHold();
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
      await endHold();
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
      // The next request comes onto the page as soon as the approval is held.
      expect(cards().at(-1)!.dataset.approvalCard).toBe("r21");
      await endHold();
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
      // The compact row does not use up the page: 20 undecided requests are still on it.
      expect(rows()).toHaveLength(21);
      expect(cards()).toHaveLength(20);
      expect(cards().at(-1)!.dataset.approvalCard).toBe("r21");
      expect(showMore()!.textContent).toBe("Show 2 more");

      await click(button(rows()[1], "Approve"));
      await endHold();
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
      await endHold();
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
      expect(heldRows()).toHaveLength(0);
      expect(apiMocks.approve).not.toHaveBeenCalled();
      await click(header(rows()[2])!);
      await click(button(rows()[2], "Approve"));
      await endHold();
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

    it("says so when a link points at a request that is not listed, and leaves no other request open in its place", async () => {
      const announced = () => container.querySelector("[data-approval-announcements]")!.textContent;
      routerMock.location.hash = "#approval-done";
      await render();
      // The reader followed a link to one request: another one is not shown open, Approve ready, as if it were that one.
      await vi.waitFor(() => expect(openIds()).toEqual([]));
      expect(announced()).toBe("The linked request is not in this list. Its status is approved.");
      expect(rows().includes(document.activeElement as HTMLElement)).toBe(false);

      act(() => root.unmount());
      root = createRoot(container);
      routerMock.location.hash = "#approval-no-such-request";
      await render();
      await vi.waitFor(() => expect(announced()).toBe("The linked request was not found."));
      expect(openIds()).toEqual([]);
    });

    it("unfolds the section a linked sent-back request sits in, and takes the reader to its row", async () => {
      const scrolls: Array<[string | undefined, ScrollLogicalPosition | undefined]> = [];
      const prototype = HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
      const original = prototype.scrollIntoView;
      prototype.scrollIntoView = function (this: HTMLElement, options?: ScrollIntoViewOptions) {
        scrolls.push([this.dataset.approvalSentBackRow ?? this.dataset.approvalCard, options?.block]);
      };
      try {
        approvals = [
          ...approvals,
          createApproval("sent-back", "2026-09-10T00:00:00.000Z", { status: "revision_requested" }),
        ];
        routerMock.location.hash = "#approval-sent-back";
        await render();
        const sentBackRow = () => container.querySelector<HTMLElement>("[data-approval-sent-back-row='sent-back']");
        await vi.waitFor(() => expect(sentBackRow()).not.toBeNull());
        // The section is far below a full queue: its row is brought to the top and takes focus.
        expect(document.activeElement).toBe(sentBackRow());
        expect(scrolls).toEqual([["sent-back", "start"]]);
        expect(sentBackRow()!.className).toContain("scroll-mt-16");
        expect(openIds()).toEqual([]);
      } finally {
        prototype.scrollIntoView = original;
      }
    });

    it("follows the same link a second time", async () => {
      const rerender = () =>
        act(async () => {
          root.render(<QueryClientProvider client={queryClient}><Approvals /></QueryClientProvider>);
        });
      routerMock.location.hash = "#approval-newest";
      await render();
      await vi.waitFor(() => expect(openIds()).toEqual(["newest"]));

      // The reader goes to All decisions and comes back to the same address; the page stays mounted.
      routerMock.location.pathname = "/approvals/all";
      routerMock.location.hash = "";
      await rerender();
      expect(openIds()).toEqual([]);
      routerMock.location.pathname = "/approvals/pending";
      routerMock.location.hash = "#approval-newest";
      await rerender();
      await vi.waitFor(() => expect(openIds()).toEqual(["newest"]));
      expect(document.activeElement).toBe(rows()[2]);
    });
  });

  describe("the undo window after Approve", () => {
    type Sent = { resolve: (approval: Approval) => void; reject: (error: Error) => void };
    /** Holds every approve request open until the test settles it. */
    const holdOpen = () => {
      const sent = new Map<string, Sent>();
      apiMocks.approve.mockImplementation(
        (id: string) => new Promise<Approval>((resolve, reject) => sent.set(id, { resolve, reject })),
      );
      return sent;
    };
    /** Approves on the server at once, as the real route does. */
    const approveAtOnce = () =>
      apiMocks.approve.mockImplementation(async (id: string, note?: string) => {
        const decided = {
          ...approvals.find((approval) => approval.id === id)!,
          status: "approved",
          decisionNote: note ?? null,
          decidedAt: new Date(),
        } as Approval;
        approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
        return decided;
      });
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const typeNote = (card: HTMLElement, value: string) =>
      act(async () => {
        const note = card.querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, value);
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const addNote = async (card: HTMLElement, value: string) => {
      await click(button(card, "Add a note"));
      await typeNote(card, value);
    };
    const press = (key: string, target: EventTarget = document, init: KeyboardEventInit = {}) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
      });
    const holdStatus = (row: HTMLElement) => row.querySelector("[data-approval-hold-status]")?.textContent ?? null;
    const undoButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("[data-approval-undo]");
    // Every line that reports an error. On this page a card's own error line is not an alert: the
    // page's live region announces each outcome once (see "announces a failure once" below).
    const alerts = (scope: ParentNode = container) => [
      ...scope.querySelectorAll("[role='alert'], [data-approval-decision-error], [data-approval-row-error]"),
    ];
    const announced = () => container.querySelector("[data-approval-announcements]")!.textContent;
    const progress = () => container.querySelector("[data-approval-progress]")?.textContent ?? null;
    const rerender = () =>
      act(async () => {
        root.render(<QueryClientProvider client={queryClient}><Approvals /></QueryClientProvider>);
      });

    beforeEach(() => {
      // The clock moves only when a test moves it, so the hold can be measured to the millisecond.
      vi.useRealTimers();
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    it("holds an approval for five seconds, counting down, and sends nothing until the time is up", async () => {
      const sent = holdOpen();
      await render();
      expect(APPROVE_HOLD_MS).toBe(5000);

      await addNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));

      // The card is its compact row at once, and nothing has been sent.
      const row = rows()[0];
      expect(row.dataset.approvalHeldRow).toBe("holding");
      expect(holdStatus(row)).toBe("Approving in 5s");
      expect(row.textContent).toContain("Request oldest");
      expect(row.textContent).toContain("Your note. Month to month only");
      expect(row.textContent).not.toContain("approved");
      expect(row.querySelectorAll("button")).toHaveLength(1);
      expect(undoButton(row)!.textContent).toBe("Undo");
      expect(undoButton(row)!.getAttribute("aria-label")).toBe("Undo approval: Request oldest");
      expect(row.tabIndex).toBe(-1);
      expect(apiMocks.approve).not.toHaveBeenCalled();
      // The time and the way back are said first; the title, which can be long, comes last.
      expect(announced()).toBe("Approving in 5 seconds. Shift+Z undoes it. Request oldest");

      await advance(1000);
      expect(holdStatus(rows()[0])).toBe("Approving in 4s");
      await advance(3000);
      expect(holdStatus(rows()[0])).toBe("Approving in 1s");
      await advance(999);
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(undoButton(rows()[0])).not.toBeNull();

      await advance(1);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", KEEPALIVE);
      // On its way: the row stays, and there is nothing left to undo.
      expect(rows()[0].dataset.approvalHeldRow).toBe("sending");
      expect(holdStatus(rows()[0])).toBe("Approving...");
      expect(rows()[0].querySelectorAll("button")).toHaveLength(0);

      await act(async () =>
        sent.get("oldest")!.resolve({
          ...approvals.find((approval) => approval.id === "oldest")!,
          status: "approved",
          decisionNote: "Month to month only",
        } as Approval));
      // The same row is now the normal decided row.
      expect(rows()[0]).toBe(row);
      expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(true);
      expect(rows()[0].hasAttribute("data-approval-held-row")).toBe(false);
      expect(rows()[0].textContent).toContain("approved");
      expect(rows()[0].textContent).toContain("Your note. Month to month only");
      expect(rows()[0].querySelector("a")?.getAttribute("href")).toBe("/approvals/oldest");
      expect(announced()).toBe("Approved: Request oldest");

      await advance(APPROVE_HOLD_MS * 3);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
    });

    it("takes an approval back with Undo: nothing is sent, and the card returns open, in focus, with its note", async () => {
      approveAtOnce();
      await render();

      await addNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));
      expect(openIds()).toEqual(["email"]);
      expect(progress()).toBe("1 decided this visit · 2 left to decide");

      await advance(APPROVE_HOLD_MS - 1);
      await click(undoButton(rows()[0])!);

      expect(heldRows()).toHaveLength(0);
      expect(openIds()).toEqual(["oldest"]);
      expect(document.activeElement).toBe(rows()[0]);
      expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
      expect(button(rows()[0], "Remove note").getAttribute("aria-expanded")).toBe("true");
      expect(button(rows()[0], "Approve").disabled).toBe(false);
      expect(announced()).toBe("Not approved: Request oldest. Nothing was sent.");
      expect(progress()).toBeNull();
      expect(order()).toEqual(["oldest", "email", "newest"]);

      await advance(APPROVE_HOLD_MS * 3);
      expect(apiMocks.approve).not.toHaveBeenCalled();

      // Approving again sends the note that came back with the card.
      await click(button(rows()[0], "Approve"));
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", KEEPALIVE);
    });

    it("hands a note back only until it is edited, so a removed note does not return", async () => {
      approveAtOnce();
      await render();

      await addNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));
      await click(undoButton(rows()[0])!);
      await click(button(rows()[0], "Remove note"));
      expect(rows()[0].querySelector("textarea")).toBeNull();

      // Closing and opening the card draws its controls again.
      await click(header(rows()[0])!);
      await click(header(rows()[0])!);
      expect(rows()[0].querySelector("textarea")).toBeNull();
      await click(button(rows()[0], "Approve"));
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, KEEPALIVE);
    });

    it("sends a held approval at once when the page is left", async () => {
      holdOpen();
      await render();

      await click(button(rows()[0], "Approve"));
      await advance(1000);
      expect(apiMocks.approve).not.toHaveBeenCalled();

      act(() => root.unmount());
      root = createRoot(container);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, KEEPALIVE);

      await advance(APPROVE_HOLD_MS * 3);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
    });

    it("sends held approvals at once when the document is hidden or the page is hidden for good", async () => {
      holdOpen();
      await render();
      const setVisibility = (state: DocumentVisibilityState) =>
        act(async () => {
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
          document.dispatchEvent(new Event("visibilitychange"));
        });

      try {
        await click(button(rows()[0], "Approve"));
        await setVisibility("visible");
        expect(apiMocks.approve).not.toHaveBeenCalled();

        await setVisibility("hidden");
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(apiMocks.approve).toHaveBeenLastCalledWith("oldest", undefined, KEEPALIVE);
        expect(rows()[0].dataset.approvalHeldRow).toBe("sending");
        expect(undoButton(rows()[0])).toBeNull();

        await setVisibility("visible");
        await advance(APPROVE_AFTER_ADVANCE_MS);
        await click(button(rows()[1], "Approve"));
        await act(async () => {
          window.dispatchEvent(new Event("pagehide"));
        });
        expect(apiMocks.approve).toHaveBeenCalledTimes(2);
        expect(apiMocks.approve).toHaveBeenLastCalledWith("email", undefined, KEEPALIVE);

        // Neither is sent again when its time would have been up, or on a second pagehide.
        await act(async () => {
          window.dispatchEvent(new Event("pagehide"));
        });
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve).toHaveBeenCalledTimes(2);
      } finally {
        delete (document as unknown as { visibilityState?: string }).visibilityState;
      }
    });

    it("sends held approvals at once when the reader changes tab", async () => {
      holdOpen();
      await render();

      await click(button(rows()[0], "Approve"));
      await advance(APPROVE_AFTER_ADVANCE_MS);
      await click(button(rows()[1], "Approve"));
      expect(apiMocks.approve).not.toHaveBeenCalled();

      routerMock.location.pathname = "/approvals/all";
      await rerender();
      expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest", "email"]);
      // Under All decisions both are shown on their way, with nothing to undo.
      expect(heldRows().map((row) => [row.dataset.approvalCard, row.dataset.approvalHeldRow])).toEqual([
        ["email", "sending"],
        ["oldest", "sending"],
      ]);

      await advance(APPROVE_HOLD_MS * 3);
      expect(apiMocks.approve).toHaveBeenCalledTimes(2);
    });

    it("shows a failed approval on its own row and leaves the reader at the request they moved on to", async () => {
      apiMocks.approve.mockRejectedValue(new Error("Session expired"));
      await render();

      await addNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);

      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(heldRows()).toHaveLength(0);
      // The reader is at the next request by now: it stays open and keeps focus, so the next
      // Shift+X or Shift+C still acts on the request they are reading.
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);
      // The failed request is a closed row again, with its error and a word about its note.
      expect(alerts(rows()[0])).toHaveLength(1);
      expect(alerts()[0].textContent).toBe("Error while approving: Session expired");
      expect(alerts()).toHaveLength(1);
      expect(rows()[0].querySelector("[data-approval-unsent-note]")!.textContent).toBe("Note not sent");
      expect(announced()).toBe("Error while approving Request oldest: Session expired");
      expect(progress()).toBeNull();
      // That row may be out of view, so the failure is also raised where the reader is.
      expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
      expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
        title: "Error while approving Request oldest: Session expired",
        tone: "error",
        action: { label: "View request", href: "/approvals/oldest" },
      });

      // The reader turns to it: the note is back, and a retry is held again and sends the same note.
      await click(header(rows()[0])!);
      expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
      expect(button(rows()[0], "Approve").disabled).toBe(false);
      await click(button(rows()[0], "Approve"));
      expect(alerts()).toHaveLength(0);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(2);
      expect(apiMocks.approve).toHaveBeenLastCalledWith("oldest", "Month to month only", KEEPALIVE);
    });

    it("does not close the request being read when an approval fails and focus rests on the page", async () => {
      apiMocks.approve.mockRejectedValue(new Error("Session expired"));
      await render();

      await click(button(rows()[0], "Approve"));
      expect(openIds()).toEqual(["email"]);
      // A mouse reader: nothing on the page holds focus.
      await act(async () => (document.activeElement as HTMLElement | null)?.blur());
      expect(document.activeElement).toBe(document.body);

      await advance(APPROVE_HOLD_MS);
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(document.body);
      expect(alerts(rows()[0])).toHaveLength(1);
      expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
    });

    it("brings a failed approval back open and in focus when the reader is at no other request", async () => {
      approvals = approvals.filter((approval) => approval.id === "oldest" || approval.id === "done");
      apiMocks.approve.mockRejectedValue(new Error("Session expired"));
      await render();

      await addNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));
      // Nothing was left to move on to: focus rests on the held row.
      expect(openIds()).toEqual([]);
      expect(document.activeElement).toBe(rows()[0]);
      // Focus on the row, not on Undo, lets the hold run out.
      await advance(APPROVE_HOLD_MS);

      expect(heldRows()).toHaveLength(0);
      expect(openIds()).toEqual(["oldest"]);
      expect(document.activeElement).toBe(rows()[0]);
      expect(alerts(rows()[0])).toHaveLength(1);
      expect(alerts()[0].textContent).toBe("Error while approving: Session expired");
      expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
      expect(button(rows()[0], "Approve").disabled).toBe(false);
      expect(toastMock.pushToast).not.toHaveBeenCalled();
    });

    it("does not interrupt a note being typed when an approval fails: the error waits on its row", async () => {
      apiMocks.approve.mockRejectedValue(new Error("Session expired"));
      await render();

      await addNote(rows()[0], "Month to month only");
      await click(button(rows()[0], "Approve"));
      await addNote(rows()[1], "Reply by Friday");
      const field = rows()[1].querySelector("textarea")!;
      expect(document.activeElement).toBe(field);

      await advance(APPROVE_HOLD_MS);
      expect(alerts(rows()[0])).toHaveLength(1);
      expect(alerts(rows()[0])[0].textContent).toBe("Error while approving: Session expired");
      expect(openIds()).toEqual(["email"]);
      expect(rows()[1].querySelector("textarea")).toBe(field);
      expect(field.value).toBe("Reply by Friday");
      expect(document.activeElement).toBe(field);

      // The failed request's note is there when the reader turns to it.
      await click(header(rows()[0])!);
      expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
    });

    it("reports a held approval that fails after the reader has left the page", async () => {
      const sent = holdOpen();
      await render();

      await click(button(rows()[0], "Approve"));
      act(() => root.unmount());
      root = createRoot(container);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);

      await act(async () => sent.get("oldest")!.reject(new Error("Session expired")));
      expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
      expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
        title: "Error while approving Request oldest: Session expired",
        tone: "error",
        action: { label: "View request", href: "/approvals/oldest" },
      });
    });

    it("runs several holds at once, and sends each one once at its own time", async () => {
      approveAtOnce();
      await render();

      await click(button(rows()[0], "Approve"));
      await advance(2000);
      await click(button(rows()[1], "Approve"));
      expect(heldRows()).toHaveLength(2);
      expect(holdStatus(rows()[0])).toBe("Approving in 3s");
      expect(holdStatus(rows()[1])).toBe("Approving in 5s");
      // Both count as decided, and the reader is on the third request.
      expect(progress()).toBe("2 decided this visit · 1 left to decide");
      expect(openIds()).toEqual(["newest"]);
      expect(document.activeElement).toBe(rows()[2]);

      await advance(3000);
      expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest"]);
      expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(true);
      expect(holdStatus(rows()[1])).toBe("Approving in 2s");

      await advance(2000);
      expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest", "email"]);
      expect(rows()[1].hasAttribute("data-approval-decided-row")).toBe(true);
      expect(progress()).toBe("2 decided this visit · 1 left to decide");

      await advance(APPROVE_HOLD_MS * 3);
      expect(apiMocks.approve).toHaveBeenCalledTimes(2);
    });

    it("undoes the most recent hold with Shift+Z, outside text fields and not on a held key", async () => {
      approveAtOnce();
      await render();
      expect(container.textContent).toContain("Shift+Z undo approve");

      await click(button(rows()[0], "Approve"));
      await advance(APPROVE_AFTER_ADVANCE_MS);
      await click(button(rows()[1], "Approve"));
      expect(heldRows()).toHaveLength(2);
      expect(document.activeElement).toBe(rows()[2]);

      // Not from a text field, not with another modifier, and not while the key is held down.
      await click(button(rows()[2], "Add a note"));
      await press("Z", rows()[2].querySelector("textarea")!, { shiftKey: true });
      await press("Z", document, { shiftKey: true, ctrlKey: true });
      await press("Z", document, { shiftKey: true, metaKey: true });
      await press("Z", document, { shiftKey: true, repeat: true });
      await press("z", document);
      expect(heldRows()).toHaveLength(2);

      await press("Z", document, { shiftKey: true });
      expect(heldRows().map((row) => row.dataset.approvalCard)).toEqual(["oldest"]);
      expect(openIds()).toEqual(["email"]);
      expect(document.activeElement).toBe(rows()[1]);
      expect(button(rows()[1], "Approve")).toBeDefined();

      await press("Z", document, { shiftKey: true });
      expect(heldRows()).toHaveLength(0);
      expect(openIds()).toEqual(["oldest"]);
      expect(document.activeElement).toBe(rows()[0]);

      // With nothing held the key is left alone.
      const idle = new KeyboardEvent("keydown", { key: "Z", shiftKey: true, bubbles: true, cancelable: true });
      await act(async () => {
        document.dispatchEvent(idle);
      });
      expect(idle.defaultPrevented).toBe(false);

      await advance(APPROVE_HOLD_MS * 3);
      expect(apiMocks.approve).not.toHaveBeenCalled();
    });

    it("leaves Shift+Z alone when shortcuts are disabled; the Undo button still works", async () => {
      generalSettingsMock.keyboardShortcutsEnabled = false;
      approveAtOnce();
      await render();
      expect(container.textContent).not.toContain("Shift+Z");

      await click(button(rows()[0], "Approve"));
      await press("Z", document, { shiftKey: true });
      expect(heldRows()).toHaveLength(1);

      await click(undoButton(rows()[0])!);
      expect(heldRows()).toHaveLength(0);
      await advance(APPROVE_HOLD_MS * 3);
      expect(apiMocks.approve).not.toHaveBeenCalled();
    });

    it("cannot undo once the request has been sent", async () => {
      holdOpen();
      await render();

      await click(button(rows()[0], "Approve"));
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);

      await press("Z", document, { shiftKey: true });
      expect(rows()[0].dataset.approvalHeldRow).toBe("sending");
      expect(undoButton(rows()[0])).toBeNull();
      expect(button(rows()[0], "Approve")).toBeUndefined();
    });

    it("keeps focus on the row when the Undo button it rested on goes away", async () => {
      const sent = holdOpen();
      await render();

      await click(button(rows()[0], "Approve"));
      await act(async () => undoButton(rows()[0])!.focus());
      expect(document.activeElement).toBe(undoButton(rows()[0]));

      // Focus on Undo keeps the hold from running out; the page being hidden still sends it.
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).not.toHaveBeenCalled();
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(undoButton(rows()[0])).toBeNull();
      expect(document.activeElement).toBe(rows()[0]);

      await act(async () =>
        sent.get("oldest")!.resolve({ ...approvals.find((a) => a.id === "oldest")!, status: "approved" } as Approval));
      expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(true);
      expect(document.activeElement).toBe(rows()[0]);
    });

    it("keeps an approval that is on its way in its place when a reload already shows it approved", async () => {
      const sent = holdOpen();
      await render();

      await click(button(rows()[0], "Approve"));
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);

      // The server has stored the approval; the list reloads before the request has answered.
      const stored = { ...approvals.find((a) => a.id === "oldest")!, status: "approved" } as Approval;
      approvals = approvals.map((approval) => (approval.id === "oldest" ? stored : approval));
      const listCalls = apiMocks.list.mock.calls.length;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approvals", "company-1"] });
      });
      expect(apiMocks.list.mock.calls.length).toBeGreaterThan(listCalls);
      // The reloaded list is on the page: the tab counts one request fewer.
      await vi.waitFor(() => expect(container.querySelector("[data-tab='pending']")!.textContent).toBe("To decide2"));
      expect(order()).toEqual(["oldest", "email", "newest"]);
      expect(rows()[0].dataset.approvalHeldRow).toBe("sending");

      await act(async () => sent.get("oldest")!.resolve(stored));
      expect(order()).toEqual(["oldest", "email", "newest"]);
      expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(true);
    });

    it("lets J and K rest on a held row without opening anything", async () => {
      approveAtOnce();
      await render();

      await click(button(rows()[0], "Approve"));
      expect(document.activeElement).toBe(rows()[1]);
      await press("k");
      expect(document.activeElement).toBe(rows()[0]);
      expect(rows()[0].hasAttribute("data-approval-held-row")).toBe(true);
      expect(openIds()).toEqual([]);
      // Shift+A on the held row starts nothing new.
      await press("A", rows()[0], { shiftKey: true });
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
    });

    it("keeps every request on the page when an undone card returns to a full page", async () => {
      approveAtOnce();
      approvals = Array.from({ length: 23 }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        return createApproval(`r${number}`, `2026-09-${number}T00:00:00.000Z`);
      });
      await render("Request r01");
      expect(order().at(-1)).toBe("r20");

      await click(button(rows()[0], "Approve"));
      expect(order().at(-1)).toBe("r21");
      await click(undoButton(rows()[0])!);
      // r21 came in when r01 was held; it does not leave again.
      expect(order().at(-1)).toBe("r21");
      expect(rows()).toHaveLength(21);
      expect(document.activeElement).toBe(rows()[0]);
    });
  });

  describe("what the reader is doing is not changed under them", () => {
    const LATER = new Date("2026-10-06T09:00:00.000Z");
    const LATER_STILL = new Date("2026-10-06T10:00:00.000Z");
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const press = (key: string, target: EventTarget = document, init: KeyboardEventInit = {}) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
      });
    const typeText = (card: HTMLElement, value: string) =>
      act(async () => {
        const field = card.querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const row = (id: string) => rows().find((candidate) => candidate.dataset.approvalCard === id)!;
    const field = (id: string) => row(id).querySelector("textarea");
    const unsentNote = (id: string) => row(id).querySelector("[data-approval-unsent-note]")?.textContent ?? null;
    const undoButton = (scope: HTMLElement) => scope.querySelector<HTMLButtonElement>("[data-approval-undo]");
    const holdStatus = (scope: HTMLElement) => scope.querySelector("[data-approval-hold-status]")?.textContent ?? null;
    // Every line that reports an error. On this page a card's own error line is not an alert: the
    // page's live region announces each outcome once (see "announces a failure once" below).
    const alerts = (scope: ParentNode = container) => [
      ...scope.querySelectorAll("[role='alert'], [data-approval-decision-error], [data-approval-row-error]"),
    ];
    const announced = () => container.querySelector("[data-approval-announcements]")!.textContent;
    const progress = () => container.querySelector("[data-approval-progress]")?.textContent ?? null;
    const approveButtons = () => [...container.querySelectorAll("button")].filter((b) => b.textContent === "Approve");
    const rerender = () =>
      act(async () => {
        root.render(<QueryClientProvider client={queryClient}><Approvals /></QueryClientProvider>);
      });
    /** Changes one request as another board member, another tab or its requester would, without reloading. */
    const changeElsewhere = (id: string, overrides: Partial<Approval>) => {
      approvals = approvals.map((approval) => (approval.id === id ? { ...approval, ...overrides } : approval));
    };
    /** Reloads the list, as a live update or a return to the browser tab does. */
    const reload = () =>
      act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approvals", "company-1"] });
      });
    /** Approves on the server at once, as the real route does. */
    const approveAtOnce = () =>
      apiMocks.approve.mockImplementation(async (id: string, note?: string) => {
        const decided = {
          ...approvals.find((approval) => approval.id === id)!,
          status: "approved",
          decisionNote: note ?? null,
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
    /** Records every scrollIntoView as [row id, block] until `restore` is called. */
    const recordScrolls = () => {
      const scrolls: Array<[string | undefined, ScrollLogicalPosition | undefined]> = [];
      const prototype = HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
      const original = prototype.scrollIntoView;
      prototype.scrollIntoView = function (this: HTMLElement, options?: ScrollIntoViewOptions) {
        scrolls.push([
          this.dataset.approvalCard ?? (this.hasAttribute("aria-busy") ? "decision controls" : undefined),
          options?.block,
        ]);
      };
      return { scrolls, restore: () => { prototype.scrollIntoView = original; } };
    };
    /** The pointer comes to rest on an element, or leaves it for somewhere outside the page. */
    const pointer = (type: "pointerover" | "pointerout", target: HTMLElement) =>
      act(async () => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: null }));
      });

    beforeEach(() => {
      // The clock moves only when a test moves it.
      vi.useRealTimers();
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    describe("a double click on Approve", () => {
      it("does not approve the request that opens in its place, and works again a moment later", async () => {
        approveAtOnce();
        await render();

        await click(button(row("oldest"), "Approve"));
        expect(openIds()).toEqual(["email"]);
        // The second click of a double click lands on the Approve button of the card that just opened.
        await click(button(row("email"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
        // Nothing was started: the card is not busy and its button still works.
        expect(button(row("email"), "Approve").disabled).toBe(false);
        expect(row("email").textContent).not.toContain("Approving...");

        // Shift+A is the same press by another route.
        await press("A", row("email"), { shiftKey: true });
        expect(heldRows()).toHaveLength(1);

        await advance(APPROVE_AFTER_ADVANCE_MS - 1);
        await click(button(row("email"), "Approve"));
        expect(heldRows()).toHaveLength(1);

        await advance(1);
        await click(button(row("email"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest", "email"]);

        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest", "email"]);
      });

      it("guards the card that opens after a rejection or a change request too", async () => {
        apiMocks.reject.mockImplementation(async (id: string) => {
          const decided = { ...approvals.find((approval) => approval.id === id)!, status: "rejected" } as Approval;
          approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
          return decided;
        });
        await render();

        await click(button(row("oldest"), "Reject"));
        await click(button(row("oldest"), "Reject request"));
        await vi.waitFor(() => expect(openIds()).toEqual(["email"]));
        await click(button(row("email"), "Approve"));
        expect(heldRows()).toHaveLength(0);
      });

      it("leaves a card the reader opened themselves alone", async () => {
        approveAtOnce();
        await render();

        await click(button(row("oldest"), "Approve"));
        // The reader picks another request at once, by its header.
        await click(header(row("newest"))!);
        await click(button(row("newest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest", "newest"]);

        // The page then opens the one request left. The reader leaves it with J and comes back with K:
        // it is their choice now, and its Approve works at once.
        expect(openIds()).toEqual(["email"]);
        await press("j");
        expect(openIds()).toEqual([]);
        await press("k");
        expect(openIds()).toEqual(["email"]);
        await click(button(row("email"), "Approve"));
        expect(heldRows()).toHaveLength(3);
      });
    });

    describe("the card that is open", () => {
      it("stays the open card when a reload puts another request first", async () => {
        await render();
        expect(openIds()).toEqual(["oldest"]);
        // The reader has not clicked a header or pressed J yet: they are typing in the card open on load.
        await click(button(row("oldest"), "Reject"));
        await typeText(row("oldest"), "Too expensive");
        const typing = field("oldest")!;
        expect(document.activeElement).toBe(typing);

        // An older request that was waiting on its requester is resubmitted and sorts first.
        approvals = [createApproval("older", "2026-09-10T00:00:00.000Z"), ...approvals];
        await reload();
        await vi.waitFor(() => expect(order()).toEqual(["older", "oldest", "email", "newest"]));

        expect(openIds()).toEqual(["oldest"]);
        expect(field("oldest")).toBe(typing);
        expect(typing.value).toBe("Too expensive");
        expect(document.activeElement).toBe(typing);
        // The only Approve on the page still belongs to the request the reader was reading.
        expect(approveButtons()).toHaveLength(1);
        expect(row("oldest").contains(approveButtons()[0])).toBe(true);
      });

      it("opens no other request in its place when the open one is decided elsewhere", async () => {
        await render();
        expect(openIds()).toEqual(["oldest"]);

        changeElsewhere("oldest", { status: "approved", decidedAt: LATER, updatedAt: LATER });
        await reload();
        await vi.waitFor(() => expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true));
        expect(openIds()).toEqual([]);
        expect(approveButtons()).toHaveLength(0);
      });

      it("starts again from the first card, oldest first, after a visit to All decisions", async () => {
        await render();
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        routerMock.location.pathname = "/approvals/all";
        await rerender();
        await click(button(container, "Sort: Newest first"));
        await click(button(container, "Sort: Oldest first"));
        expect(button(container, "Sort: Newest first")).toBeDefined();

        routerMock.location.pathname = "/approvals/pending";
        await rerender();
        // The order chosen for the history is not carried into the queue.
        expect(order()).toEqual(["oldest", "email", "newest"]);
        expect(openIds()).toEqual(["oldest"]);
        // What the reader had typed before looking at the history is still there.
        expect(field("oldest")!.value).toBe("Month to month only");
      });

      it("is the first card of the new order after a sort, as after a kind filter", async () => {
        await render();
        await click(header(row("email"))!);
        expect(openIds()).toEqual(["email"]);

        await click(button(container, "Sort: Oldest first"));
        expect(order()).toEqual(["newest", "email", "oldest"]);
        expect(openIds()).toEqual(["newest"]);
      });

      it("comes back as a closed row when its request left the list and returns", async () => {
        await render();
        await click(header(row("email"))!);
        expect(openIds()).toEqual(["email"]);
        const email = approvals.find((approval) => approval.id === "email")!;

        // The list stops holding the request, then holds it again.
        approvals = approvals.filter((approval) => approval.id !== "email");
        await reload();
        await vi.waitFor(() => expect(order()).toEqual(["oldest", "newest"]));
        expect(openIds()).toEqual([]);
        approvals = [...approvals, email];
        await reload();
        await vi.waitFor(() => expect(order()).toEqual(["oldest", "email", "newest"]));
        // It is not shown open, Approve ready, where the reader's pointer may be resting.
        expect(header(row("email"))!.getAttribute("aria-expanded")).toBe("false");
        expect(openIds()).toEqual([]);
      });
    });

    describe("text that was typed and not sent", () => {
      it("keeps a rejection reason, in its own panel, when the card is closed and opened again", async () => {
        await render();
        await click(button(row("oldest"), "Reject"));
        await typeText(row("oldest"), "No. Too expensive.");

        await click(header(row("email"))!);
        expect(field("oldest")).toBeNull();
        // The closed row says that something typed there has not been sent.
        expect(unsentNote("oldest")).toBe("Rejection reason not sent");
        expect(unsentNote("email")).toBeNull();

        await click(header(row("oldest"))!);
        expect(field("oldest")!.value).toBe("No. Too expensive.");
        // It is still a rejection being confirmed, never a note one press away from an approval.
        expect(row("oldest").textContent).toContain("Reject this request?");
        expect(button(row("oldest"), "Approve").disabled).toBe(true);
        expect(unsentNote("oldest")).toBeNull();

        apiMocks.reject.mockImplementation(async (id: string) => (
          { ...approvals.find((approval) => approval.id === id)!, status: "rejected" } as Approval
        ));
        await click(button(row("oldest"), "Reject request"));
        await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest", "No. Too expensive."));
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });

      it("sends the note that was typed before J and K closed and reopened the card", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        await act(async () => button(row("oldest"), "Approve").focus());

        await press("j");
        expect(openIds()).toEqual(["email"]);
        expect(unsentNote("oldest")).toBe("Note not sent");
        await press("k");
        expect(openIds()).toEqual(["oldest"]);
        expect(field("oldest")!.value).toBe("Month to month only");
        expect(button(row("oldest"), "Remove note").getAttribute("aria-expanded")).toBe("true");

        await click(button(row("oldest"), "Approve"));
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", KEEPALIVE);
        // Sent: nothing is left to hand back.
        expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
      });

      it("keeps a change request through a kind filter, a sort, the view switch, Show more and a reload", async () => {
        approvals = [
          ...pendingRequests(22),
          createApproval("mail", "2026-10-01T00:00:00.000Z", {
            payload: { title: "Request mail", recommendedAction: "Send it.", recipient: "buyer@example.test", body: "Draft" },
          }),
        ];
        await render("Request r01");
        await click(button(row("r01"), "Request changes"));
        await typeText(row("r01"), "Quote the delivery date");
        const kept = () => {
          expect(field("r01")!.value).toBe("Quote the delivery date");
          expect(row("r01").textContent).toContain("What should change?");
          expect(button(row("r01"), "Send request").disabled).toBe(false);
        };

        // Another kind: the card leaves the page. Back: its first card is open again, with the text.
        await click(button(container, "Email replies"));
        expect(order()).toEqual(["mail"]);
        await click(button(container, "All"));
        expect(openIds()).toEqual(["r01"]);
        kept();

        // Newest first puts r01 past the end of the page; oldest first brings it back.
        await click(button(container, "Sort: Oldest first"));
        expect(rows().some((candidate) => candidate.dataset.approvalCard === "r01")).toBe(false);
        await click(button(container, "Sort: Newest first"));
        kept();

        await click(button(container, "Full cards"));
        kept();
        await click(button(container, "Compact"));
        kept();

        // Show more opens the first request it brings in, which closes this one.
        await click([...container.querySelectorAll("button")].find((b) => /^Show \d+ more$/.test(b.textContent ?? ""))!);
        expect(openIds()).toEqual(["r21"]);
        expect(unsentNote("r01")).toBe("Change request not sent");
        await reload();
        await click(header(row("r01"))!);
        kept();
      });

      it("forgets the text when the reader cancels it or removes the note", async () => {
        await render();
        await click(button(row("oldest"), "Request changes"));
        await typeText(row("oldest"), "Quote the delivery date");
        await click(button(row("oldest"), "Cancel"));
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        await click(button(row("oldest"), "Remove note"));

        await click(header(row("email"))!);
        expect(unsentNote("oldest")).toBeNull();
        await click(header(row("oldest"))!);
        expect(field("oldest")).toBeNull();
      });

      it("keeps the text of another request when a held approval is undone", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        await click(button(row("oldest"), "Approve"));
        // The reader is on the next request and starts a rejection there.
        await click(button(row("email"), "Reject"));
        await typeText(row("email"), "Wrong recipient");

        // Undo reopens the first card, which closes this one.
        await click(undoButton(row("oldest"))!);
        expect(openIds()).toEqual(["oldest"]);
        // The note that was to go with the approval is back, by the same store.
        expect(field("oldest")!.value).toBe("Month to month only");
        expect(unsentNote("email")).toBe("Rejection reason not sent");

        await click(header(row("email"))!);
        expect(field("email")!.value).toBe("Wrong recipient");
        expect(row("email").textContent).toContain("Reject this request?");
        expect(unsentNote("oldest")).toBe("Note not sent");
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });

      it("has the reason back when a rejection fails after its card was closed", async () => {
        let fail: () => void = () => {};
        apiMocks.reject.mockImplementation(
          () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
        );
        await render();
        await click(button(row("oldest"), "Reject"));
        await typeText(row("oldest"), "Too expensive");
        await click(button(row("oldest"), "Reject request"));
        await click(header(row("email"))!);
        // On its way: the row says that, not that the text is unsent.
        expect(row("oldest").textContent).toContain("Sending your decision...");
        expect(unsentNote("oldest")).toBeNull();

        await act(async () => fail());
        await vi.waitFor(() => expect(alerts(row("oldest"))).toHaveLength(1));
        expect(unsentNote("oldest")).toBe("Rejection reason not sent");
        await click(header(row("oldest"))!);
        expect(field("oldest")!.value).toBe("Too expensive");
        expect(row("oldest").textContent).toContain("Reject this request?");
      });
    });

    describe("a held approval and its Undo", () => {
      it("stay listed under another kind filter, and an undone card stays until the reader moves on", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));

        await click(button(container, "Email replies"));
        // The Board approval is of another kind, but its hold is still running: its row and Undo stay.
        expect(order()).toEqual(["oldest", "email"]);
        expect(holdStatus(row("oldest"))).toBe("Approving in 5s");
        expect(undoButton(row("oldest"))).not.toBeNull();
        expect(apiMocks.approve).not.toHaveBeenCalled();

        await click(undoButton(row("oldest"))!);
        expect(order()).toEqual(["oldest", "email"]);
        expect(openIds()).toEqual(["oldest"]);
        expect(document.activeElement).toBe(row("oldest"));

        // Once the reader opens a request of the kind they filtered for, the other one is filtered out again.
        await click(header(row("email"))!);
        expect(order()).toEqual(["email"]);
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });

      it("keep the failed request on the page under another kind filter, with its error", async () => {
        apiMocks.approve.mockRejectedValue(new Error("Session expired"));
        await render();
        await click(button(row("oldest"), "Approve"));
        await click(button(container, "Email replies"));

        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(order()).toEqual(["oldest", "email"]);
        expect(alerts(row("oldest"))[0].textContent).toBe("Error while approving: Session expired");
      });

      it("stay on the page when a sort puts the request past the end of the page", async () => {
        approveAtOnce();
        approvals = pendingRequests(23);
        await render("Request r01");
        await click(button(row("r01"), "Approve"));

        await click(button(container, "Sort: Oldest first"));
        // Newest first: r23 down to r04 fill the page, and the held r01 is kept after them.
        expect(order()).toEqual([
          ...Array.from({ length: 20 }, (_, index) => `r${String(23 - index).padStart(2, "0")}`),
          "r01",
        ]);
        expect(undoButton(row("r01"))).not.toBeNull();
        expect(openIds()).toEqual(["r23"]);

        // Show more still brings in the requests that were not shown, and opens the first of them.
        const more = [...container.querySelectorAll("button")].find((b) => /^Show \d+ more$/.test(b.textContent ?? ""))!;
        expect(more.textContent).toBe("Show 2 more");
        await click(more);
        expect(rows()).toHaveLength(23);
        expect(openIds()).toEqual(["r03"]);

        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["r01"]);
      });

      it("are brought back to the top when the next request is tall enough to push them out of view", async () => {
        approveAtOnce();
        const { scrolls, restore } = recordScrolls();
        const rect = vi
          .spyOn(HTMLElement.prototype, "getBoundingClientRect")
          .mockImplementation(function (this: HTMLElement) {
            // Showing the tall next card leaves the held row above the area the list scrolls in.
            return { top: this.hasAttribute("data-approval-held-row") ? -9 : 0 } as DOMRect;
          });
        try {
          await render();
          await click(button(row("oldest"), "Approve"));
          expect(scrolls).toEqual([["email", "nearest"], ["oldest", "start"]]);
          // A row scrolled to the top clears the bar a phone keeps there.
          expect(row("oldest").className).toContain("scroll-mt-16");
          expect(row("email").className).toContain("scroll-mt-16");
        } finally {
          rect.mockRestore();
          restore();
        }
      });

      it("do not run out while the pointer rests on the row; the rest of the time runs once it leaves", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await advance(2000);
        expect(holdStatus(row("oldest"))).toBe("Approving in 3s");

        await pointer("pointerover", row("oldest"));
        expect(holdStatus(row("oldest"))).toBe("Paused, 3s left");
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        expect(undoButton(row("oldest"))).not.toBeNull();
        expect(holdStatus(row("oldest"))).toBe("Paused, 3s left");

        await pointer("pointerout", row("oldest"));
        expect(holdStatus(row("oldest"))).toBe("Approving in 3s");
        await advance(2999);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        await advance(1);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);

        // Sent once, whatever the pointer does afterwards.
        await pointer("pointerover", row("oldest"));
        await pointer("pointerout", row("oldest"));
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("do not run out while focus is on Undo, and say so to a screen reader", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await advance(1000);

        const undo = undoButton(row("oldest"))!;
        await act(async () => undo.focus());
        expect(holdStatus(row("oldest"))).toBe("Paused, 4s left");
        expect(document.getElementById(undo.getAttribute("aria-describedby")!)!.textContent).toBe(
          "The approval is not sent while focus is on this button.",
        );
        // The pointer passing over the row and away does not restart a clock that focus still holds.
        await pointer("pointerover", row("oldest"));
        await pointer("pointerout", row("oldest"));
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        await act(async () => undo.blur());
        await advance(3999);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        await advance(1);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, KEEPALIVE);
      });

      it("are never sent after Undo, also when the hold was paused", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await pointer("pointerover", row("oldest"));
        await advance(APPROVE_HOLD_MS * 2);

        await click(undoButton(row("oldest"))!);
        expect(heldRows()).toHaveLength(0);
        expect(openIds()).toEqual(["oldest"]);
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // A new hold on the same request starts with its full time and is not paused.
        await click(button(row("oldest"), "Approve"));
        expect(holdStatus(row("oldest"))).toBe("Approving in 5s");
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("are sent at once, and once, when the page is hidden, the tab changes or the page is left while paused", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await pointer("pointerover", row("oldest"));
        await advance(APPROVE_HOLD_MS * 2);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        await act(async () => {
          window.dispatchEvent(new Event("pagehide"));
        });
        expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest"]);
        await pointer("pointerout", row("oldest"));
        await advance(APPROVE_HOLD_MS * 2);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);

        await click(button(row("email"), "Approve"));
        await pointer("pointerover", row("email"));
        routerMock.location.pathname = "/approvals/all";
        await rerender();
        expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest", "email"]);

        routerMock.location.pathname = "/approvals/pending";
        await rerender();
        await advance(APPROVE_AFTER_ADVANCE_MS);
        await click(button(row("newest"), "Approve"));
        await act(async () => undoButton(row("newest"))!.focus());
        act(() => root.unmount());
        root = createRoot(container);
        expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest", "email", "newest"]);
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(3);
      });

      it("open on the card with its error when the approval fails after a change of tab took it past the page", async () => {
        const history = Array.from({ length: 24 }, (_, index) => {
          const number = String(index + 1).padStart(2, "0");
          return createApproval(`h${number}`, `2026-10-${number}T00:00:00.000Z`, { status: "approved" });
        });
        approvals = [createApproval("oldest", "2026-09-20T00:00:00.000Z"), ...history];
        let fail: () => void = () => {};
        apiMocks.approve.mockImplementation(
          () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
        );
        await render();
        await click(button(row("oldest"), "Approve"));

        // All decisions lists newest first: the request sits behind 24 newer ones, past the page of 20.
        routerMock.location.pathname = "/approvals/all";
        await rerender();
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(row("oldest").dataset.approvalHeldRow).toBe("sending");

        await act(async () => fail());
        // The failure is on the page, on the request's own card; it is not dropped.
        expect(alerts(row("oldest"))[0].textContent).toBe("Error while approving: Session expired");
        expect(openIds()).toEqual(["oldest"]);
      });
    });

    describe("a request revised by its requester", () => {
      const revise = (id: string, updatedAt: Date) =>
        changeElsewhere(id, {
          status: "pending",
          decidedAt: null,
          updatedAt,
          payload: {
            title: `Request ${id}`,
            recommendedAction: "Order ten times the standing quantity.",
            reasoning: "New numbers.",
          },
        });
      const notice = (id: string) => row(id).querySelector<HTMLElement>("[data-approval-revised]");
      const REVISED_ROW = "Revised while this page was open";

      it("is still held back, and its confirmation still stands, after its card was taken off the page and drawn again", async () => {
        approveAtOnce();
        await render();
        revise("newest", LATER);
        await reload();
        await vi.waitFor(() => expect(row("newest").textContent).toContain(REVISED_ROW));

        // A round trip through another kind filter draws the card again.
        await click(button(container, "Email replies"));
        expect(order()).toEqual(["email"]);
        await click(button(container, "All"));
        expect(row("newest").textContent).toContain(REVISED_ROW);
        await click(header(row("newest"))!);
        expect(notice("newest")!.dataset.approvalRevised).toBe("unreviewed");
        await click(button(row("newest"), "Approve"));
        expect(heldRows()).toHaveLength(0);

        await click(button(row("newest"), "I have reviewed it"));
        expect(notice("newest")!.dataset.approvalRevised).toBe("reviewed");
        await click(button(container, "Email replies"));
        await click(button(container, "All"));
        await click(header(row("newest"))!);
        // Confirmed once: it is not asked again, and the quiet line still says the request was revised.
        expect(notice("newest")!.dataset.approvalRevised).toBe("reviewed");
        await click(button(row("newest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["newest"]);
      });

      it("is held back when it was sent back elsewhere and resubmitted, each in its own reload", async () => {
        approveAtOnce();
        await render();
        expect(order()).toEqual(["oldest", "email", "newest"]);

        // Another board member sends it back: it leaves the queue for "Waiting on the requester".
        changeElsewhere("newest", { status: "revision_requested", decidedAt: LATER, updatedAt: LATER });
        await reload();
        await vi.waitFor(() => expect(order()).toEqual(["oldest", "email"]));

        // The requester resubmits it with another recommendation.
        revise("newest", LATER_STILL);
        await reload();
        await vi.waitFor(() => expect(order()).toEqual(["oldest", "email", "newest"]));
        // It is not the version this reader saw: the row says so, and Approve waits for the confirmation.
        expect(header(row("newest"))!.getAttribute("aria-expanded")).toBe("false");
        expect(row("newest").textContent).toContain(REVISED_ROW);
        await click(header(row("newest"))!);
        expect(row("newest").textContent).toContain("Order ten times the standing quantity.");
        expect(notice("newest")!.dataset.approvalRevised).toBe("unreviewed");
        await click(button(row("newest"), "Approve"));
        await press("A", row("newest"), { shiftKey: true });
        expect(heldRows()).toHaveLength(0);

        await click(button(row("newest"), "I have reviewed it"));
        await click(button(row("newest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["newest"]);
      });

      it("returns closed and held back when it was the open card as it was sent back", async () => {
        await render();
        await press("j");
        await press("j");
        expect(openIds()).toEqual(["email"]);
        const firstPayload = approvals.find((approval) => approval.id === "email")!.payload as Record<string, unknown>;

        changeElsewhere("email", { status: "revision_requested", decidedAt: LATER, updatedAt: LATER });
        await reload();
        await vi.waitFor(() => expect(row("email").hasAttribute("data-approval-decided-row")).toBe(true));

        changeElsewhere("email", {
          status: "pending",
          decidedAt: null,
          updatedAt: LATER_STILL,
          payload: { ...firstPayload, recipient: "someone-else@example.test", body: "Another draft" },
        });
        await reload();
        await vi.waitFor(() => expect(header(row("email"))).not.toBeNull());
        // Not open under the pointer with the new text: a closed row that has to be opened and read.
        expect(header(row("email"))!.getAttribute("aria-expanded")).toBe("false");
        expect(openIds()).toEqual([]);
        expect(row("email").textContent).toContain(REVISED_ROW);
        await click(header(row("email"))!);
        expect(notice("email")!.dataset.approvalRevised).toBe("unreviewed");
        await click(button(row("email"), "Approve"));
        expect(heldRows()).toHaveLength(0);
      });

      it("raises nothing for a request the board itself sent back from this page", async () => {
        apiMocks.requestRevision.mockImplementation(async (id: string, note: string) => {
          const decided = {
            ...approvals.find((approval) => approval.id === id)!,
            status: "revision_requested",
            decisionNote: note,
            decidedAt: LATER,
            updatedAt: LATER,
          } as Approval;
          approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
          return decided;
        });
        await render();
        await click(button(row("oldest"), "Request changes"));
        await typeText(row("oldest"), "Shorter please");
        await click(button(row("oldest"), "Send request"));
        await vi.waitFor(() => expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true));

        revise("oldest", LATER_STILL);
        await reload();
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());
        // The board asked for this revision: the card returns closed, to be opened and read, with no notice.
        expect(row("oldest").textContent).not.toContain(REVISED_ROW);
        await click(header(row("oldest"))!);
        expect(notice("oldest")).toBeNull();
        expect(field("oldest")).toBeNull();
      });
    });

    describe("a request decided somewhere else", () => {
      it("keeps its place as a compact row with its new status, says so once, and keeps focus and J in place", async () => {
        await render();
        await press("j");
        await press("j");
        expect(openIds()).toEqual(["email"]);
        expect(document.activeElement).toBe(row("email"));

        changeElsewhere("email", { status: "approved", decidedAt: LATER, updatedAt: LATER, decisionNote: "Fine by me" });
        await reload();
        await vi.waitFor(() => expect(row("email").hasAttribute("data-approval-decided-row")).toBe(true));

        expect(order()).toEqual(["oldest", "email", "newest"]);
        expect(row("email").textContent).toContain("approved");
        expect(row("email").textContent).toContain("Decided elsewhere");
        // The note is another person's, so it is not called the reader's.
        expect(row("email").textContent).toContain("Decision note. Fine by me");
        expect(row("email").textContent).not.toContain("Your note.");
        expect(row("email").querySelectorAll("button")).toHaveLength(0);
        // Focus did not fall to the page, and no other request opened in its place.
        expect(document.activeElement).toBe(row("email"));
        expect(openIds()).toEqual([]);
        expect(announced()).toBe("Approved: Request email. Decided elsewhere.");
        // It was not the reader's decision.
        expect(progress()).toBeNull();
        expect(container.querySelector("[data-tab='pending']")!.textContent).toBe("To decide2");

        // A later reload changes nothing and says nothing more.
        await click(header(row("oldest"))!);
        await click(header(row("oldest"))!);
        await reload();
        expect(announced()).toBe("Approved: Request email. Decided elsewhere.");
        expect(order()).toEqual(["oldest", "email", "newest"]);

        // J carries on from that row, not from the top of the queue.
        await act(async () => row("email").focus());
        await press("j");
        expect(document.activeElement).toBe(row("newest"));
        expect(openIds()).toEqual(["newest"]);
      });

      it("stays in place when it was only the row that last held focus", async () => {
        await render();
        await press("j");
        await press("j");
        await press("j");
        expect(openIds()).toEqual(["newest"]);
        // The reader opens another request with the mouse; focus was last in "newest".
        await act(async () => (document.activeElement as HTMLElement | null)?.blur());

        changeElsewhere("newest", { status: "cancelled", updatedAt: LATER });
        await reload();
        await vi.waitFor(() => expect(row("newest").hasAttribute("data-approval-decided-row")).toBe(true));
        expect(announced()).toBe("Cancelled: Request newest. Decided elsewhere.");
        expect(document.activeElement).toBe(row("newest"));
      });

      it("does not keep a request the reader was not at", async () => {
        await render();
        changeElsewhere("newest", { status: "approved", decidedAt: LATER, updatedAt: LATER });
        await reload();
        await vi.waitFor(() => expect(order()).toEqual(["oldest", "email"]));
        expect(announced()).toBe("");
      });

      it("does not call the reader's own decision one made elsewhere", async () => {
        let land: () => void = () => {};
        apiMocks.reject.mockImplementation(
          (id: string) =>
            new Promise<Approval>((resolve) => {
              land = () => resolve({ ...approvals.find((approval) => approval.id === id)!, status: "rejected" } as Approval);
            }),
        );
        await render();
        await click(button(row("oldest"), "Reject"));
        await click(button(row("oldest"), "Reject request"));

        // The server has stored the rejection; a live update reloads the list before the request answers.
        changeElsewhere("oldest", { status: "rejected", decidedAt: LATER, updatedAt: LATER });
        await reload();
        await vi.waitFor(() => expect(container.querySelector("[data-tab='pending']")!.textContent).toBe("To decide2"));
        // The card keeps its place while its decision is on its way.
        expect(order()).toEqual(["oldest", "email", "newest"]);
        expect(announced()).toBe("");

        await act(async () => land());
        await vi.waitFor(() => expect(announced()).toBe("Rejected: Request oldest"));
        expect(row("oldest").textContent).not.toContain("Decided elsewhere");
        expect(progress()).toBe("1 decided this visit · 2 left to decide");
      });

      it("shows the real status of a request sent back on this visit and then decided elsewhere", async () => {
        apiMocks.requestRevision.mockImplementation(async (id: string, note: string) => {
          const decided = {
            ...approvals.find((approval) => approval.id === id)!,
            status: "revision_requested",
            decisionNote: note,
            decidedAt: LATER,
            updatedAt: LATER,
          } as Approval;
          approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
          return decided;
        });
        await render();
        await click(button(row("oldest"), "Request changes"));
        await typeText(row("oldest"), "Shorter please");
        await click(button(row("oldest"), "Send request"));
        await vi.waitFor(() => expect(row("oldest").textContent).toContain("Your note. Shorter please"));
        expect(row("oldest").textContent).toContain("revision requested");

        changeElsewhere("oldest", {
          status: "rejected",
          decisionNote: "No longer needed",
          decidedAt: LATER_STILL,
          updatedAt: LATER_STILL,
        });
        await reload();
        await vi.waitFor(() => expect(row("oldest").textContent).toContain("rejected"));
        expect(row("oldest").textContent).not.toContain("revision requested");
        expect(row("oldest").textContent).toContain("Decision note. No longer needed");
        expect(row("oldest").textContent).not.toContain("Your note.");
        expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
      });
    });

    it("brings the decision controls into view when a panel opens on a card at the bottom of the screen", async () => {
      const { scrolls, restore } = recordScrolls();
      try {
        await render();
        await click(button(row("oldest"), "Request changes"));
        expect(scrolls).toEqual([["decision controls", "nearest"]]);
        await click(button(row("oldest"), "Cancel"));
        await click(button(row("oldest"), "Add a note"));
        expect(scrolls).toEqual([["decision controls", "nearest"], ["decision controls", "nearest"]]);
      } finally {
        restore();
      }
    });

    it("does not move the queue or undo anything behind an open dialog", async () => {
      approveAtOnce();
      await render();
      await click(button(row("oldest"), "Approve"));
      expect(openIds()).toEqual(["email"]);

      // The shortcuts cheatsheet: a dialog that is open but not marked modal.
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("data-state", "open");
      const inside = document.createElement("button");
      dialog.appendChild(inside);
      document.body.appendChild(dialog);
      try {
        await press("j", inside);
        await press("k", inside);
        await press("j");
        expect(openIds()).toEqual(["email"]);
        await press("Z", inside, { shiftKey: true });
        await press("Z", document, { shiftKey: true });
        expect(heldRows()).toHaveLength(1);
      } finally {
        dialog.remove();
      }

      await press("j");
      expect(openIds()).toEqual(["newest"]);
      await press("Z", document, { shiftKey: true });
      expect(heldRows()).toHaveLength(0);
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
    expect(container.querySelectorAll("[data-approval-held-row]")).toHaveLength(0);
    expect(apiMocks.approve).not.toHaveBeenCalled();

    // The page still keeps the reader's place after a decision: the next card opens and takes focus,
    // and the compact row left behind can take focus too.
    apiMocks.approve.mockImplementation(async (id: string) => (
      { ...approvals.find((approval) => approval.id === id)!, status: "approved" } as Approval
    ));
    await click(button(rows()[0], "Approve"));
    await endHold();
    await vi.waitFor(() => expect(rows()[0].textContent).toContain("approved"));
    expect(rows()[0].tabIndex).toBe(-1);
    expect(openIds()).toEqual(["email"]);
    expect(document.activeElement).toBe(rows()[1]);
  });
});
