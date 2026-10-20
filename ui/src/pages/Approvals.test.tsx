// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({
  location: { pathname: "/approvals/pending", search: "", hash: "" },
  navigate: vi.fn(),
  /** Pages that read the query string; told when it changes, as the router tells them. */
  searchListeners: new Set<() => void>(),
  /** The options the page passed with each change of the query string. */
  searchChanges: [] as unknown[],
}));

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  listIssues: vi.fn(),
  listLinkedIssues: vi.fn(),
  agentsList: vi.fn(),
}));

const companyMock = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const toastMock = vi.hoisted(() => ({ pushToast: vi.fn() }));

vi.mock("../api/approvals", () => ({ approvalsApi: apiMocks }));
vi.mock("../api/agents", () => ({ agentsApi: { list: apiMocks.agentsList } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyMock,
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
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
vi.mock("@/lib/router", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    routerMock.searchListeners.add(listener);
    return () => {
      routerMock.searchListeners.delete(listener);
    };
  };
  return {
    // What a link carries to the page it opens is kept readable.
    Link: ({ children, to, state, ...props }: ComponentProps<"a"> & { to: string; state?: unknown }) => (
      <a href={to} data-link-state={state === undefined ? undefined : JSON.stringify(state)} {...props}>{children}</a>
    ),
    useLocation: () => routerMock.location,
    useNavigate: () => routerMock.navigate,
    // As the router's own: the query is replaced, the #target is dropped, and the page is drawn again.
    useSearchParams: () => {
      const search = useSyncExternalStore(subscribe, () => routerMock.location.search);
      const setSearchParams = (next: (current: URLSearchParams) => URLSearchParams, options?: unknown) => {
        const query = next(new URLSearchParams(routerMock.location.search)).toString();
        routerMock.searchChanges.push(options);
        routerMock.location.search = query ? `?${query}` : "";
        routerMock.location.hash = "";
        for (const listener of [...routerMock.searchListeners]) listener();
      };
      return [new URLSearchParams(search), setSearchParams] as const;
    },
  };
});

import {
  APPROVE_AFTER_ADVANCE_MS,
  APPROVE_AFTER_PAUSE_LIMIT_MS,
  APPROVE_HOLD_MS,
  APPROVE_PAUSE_LIMIT_MS,
} from "../components/ApprovalHold";
import { queryKeys } from "../lib/queryKeys";
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

/**
 * "View details" is 16px tall. On a touch screen its tap area is 44px tall (16 + 2 x 14) and no
 * wider than the link. jsdom cannot evaluate the media query, so the classes are checked.
 */
function expectTouchArea(link: HTMLElement) {
  for (const name of [
    "relative",
    "pointer-coarse:after:absolute",
    "pointer-coarse:after:inset-x-0",
    "pointer-coarse:after:-inset-y-3.5",
  ]) {
    expect(link.classList.contains(name), name).toBe(true);
  }
  // The link itself is no taller, so no row grows.
  expect(link.classList.contains("h-auto")).toBe(true);
  expect(link.className).not.toMatch(/min-h-|(^|[\s:])py-/);
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
    routerMock.location.search = "";
    routerMock.location.hash = "";
    routerMock.searchChanges.length = 0;
    window.localStorage.clear();
    companyMock.selectedCompanyId = "company-1";
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
    apiMocks.listLinkedIssues.mockImplementation(async () => ({
      oldest: [{ id: "issue-1", identifier: "DEMO-7", title: "Linked task", status: "in_review" }],
    }));
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
  /** A button's label. A kind chip also shows a count, which is not part of its label. */
  const buttonLabel = (candidate: HTMLButtonElement) =>
    candidate.hasAttribute("data-approval-kind") ? candidate.firstChild?.textContent : candidate.textContent;
  const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].find((candidate) => buttonLabel(candidate) === label)!;
  const click = (element: HTMLElement) => act(async () => element.click());
  /** Lets the undo window that follows Approve run out, so the held approval is sent. */
  const endHold = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_HOLD_MS);
    });
  /**
   * Lets the moment pass in which an Approve on the card the page has just opened by itself, or the
   * reader has just opened by its header, is taken for the second half of a double click and ignored.
   */
  const pastDoubleClick = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_AFTER_ADVANCE_MS);
    });
  /** The `updatedAt` each request of the default list is first shown with: the version a decision on it names. */
  const FIRST_SHOWN: Record<string, Date> = {
    newest: new Date("2026-10-05T00:00:00.000Z"),
    oldest: new Date("2026-09-20T00:00:00.000Z"),
    email: new Date("2026-10-01T00:00:00.000Z"),
  };
  /** What a rejection or a change request is sent with: the version of the request as its card showed it. */
  const versionOf = (id: string, updatedAt: Date = FIRST_SHOWN[id]) => ({ expectedUpdatedAt: updatedAt });
  /** What a held approval is sent with: marked to outlive the page, for the version the hold began with. */
  const heldFor = (id: string, updatedAt: Date = FIRST_SHOWN[id]) => ({ keepalive: true, expectedUpdatedAt: updatedAt });
  /** The compact rows of approvals that are held for undo or on their way. */
  const heldRows = () => [...container.querySelectorAll<HTMLElement>("[data-approval-held-row]")];

  it("lists the longest-waiting request first and lets the board reverse the order", async () => {
    await render();
    expect(order()).toEqual(["oldest", "email", "newest"]);

    await click(button(container, "Sort: Oldest first"));
    expect(order()).toEqual(["newest", "email", "oldest"]);
    expect(button(container, "Sort: Newest first")).toBeDefined();
  });

  it.each(["/approvals", "/PAP/approvals", "/PAP/approvals/"])(
    "shows To decide on the short address %s and corrects the address in place, once",
    async (pathname) => {
      routerMock.location.pathname = pathname;
      routerMock.location.search = "?from=mail";
      routerMock.location.hash = "#approval-email";
      const carried = { paperclipSidebarScrollReset: true };
      (routerMock.location as { state?: unknown }).state = carried;
      try {
        await render();
        // The queue, not All decisions: the decided request is not listed.
        expect(order()).toEqual(["oldest", "email", "newest"]);
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith(
          { pathname: "/approvals/pending", search: "?from=mail", hash: "#approval-email" },
          { replace: true, state: carried },
        );
        // Drawing the page again does not ask for it a second time.
        await click(button(container, "Full cards"));
        expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      } finally {
        routerMock.location.search = "";
        delete (routerMock.location as { state?: unknown }).state;
      }
    },
  );

  it.each(["/approvals/pending", "/PAP/approvals/pending", "/PAP/approvals/all", "/approvals/all"])(
    "leaves the address %s as it is",
    async (pathname) => {
      routerMock.location.pathname = pathname;
      await render();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    },
  );

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
    const chip = rows()[0].querySelector<HTMLAnchorElement>("a[href='/issues/DEMO-7']")!;
    expect(chip.textContent).toBe("DEMO-7");
    expect(chip.getAttribute("title")).toBe("Linked task");
    // A link of its own, at least 24px tall.
    expect(chip.className).toContain("min-h-6");
    expect(rows()[1].querySelector("a[href^='/issues/']")).toBeNull();
  });

  describe("linked tasks are read once for the page, not once per card", () => {
    it("reads the rows on the page in one request", async () => {
      await render();
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("DEMO-7"));

      expect(apiMocks.listLinkedIssues).toHaveBeenCalledTimes(1);
      expect(apiMocks.listLinkedIssues).toHaveBeenCalledWith("company-1", ["email", "newest", "oldest"]);
      expect(apiMocks.listIssues).not.toHaveBeenCalled();
    });

    it("does not read again when the reader returns to the browser tab", async () => {
      await render();
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("DEMO-7"));
      // Long enough for the rows to count as stale.
      const realNow = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(realNow + 10 * 60_000);
      try {
        await act(async () => {
          focusManager.setFocused(false);
          focusManager.setFocused(true);
          await Promise.resolve();
        });
      } finally {
        now.mockRestore();
        focusManager.setFocused(undefined);
      }

      expect(apiMocks.listLinkedIssues).toHaveBeenCalledTimes(1);
    });

    it("does not read again when the same rows are sorted or opened", async () => {
      await render();
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("DEMO-7"));

      await click(button(container, "Sort: Oldest first"));
      await click(header(rows()[1])!);

      expect(order()).toEqual(["newest", "email", "oldest"]);
      expect(rows()[2].textContent).toContain("DEMO-7");
      expect(apiMocks.listLinkedIssues).toHaveBeenCalledTimes(1);
    });

    it("keeps the chips of the rows already shown while a new row is read with them", async () => {
      await render();
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("DEMO-7"));
      let answer!: (value: Record<string, unknown[]>) => void;
      apiMocks.listLinkedIssues.mockImplementation(
        () => new Promise((resolve) => { answer = resolve; }),
      );
      approvals = [...approvals, createApproval("later", "2026-10-06T00:00:00.000Z")];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list("company-1") });
      });
      await vi.waitFor(() => expect(order()).toContain("later"));

      // One more read, for all rows; the chip already shown stays while it is on its way.
      await vi.waitFor(() => expect(apiMocks.listLinkedIssues).toHaveBeenCalledTimes(2));
      expect(apiMocks.listLinkedIssues).toHaveBeenLastCalledWith("company-1", ["email", "later", "newest", "oldest"]);
      expect(rows()[0].textContent).toContain("DEMO-7");

      await act(async () => answer({
        oldest: [{ id: "issue-1", identifier: "DEMO-7", title: "Linked task", status: "in_review" }],
        later: [{ id: "issue-2", identifier: "DEMO-9", title: "Another task", status: "todo" }],
      }));
      const later = rows().find((row) => row.dataset.approvalCard === "later")!;
      await vi.waitFor(() => expect(later.textContent).toContain("DEMO-9"));
      expect(rows()[0].textContent).toContain("DEMO-7");
    });
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
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", heldFor("oldest")));
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
    // The decided row's link to the request is as easy to tap as the open card's.
    const rowLink = rows()[0].querySelector<HTMLAnchorElement>("a")!;
    expect(rowLink.textContent).toBe("View details");
    // Each decided row has one: the name read out says which request it opens.
    expect(rowLink.getAttribute("aria-label")).toMatch(/^View details: \S/);
    expectTouchArea(rowLink);
    const openCardLink = [...rows()[1].querySelectorAll("a")].find((anchor) => anchor.textContent === "View details")!;
    expectTouchArea(openCardLink);
  });

  it("sends a rejection only after it is confirmed", async () => {
    apiMocks.reject.mockImplementation(async (id: string) => (
      { ...approvals.find((approval) => approval.id === id)!, status: "rejected" } as Approval
    ));
    await render();

    await click(button(rows()[0], "Reject"));
    expect(apiMocks.reject).not.toHaveBeenCalled();
    await click(button(rows()[0], "Reject request"));
    await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest", undefined, versionOf("oldest")));
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
      expect(apiMocks.reject).toHaveBeenLastCalledWith("oldest", "Too expensive this quarter", versionOf("oldest"));

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
      // The count is the sidebar's pill, which reads in both themes. It was pale yellow on pale yellow.
      const count = container.querySelector<HTMLElement>("[data-tab='pending'] [data-slot='badge']")!;
      expect(count.textContent).toBe("3");
      expect(count.classList.contains("bg-primary")).toBe(true);
      expect(count.classList.contains("text-primary-foreground")).toBe(true);
      expect(count.classList.contains("text-(length:--text-micro)")).toBe(true);
      expect(count.className).not.toMatch(/yellow|text-\(length:--text-nano\)/);
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
      expectTouchArea(row.querySelector("a")!);
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
      // Sent for the version its card showed, so the server can refuse it for a later one.
      expect(apiMocks.requestRevision).toHaveBeenCalledExactlyOnceWith(
        "oldest",
        "Quote the delivery date.",
        versionOf("oldest"),
      );

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

    it("shows the change request on the card that returns, until the request is decided again", async () => {
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
      apiMocks.reject.mockImplementation(async (id: string) => {
        const decided = {
          ...approvals.find((approval) => approval.id === id)!,
          status: "rejected",
          decidedAt: new Date(Date.now() + 2000),
          updatedAt: new Date(Date.now() + 2000),
        } as Approval;
        approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
        return decided;
      });
      const asked = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-approval-changes-asked]");
      await render();
      // A card nobody sent back shows no such note.
      expect(asked(rows()[0])).toBeNull();

      await click(button(rows()[0], "Request changes"));
      await act(async () => {
        const note = rows()[0].querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          note,
          "1. Quote the delivery date.\n2. Name the carrier.",
        );
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click(button(rows()[0], "Send request"));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("revision requested"));

      // The requester resubmits. An older server deletes the note; the page still holds it.
      approvals = approvals.map((approval) =>
        approval.id === "oldest"
          ? { ...approval, status: "pending", decisionNote: null, decidedAt: null, updatedAt: new Date(Date.now() + 1000) }
          : approval,
      );
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approvals", "company-1"] });
      });
      await vi.waitFor(() => expect(header(rows()[0])).not.toBeNull());
      // Nothing of it on the closed row; the note is read with the request, in the open card.
      expect(asked(rows()[0])).toBeNull();
      await click(header(rows()[0])!);

      const note = asked(rows()[0])!;
      expect(note.textContent).toBe("Changes you asked for1. Quote the delivery date.\n2. Name the carrier.");
      // Plain text with its line breaks, above the summary and the buttons.
      expect(note.querySelector("ol, li, strong, a")).toBeNull();
      const before = (first: Node, second: Node) =>
        Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(before(note, button(rows()[0], "Approve"))).toBe(true);
      // Only that card carries it.
      expect(rows().filter((row) => asked(row))).toHaveLength(1);

      // A new decision ends it: the row shows that decision, not the old change request.
      await pastDoubleClick();
      await click(button(rows()[0], "Reject"));
      await click(button(rows()[0], "Reject request"));
      await vi.waitFor(() => expect(rows()[0].textContent).toContain("rejected"));
      expect(asked(rows()[0])).toBeNull();
      expect(container.textContent).not.toContain("Quote the delivery date.");
    });

    it("shows the change request the server kept on a revised request, also on a later visit", async () => {
      // Sent back and resubmitted before this visit: the page holds no copy, the request carries the note.
      approvals = approvals.map((approval) =>
        approval.id === "oldest" ? { ...approval, decisionNote: "1. Quote the delivery date.\n2. Name the carrier." } : approval,
      );
      const asked = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-approval-changes-asked]");
      await render();

      const note = asked(rows()[0])!;
      expect(note.textContent).toBe("Changes you asked for1. Quote the delivery date.\n2. Name the carrier.");
      // It is the request's change request, not a decision: the card says so once, above the buttons.
      expect(rows()[0].querySelector("[data-approval-decision-note]")).toBeNull();
      expect(note.compareDocumentPosition(button(rows()[0], "Approve")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(rows().filter((row) => asked(row))).toHaveLength(1);
      // The request still needs a decision and is counted as one.
      expect(toDecideTab()).toBe("To decide3");
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
      await pastDoubleClick();
      await press("A", rows()[1], { shiftKey: true });
      await endHold();
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("email", undefined, heldFor("email")));
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
      await pastDoubleClick();
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
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, heldFor("oldest")));
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
      await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest", undefined, versionOf("oldest")));
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
      await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest", undefined, versionOf("oldest")));
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

      // The latest decision leads; the pending requests follow by the time they were created.
      expect(order()).toEqual(["done", "newest", "email", "oldest"]);
      expect(openIds()).toEqual([]);
      expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Approve")).toHaveLength(0);
      // The view choice belongs to the queue; it is not offered here.
      expect(button(container, "Full cards")).toBeUndefined();
      const done = rows()[0];
      expect(done.textContent).toContain("approved");
      expect(done.textContent).toContain("Approved 3h ago");

      // A decided request can be opened to read it; it has nothing to decide.
      await click(header(done)!);
      expect(openIds()).toEqual(["done"]);
      expect(done.textContent).toContain("It fits the request.");
      expect(button(done, "Approve")).toBeUndefined();

      // A pending one is decided only once it is open, and the reader is not sent down the history afterwards.
      await press("A", rows()[3], { shiftKey: true });
      expect(heldRows()).toHaveLength(0);
      expect(apiMocks.approve).not.toHaveBeenCalled();
      await click(header(rows()[3])!);
      await pastDoubleClick();
      await click(button(rows()[3], "Approve"));
      await endHold();
      await vi.waitFor(() => expect(rows()[3].hasAttribute("data-approval-decided-row")).toBe(true));
      expect(openIds()).toEqual([]);
      expect(document.activeElement).toBe(rows()[3]);
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
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", heldFor("oldest"));
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
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", heldFor("oldest"));
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
      await pastDoubleClick();
      expect(rows()[0].querySelector("textarea")).toBeNull();
      await click(button(rows()[0], "Approve"));
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, heldFor("oldest"));
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
      expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, heldFor("oldest"));

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
        expect(apiMocks.approve).toHaveBeenLastCalledWith("oldest", undefined, heldFor("oldest"));
        expect(rows()[0].dataset.approvalHeldRow).toBe("sending");
        expect(undoButton(rows()[0])).toBeNull();

        await setVisibility("visible");
        await advance(APPROVE_AFTER_ADVANCE_MS);
        await click(button(rows()[1], "Approve"));
        await act(async () => {
          window.dispatchEvent(new Event("pagehide"));
        });
        expect(apiMocks.approve).toHaveBeenCalledTimes(2);
        expect(apiMocks.approve).toHaveBeenLastCalledWith("email", undefined, heldFor("email"));

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
      // That row is in view and says it: no toast is laid over the request being read.
      expect(toastMock.pushToast).not.toHaveBeenCalled();

      // The reader turns to it: the note is back, and a retry is held again and sends the same note.
      await click(header(rows()[0])!);
      await pastDoubleClick();
      expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
      expect(button(rows()[0], "Approve").disabled).toBe(false);
      await click(button(rows()[0], "Approve"));
      expect(alerts()).toHaveLength(0);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      await advance(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(2);
      expect(apiMocks.approve).toHaveBeenLastCalledWith("oldest", "Month to month only", heldFor("oldest"));
    });

    describe("an approval the server refuses because the request changed after Approve was pressed", () => {
      const CHANGED = "This request changed after you opened it. Reload it and decide again.";
      // What the page says in place of the server's words: it has reloaded the request by itself.
      const CHANGED_SHOWN = "This request changed after it was shown. It has been reloaded: check it and decide again.";
      const CHANGED_AT = new Date("2026-10-06T09:00:00.000Z");
      const refusal = (currentStatus: string) =>
        Object.assign(new Error(CHANGED), {
          status: 409,
          body: {
            error: CHANGED,
            code: "approval_version_conflict",
            details: {
              code: "approval_version_conflict",
              currentStatus,
              currentUpdatedAt: CHANGED_AT.toISOString(),
              expectedUpdatedAt: FIRST_SHOWN.oldest.toISOString(),
            },
          },
        });
      /**
       * The request changes on the server and no reload reaches the page before the hold ends: the
       * server refuses the approval, stores nothing, and the list shows the change from then on.
       */
      const changedOnServer = (id: string, change: Partial<Approval>) =>
        apiMocks.approve.mockImplementation(async (sentId: string, _note?: string, options?: { expectedUpdatedAt?: Date }) => {
          const stored = approvals.find((approval) => approval.id === sentId)!;
          if (sentId !== id || new Date(options!.expectedUpdatedAt!).getTime() === new Date(stored.updatedAt).getTime()) {
            const decided = { ...stored, status: "approved", decidedAt: new Date() } as Approval;
            approvals = approvals.map((approval) => (approval.id === sentId ? decided : approval));
            return decided;
          }
          throw refusal(stored.status);
        }) &&
        (() => {
          approvals = approvals.map((approval) =>
            approval.id === id ? ({ ...approval, ...change, updatedAt: CHANGED_AT } as Approval) : approval,
          );
        });
      const rowError = (row: HTMLElement) => row.querySelector("[data-approval-row-error]")?.textContent ?? null;

      it("is not approved in a revised version: the card returns, says so, and Approve waits for the revision to be read", async () => {
        const revise = changedOnServer("oldest", {
          payload: {
            title: "Request oldest",
            recommendedAction: "Order ten times the standing quantity.",
            reasoning: "It fits the request.",
            pros: ["A pro."],
            risks: ["A risk."],
          },
        });
        await render();

        await addNote(rows()[0], "Month to month only");
        await click(button(rows()[0], "Approve"));
        // The requester resubmits during the hold, and the page has not reloaded.
        revise();
        await advance(APPROVE_HOLD_MS);

        // Sent once, for the version the hold began with, and refused.
        expect(apiMocks.approve.mock.calls).toEqual([["oldest", "Month to month only", heldFor("oldest")]]);
        expect(heldRows()).toHaveLength(0);
        expect(rowError(rows()[0])).toBe("Not approved. The requester revised this request before your approval was sent.");
        expect(rows()[0].querySelector("[data-approval-unsent-note]")!.textContent).toBe("Note not sent");
        expect(announced()).toBe(
          "Not approved: Request oldest. The requester revised it before it was sent. Nothing was sent.",
        );
        // Never a success, and nothing is counted as decided.
        expect(container.textContent).not.toContain("Approved:");
        expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(false);
        // The reader stays at the request they moved on to; the row is in view, so no toast covers it.
        expect(openIds()).toEqual(["email"]);
        expect(toastMock.pushToast).not.toHaveBeenCalled();

        // It is not sent again by itself, with or without the version.
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);

        // The reload brought the revision: Approve waits for "I have reviewed it", then names the new version.
        await click(header(rows()[0])!);
        await pastDoubleClick();
        expect(rows()[0].textContent).toContain("Order ten times the standing quantity.");
        expect(rows()[0].querySelector("textarea")!.value).toBe("Month to month only");
        await click(button(rows()[0], "Approve"));
        expect(heldRows()).toHaveLength(0);
        await click(button(rows()[0], "I have reviewed it"));
        await click(button(rows()[0], "Approve"));
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(2);
        expect(apiMocks.approve).toHaveBeenLastCalledWith("oldest", "Month to month only", heldFor("oldest", CHANGED_AT));
        expect(announced()).toBe("Approved: Request oldest");
      });

      it("is not approved over a colleague's change request: the request shows as sent back, without buttons", async () => {
        const sendBack = changedOnServer("oldest", {
          status: "revision_requested",
          decisionNote: "Quote the delivery date.",
          decidedAt: CHANGED_AT,
        });
        await render();

        await click(button(rows()[0], "Approve"));
        sendBack();
        await advance(APPROVE_HOLD_MS);

        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(heldRows()).toHaveLength(0);
        expect(rowError(rows()[0])).toBe(
          "Not approved. This request was sent back for changes before your approval was sent.",
        );
        expect(announced()).toBe(
          "Not approved: Request oldest. It was sent back for changes before your approval was sent. Nothing was sent.",
        );
        expect(rows()[0].textContent).toContain("revision requested");
        await click(header(rows()[0])!);
        expect(button(rows()[0], "Approve")).toBeUndefined();
        expect(rows()[0].textContent).toContain("Changes you asked forQuote the delivery date.");
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("is not shown as the reader's approval when someone else decided first: the row says decided elsewhere", async () => {
        const rejectElsewhere = changedOnServer("oldest", {
          status: "rejected",
          decisionNote: "No longer needed",
          decidedAt: CHANGED_AT,
        });
        await render();

        await addNote(rows()[0], "Month to month only");
        await click(button(rows()[0], "Approve"));
        rejectElsewhere();
        await advance(APPROVE_HOLD_MS);

        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(heldRows()).toHaveLength(0);
        expect(announced()).toBe(
          "Not approved: Request oldest. Nothing was sent. Its status is now rejected: decided elsewhere.",
        );
        // The row keeps its place with the status and the note the server holds, as someone else's decision.
        expect(order()[0]).toBe("oldest");
        expect(rows()[0].textContent).toContain("rejected");
        expect(rows()[0].textContent).toContain("Decided elsewhere");
        expect(rows()[0].textContent).toContain("No longer needed");
        expect(rows()[0].textContent).not.toContain("Your note.");
        expect(alerts()).toHaveLength(0);
        expect(container.textContent).not.toContain("Approved:");
        expect(openIds()).toEqual(["email"]);
      });

      it("says so where the reader is when the approval was sent because the page was left, and sends nothing again", async () => {
        const revise = changedOnServer("oldest", { payload: { title: "Request oldest", recommendedAction: "Another plan." } });
        await render();

        await click(button(rows()[0], "Approve"));
        revise();
        // The reader leaves the queue: the hold is sent at once, with its version, and is refused.
        act(() => root.unmount());
        root = createRoot(container);
        await advance(0);

        expect(apiMocks.approve.mock.calls).toEqual([["oldest", undefined, heldFor("oldest")]]);
        expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
        const toast = toastMock.pushToast.mock.calls[0][0];
        expect(toast).toMatchObject({
          title: "Not approved: Request oldest",
          body: "The requester revised it before your approval was sent. Nothing was sent.",
          tone: "warn",
        });
        // The queue is gone: the action opens the request's own page.
        expect(toast.action.label).toBe("View request");
        act(() => toast.action.onClick());
        expect(routerMock.navigate).toHaveBeenCalledWith("/approvals/oldest");

        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("reports a refused rejection on its card and reloads it, and never as rejected", async () => {
        apiMocks.reject.mockRejectedValue(refusal("pending"));
        await render();
        const loads = apiMocks.list.mock.calls.length;

        await click(button(rows()[0], "Reject"));
        await click(button(rows()[0], "Reject request"));
        await advance(0);

        expect(apiMocks.reject).toHaveBeenCalledExactlyOnceWith("oldest", undefined, versionOf("oldest"));
        expect(alerts(rows()[0])[0].textContent).toBe(`Error while rejecting: ${CHANGED_SHOWN}`);
        expect(announced()).toBe(`Error while rejecting Request oldest: ${CHANGED_SHOWN}`);
        expect(rows()[0].hasAttribute("data-approval-decided-row")).toBe(false);
        expect(apiMocks.list.mock.calls.length).toBeGreaterThan(loads);
      });
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
      expect(toastMock.pushToast).not.toHaveBeenCalled();
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
        action: { label: "View request", onClick: expect.any(Function) },
      });
      // The queue is gone: the toast's action opens the request's own page.
      act(() => toastMock.pushToast.mock.calls[0][0].action.onClick());
      expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith("/approvals/oldest");
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
    /** The server's answer to a decision made for a version the request no longer has. */
    const refusal = (currentStatus: string, currentUpdatedAt: Date) => {
      const message = "This request changed after you opened it. Reload it and decide again.";
      return Object.assign(new Error(message), {
        status: 409,
        body: {
          error: message,
          code: "approval_version_conflict",
          details: { code: "approval_version_conflict", currentStatus, currentUpdatedAt: currentUpdatedAt.toISOString() },
        },
      });
    };
    /** Holds every reload of the list open from now on; the returned function lets them all answer. */
    const holdReloads = () => {
      const answers: Array<() => void> = [];
      apiMocks.list.mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(approvals))));
      return async () => {
        apiMocks.list.mockImplementation(async () => approvals);
        await act(async () => answers.forEach((answer) => answer()));
        await advance(1);
      };
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
    /**
     * The pointer and an element: "pointermove" is the reader moving the pointer over it,
     * "pointerover" is all the browser reports when the element is drawn or scrolled under a pointer
     * that lies still, and "pointerout" is the pointer leaving for somewhere outside the page.
     */
    const pointer = (
      type: "pointerover" | "pointermove" | "pointerout",
      target: HTMLElement,
      pointerType?: "mouse" | "pen" | "touch",
    ) =>
      act(async () => {
        const event = new MouseEvent(type, { bubbles: true, relatedTarget: null });
        if (pointerType) Object.defineProperty(event, "pointerType", { value: pointerType });
        target.dispatchEvent(event);
      });
    /** The list as another page left it in the cache a while ago, and a fresh copy that is still on its way. */
    const cachedListStillLoading = () => {
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000 } } });
      queryClient.setQueryData(queryKeys.approvals.list("company-1"), approvals, { updatedAt: Date.now() - 60_000 });
      let land: (list: Approval[]) => void = () => {};
      apiMocks.list.mockImplementation(() => new Promise<Approval[]>((resolve) => { land = resolve; }));
      /** The fresh copy arrives and is drawn. Later reloads answer at once again. */
      return async () => {
        apiMocks.list.mockImplementation(async () => approvals);
        await act(async () => land(approvals));
        await advance(1);
      };
    };
    /**
     * Places rows on a screen 768 pixels tall: `place` gives a row's top and bottom, and a row it
     * does not place lies at the top of the list, in view.
     */
    const placeRows = (place: (row: HTMLElement) => { top: number; bottom: number } | null) =>
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return (place(this) ?? { top: 0, bottom: 60 }) as DOMRect;
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

      it("does not approve any other request in the Full cards view, where every card has its own Approve", async () => {
        approveAtOnce();
        chooseFullCards();
        await render();

        await click(button(row("oldest"), "Approve"));
        // Every card below moved up. The second click can land on the Approve of the next card, or
        // of the one after it: neither was read, and neither is held.
        await advance(100);
        await click(button(row("email"), "Approve"));
        await click(button(row("newest"), "Approve"));
        await press("A", row("newest"), { shiftKey: true });
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
        expect(button(row("newest"), "Approve").disabled).toBe(false);
        expect(row("newest").textContent).not.toContain("Approving...");

        await advance(APPROVE_AFTER_ADVANCE_MS - 101);
        await click(button(row("newest"), "Approve"));
        expect(heldRows()).toHaveLength(1);

        // The same press works once the moment has passed.
        await advance(1);
        await click(button(row("newest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest", "newest"]);
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve.mock.calls.map((call) => call[0])).toEqual(["oldest", "newest"]);
      });

      it("ignores Approve just after the reader opened a row by its header, and takes the same press after it", async () => {
        approveAtOnce();
        await render();
        expect(openIds()).toEqual(["oldest"]);

        // A double click, or a double tap, on a closed row's header. The first press opens the row:
        // the card above it closes, and the row's Approve comes to rest where the header was.
        await click(header(row("newest"))!);
        expect(openIds()).toEqual(["newest"]);
        // The second press lands on that Approve. Nobody has read the request: nothing is held.
        await advance(150);
        await click(button(row("newest"), "Approve"));
        await press("A", row("newest"), { shiftKey: true });
        expect(heldRows()).toHaveLength(0);
        expect(button(row("newest"), "Approve").disabled).toBe(false);
        expect(row("newest").textContent).not.toContain("Approving...");
        await advance(APPROVE_AFTER_ADVANCE_MS - 151);
        await click(button(row("newest"), "Approve"));
        expect(heldRows()).toHaveLength(0);
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // The same press works once the moment has passed.
        await click(header(row("email"))!);
        await advance(APPROVE_AFTER_ADVANCE_MS);
        await click(button(row("email"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);

        // The page then opens the next request. The reader leaves it with K and comes back with J:
        // it is their choice now, and its Approve works at once.
        expect(openIds()).toEqual(["newest"]);
        await press("k");
        expect(openIds()).toEqual([]);
        await press("j");
        expect(openIds()).toEqual(["newest"]);
        await click(button(row("newest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email", "newest"]);
      });

      it("takes only the first click of a double click on Approve, whatever the first click of the pair was on", async () => {
        approveAtOnce();
        await render();
        await click(header(row("newest"))!);
        // Long after the row was opened: only the click count tells that this is no deliberate press.
        await advance(APPROVE_AFTER_ADVANCE_MS * 5);
        const clickNumber = (detail: number) =>
          act(async () => {
            button(row("newest"), "Approve").dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
            );
          });

        // The browser counts the second click of a double click as 2, also when the first one was on
        // another element (the row's header), and a third as 3.
        await clickNumber(2);
        await clickNumber(3);
        expect(heldRows()).toHaveLength(0);
        expect(button(row("newest"), "Approve").disabled).toBe(false);
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // A single click is 1; a press by the keyboard, and Shift+A, carry no count.
        await clickNumber(1);
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["newest"]);
        await click(undoButton(row("newest"))!);
        await clickNumber(0);
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["newest"]);
        await click(undoButton(row("newest"))!);
        await press("A", row("newest"), { shiftKey: true });
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["newest"]);
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

      it("is the first card of the list that loads, when the page opened with an older copy and the reader has not been in the list", async () => {
        const landFreshList = cachedListStillLoading();
        await rerender();
        // The older copy is on the page already, its first card shown open.
        expect(openIds()).toEqual(["oldest"]);

        approvals = [createApproval("older", "2026-09-10T00:00:00.000Z"), ...approvals];
        await landFreshList();
        expect(order()).toEqual(["older", "oldest", "email", "newest"]);
        // Nobody was reading yet: the queue starts at the request that has waited longest.
        expect(openIds()).toEqual(["older"]);

        // From here on it is pinned like any open card.
        approvals = [createApproval("oldest of all", "2026-09-05T00:00:00.000Z"), ...approvals];
        await reload();
        await advance(1);
        expect(order()[0]).toBe("oldest of all");
        expect(openIds()).toEqual(["older"]);
      });

      it("is pinned by the reader's first focus in the list, also while the list is still loading", async () => {
        const landFreshList = cachedListStillLoading();
        await rerender();
        expect(openIds()).toEqual(["oldest"]);
        // The reader starts on the card shown open: the reject panel puts focus in its field.
        await click(button(row("oldest"), "Reject"));
        await typeText(row("oldest"), "Too expensive");
        const typing = field("oldest")!;
        expect(document.activeElement).toBe(typing);

        // The fresh copy puts an older, resubmitted request first.
        approvals = [createApproval("older", "2026-09-10T00:00:00.000Z"), ...approvals];
        await landFreshList();
        expect(order()).toEqual(["older", "oldest", "email", "newest"]);

        expect(openIds()).toEqual(["oldest"]);
        expect(field("oldest")).toBe(typing);
        expect(typing.value).toBe("Too expensive");
        expect(document.activeElement).toBe(typing);
        expect(approveButtons()).toHaveLength(1);
        expect(row("oldest").contains(approveButtons()[0])).toBe(true);
      });

      it("does not take an Approve at once when the list that loads opens another card than the one shown while it loaded", async () => {
        approveAtOnce();
        const landFreshList = cachedListStillLoading();
        await rerender();
        expect(openIds()).toEqual(["oldest"]);

        // The fresh copy shows the first request approved elsewhere: the next one opens in its place.
        changeElsewhere("oldest", { status: "approved", decidedAt: LATER, updatedAt: LATER });
        await landFreshList();
        expect(openIds()).toEqual(["email"]);
        // The pointer may have been on its way to Approve of the card that was there.
        await click(button(row("email"), "Approve"));
        await press("A", row("email"), { shiftKey: true });
        expect(heldRows()).toHaveLength(0);
        expect(button(row("email"), "Approve").disabled).toBe(false);

        await advance(APPROVE_AFTER_ADVANCE_MS);
        await click(button(row("email"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);
      });

      it.each(["Email replies", "Sort: Oldest first"])(
        "takes an Approve at once on the card the reader's own press of %s put first while the list was loading",
        async (control) => {
          approveAtOnce();
          const landFreshList = cachedListStillLoading();
          await rerender();
          expect(openIds()).toEqual(["oldest"]);

          // The reader starts the list again before the fresh copy lands: its first card is their choice.
          await click(button(container, control));
          const [chosen] = openIds();
          expect(chosen).not.toBe("oldest");

          // The same list lands. Nothing was swapped under the reader, so Approve does not wait.
          await landFreshList();
          expect(openIds()).toEqual([chosen]);
          await click(button(row(chosen!), "Approve"));
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual([chosen]);
        },
      );

      it("is shown from its top when J or K opens it and it ends up above the screen", async () => {
        const { scrolls, restore } = recordScrolls();
        // A request taller than the window, whose closed row lay at the top edge: opened, "nearest"
        // brings its end into view and leaves its title far above.
        const rect = placeRows((element) =>
          element.dataset.approvalCard === "email" && header(element)?.getAttribute("aria-expanded") === "true"
            ? { top: -1257, bottom: 768 }
            : null);
        try {
          await render();
          await act(async () => row("newest").focus());
          scrolls.length = 0;
          await press("k");
          expect(openIds()).toEqual(["email"]);
          expect(document.activeElement).toBe(row("email"));
          expect(scrolls).toEqual([["email", "nearest"], ["email", "start"]]);

          await press("k");
          scrolls.length = 0;
          await press("j");
          expect(openIds()).toEqual(["email"]);
          expect(scrolls).toEqual([["email", "nearest"], ["email", "start"]]);

          // A card that fits is only brought into view.
          scrolls.length = 0;
          await press("j");
          expect(openIds()).toEqual(["newest"]);
          expect(scrolls).toEqual([["newest", "nearest"]]);
        } finally {
          rect.mockRestore();
          restore();
        }
      });

      it("is brought into view when the reader opens it, from its top when it ends up above the screen", async () => {
        const { scrolls, restore } = recordScrolls();
        // Closing a tall card above the pressed row moves the list up by its height: the card that
        // opens then lies above the screen. (Nothing scrolls in this test, so it stays there, as a
        // card taller than the screen would after a scroll that only brings its end into view.)
        const rect = placeRows((element) =>
          element.dataset.approvalCard === "newest" && header(element)?.getAttribute("aria-expanded") === "true"
            ? { top: -797, bottom: -459 }
            : null);
        try {
          await render();
          await click(header(row("email"))!);
          expect(openIds()).toEqual(["email"]);
          expect(scrolls).toEqual([["email", "nearest"]]);

          scrolls.length = 0;
          await click(header(row("newest"))!);
          expect(openIds()).toEqual(["newest"]);
          expect(scrolls).toEqual([["newest", "nearest"], ["newest", "start"]]);

          // Closing a card moves nothing.
          scrolls.length = 0;
          await click(header(row("newest"))!);
          expect(openIds()).toEqual([]);
          expect(scrolls).toEqual([]);
        } finally {
          rect.mockRestore();
          restore();
        }
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
        await vi.waitFor(() => expect(apiMocks.reject).toHaveBeenCalledWith("oldest", "No. Too expensive.", versionOf("oldest")));
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
        expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", heldFor("oldest"));
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

      it("are all kept in view when several are running: the first of them goes to the top, not only the last", async () => {
        approveAtOnce();
        const { scrolls, restore } = recordScrolls();
        const heldAt = new Map<string, { top: number; bottom: number }>();
        const rect = placeRows((element) =>
          element.hasAttribute("data-approval-held-row") ? (heldAt.get(element.dataset.approvalCard ?? "") ?? null) : null);
        const approveTwo = async () => {
          await render();
          await click(button(row("oldest"), "Approve"));
          await advance(1300);
          scrolls.length = 0;
          await click(button(row("email"), "Approve"));
          const made = [...scrolls];
          await click(undoButton(row("email"))!);
          await click(undoButton(row("oldest"))!);
          act(() => root.unmount());
          root = createRoot(container);
          return made;
        };
        try {
          // The request that opens is tall: both held rows are pushed above the screen.
          heldAt.set("oldest", { top: -83, bottom: -21 });
          heldAt.set("email", { top: -9, bottom: 53 });
          expect(await approveTwo()).toEqual([["newest", "nearest"], ["oldest", "start"]]);

          // The newest held row is still in view, the one before it is not.
          heldAt.set("oldest", { top: -60, bottom: 2 });
          heldAt.set("email", { top: 14, bottom: 76 });
          expect(await approveTwo()).toEqual([["newest", "nearest"], ["oldest", "start"]]);

          // A hold started far up the list is left where it is: the card just opened would be out of view.
          heldAt.set("oldest", { top: -5000, bottom: -4938 });
          heldAt.set("email", { top: -9, bottom: 53 });
          expect(await approveTwo()).toEqual([["newest", "nearest"], ["email", "start"]]);

          // Everything in view: nothing more is scrolled.
          heldAt.set("oldest", { top: 4, bottom: 66 });
          heldAt.set("email", { top: 78, bottom: 140 });
          expect(await approveTwo()).toEqual([["newest", "nearest"]]);
          expect(apiMocks.approve).not.toHaveBeenCalled();
        } finally {
          rect.mockRestore();
          restore();
        }
      });

      it("are not paused by a row drawn or scrolled under a pointer that lies still, nor by a finger", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));

        // All the browser reports when the held row is drawn where the pointer was left: no movement.
        await pointer("pointerover", row("oldest"));
        expect(holdStatus(row("oldest"))).toBe("Approving in 5s");
        // A finger passing over the row is a scroll or a tap, not a pointer resting on it.
        await pointer("pointermove", row("oldest"), "touch");
        expect(holdStatus(row("oldest"))).toBe("Approving in 5s");

        await advance(APPROVE_HOLD_MS - 1);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        await advance(1);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("stand still for thirty seconds at most in all; then the countdown runs whatever the pointer and focus do, and the row says so", async () => {
        approveAtOnce();
        await render();
        expect(APPROVE_PAUSE_LIMIT_MS).toBe(30_000);
        await click(button(row("oldest"), "Approve"));
        await advance(2000);
        const STARTED = "Approving in 5 seconds. Shift+Z undoes it. Request oldest";
        const hint = () =>
          document.getElementById(undoButton(row("oldest"))!.getAttribute("aria-describedby")!)!.textContent;

        // Ten seconds with focus on Undo, then the pointer: both draw on the same thirty seconds.
        await act(async () => undoButton(row("oldest"))!.focus());
        await advance(10_000);
        await act(async () => undoButton(row("oldest"))!.blur());
        expect(holdStatus(row("oldest"))).toBe("Approving in 3s");
        await pointer("pointermove", row("oldest"));
        expect(holdStatus(row("oldest"))).toBe("Paused, 3s left");
        await advance(19_999);
        expect(holdStatus(row("oldest"))).toBe("Paused, 3s left");
        expect(announced()).toBe(STARTED);

        // The thirty seconds are up with the pointer still on the row.
        await advance(1);
        expect(holdStatus(row("oldest"))).toBe("Pause over, sending in 3s");
        const PAUSE_OVER = "The pause is over: approving in 3 seconds. Undo is in its row. Request oldest";
        expect(announced()).toBe(PAUSE_OVER);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // Neither the pointer nor focus on Undo stops the clock again, and the button no longer says they do.
        await pointer("pointermove", row("oldest"));
        await act(async () => undoButton(row("oldest"))!.focus());
        expect(hint()).toBe(
          "The pause is over: the approval is sent when its countdown ends, also while focus is on this button.",
        );
        await advance(1000);
        expect(holdStatus(row("oldest"))).toBe("Pause over, sending in 2s");
        // Said once: the seconds are not read out one by one.
        expect(announced()).toBe(PAUSE_OVER);
        await advance(1999);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        await advance(1);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, heldFor("oldest"));

        await pointer("pointerout", row("oldest"));
        await advance(APPROVE_PAUSE_LIMIT_MS * 2);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("are still undone, and still sent at once when the page is left, once the pause has run out", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await pointer("pointermove", row("oldest"));
        await advance(APPROVE_PAUSE_LIMIT_MS);
        expect(holdStatus(row("oldest"))).toBe("Pause over, sending in 5s");

        await advance(APPROVE_HOLD_MS - 1);
        await click(undoButton(row("oldest"))!);
        expect(heldRows()).toHaveLength(0);
        expect(openIds()).toEqual(["oldest"]);
        await advance(APPROVE_PAUSE_LIMIT_MS * 2);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // A new hold has its own thirty seconds. Leaving the page sends it at once, and only once.
        await click(button(row("oldest"), "Approve"));
        await pointer("pointermove", row("oldest"));
        await advance(APPROVE_PAUSE_LIMIT_MS - 1);
        expect(holdStatus(row("oldest"))).toBe("Paused, 5s left");
        await advance(1);
        expect(holdStatus(row("oldest"))).toBe("Pause over, sending in 5s");
        act(() => root.unmount());
        root = createRoot(container);
        expect(apiMocks.approve.mock.calls).toEqual([["oldest", undefined, heldFor("oldest")]]);
        await advance(APPROVE_PAUSE_LIMIT_MS * 2);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("leave three seconds for Undo when the limit ends a pause that began in the hold's last moment", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        // The pointer reaches the held row with 50 ms of the hold left, and stays.
        await advance(APPROVE_HOLD_MS - 50);
        await pointer("pointermove", row("oldest"));
        expect(holdStatus(row("oldest"))).toBe("Paused, 1s left");
        await advance(APPROVE_PAUSE_LIMIT_MS - 1);
        expect(holdStatus(row("oldest"))).toBe("Paused, 1s left");

        // The thirty seconds are up. The approval does not go out in the same moment: the row and the
        // announcement give the time there really is, and Undo is still there for all of it.
        await advance(1);
        expect(holdStatus(row("oldest"))).toBe("Pause over, sending in 3s");
        expect(announced()).toBe("The pause is over: approving in 3 seconds. Undo is in its row. Request oldest");
        expect(undoButton(row("oldest"))).not.toBeNull();
        await advance(APPROVE_AFTER_PAUSE_LIMIT_MS - 1);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        await advance(1);
        expect(apiMocks.approve.mock.calls).toEqual([["oldest", undefined, heldFor("oldest")]]);
        await advance(APPROVE_PAUSE_LIMIT_MS * 2);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("raise a toast for a failed approval only when its row is out of view", async () => {
        apiMocks.approve.mockRejectedValue(new Error("Session expired"));
        let place: { top: number; bottom: number } | null = null;
        const rect = placeRows((element) => (element.dataset.approvalCard === "oldest" ? place : null));
        const approveAndFail = async () => {
          if (openIds()[0] !== "oldest") {
            await click(header(row("oldest"))!);
            await pastDoubleClick();
          }
          await click(button(row("oldest"), "Approve"));
          // The reader is at the next request when the approval comes back as an error.
          expect(openIds()).toEqual(["email"]);
          await advance(APPROVE_HOLD_MS);
          expect(alerts(row("oldest"))[0].textContent).toBe("Error while approving: Session expired");
        };
        try {
          await render();
          // In view: its own row says it, and no toast is laid over the request being read.
          await approveAndFail();
          expect(toastMock.pushToast).not.toHaveBeenCalled();

          // Scrolled off above the list.
          place = { top: -400, bottom: -338 };
          await approveAndFail();
          expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
          expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
            title: "Error while approving Request oldest: Session expired",
            tone: "error",
            action: { label: "View request", onClick: expect.any(Function) },
          });

          // Below the end of the window.
          place = { top: window.innerHeight + 40, bottom: window.innerHeight + 102 };
          await approveAndFail();
          expect(toastMock.pushToast).toHaveBeenCalledTimes(2);

          // The toast lies where the open request's Approve rests, on a phone under its "View request".
          // A press on that stays on the queue and goes to the failed request's row; nothing is opened,
          // nothing is held, and the page is not left (which would send every other hold at once).
          expect(document.activeElement).not.toBe(row("oldest"));
          await act(async () => toastMock.pushToast.mock.calls[1][0].action.onClick());
          expect(routerMock.navigate).not.toHaveBeenCalled();
          expect(document.activeElement).toBe(row("oldest"));
          expect(openIds()).toEqual(["email"]);
          expect(heldRows()).toHaveLength(0);
          expect(alerts(row("oldest"))[0].textContent).toBe("Error while approving: Session expired");
        } finally {
          rect.mockRestore();
        }
      });

      it("do not run out while the pointer rests on the row; the rest of the time runs once it leaves", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await advance(2000);
        expect(holdStatus(row("oldest"))).toBe("Approving in 3s");

        await pointer("pointermove", row("oldest"));
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
        await pointer("pointermove", row("oldest"));
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
          "The approval is not sent while focus is on this button, for up to 30 seconds in all.",
        );
        // The pointer passing over the row and away does not restart a clock that focus still holds.
        await pointer("pointermove", row("oldest"));
        await pointer("pointerout", row("oldest"));
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        await act(async () => undo.blur());
        await advance(3999);
        expect(apiMocks.approve).not.toHaveBeenCalled();
        await advance(1);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(apiMocks.approve).toHaveBeenCalledWith("oldest", undefined, heldFor("oldest"));
      });

      it("are never sent after Undo, also when the hold was paused", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await pointer("pointermove", row("oldest"));
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
        await pointer("pointermove", row("oldest"));
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
        await pointer("pointermove", row("email"));
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

      it("are sent at once when the browser tab is hidden while focus on Undo holds the clock", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        await act(async () => undoButton(row("oldest"))!.focus());
        await advance(APPROVE_HOLD_MS * 2);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        try {
          await act(async () => {
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          expect(apiMocks.approve.mock.calls).toEqual([["oldest", undefined, heldFor("oldest")]]);
          // Focus that rested on Undo is on the row; nothing is left to undo.
          expect(undoButton(row("oldest"))).toBeNull();
          expect(document.activeElement).toBe(row("oldest"));
        } finally {
          delete (document as unknown as { visibilityState?: string }).visibilityState;
        }
        await press("Z", document, { shiftKey: true });
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("are sent at once when the reader changes company, and a failure is reported where they are then", async () => {
        // The other company has nothing to decide, so no open request there stands in for a reason to say it.
        const otherCompany = [createApproval("elsewhere", "2026-09-25T00:00:00.000Z", { status: "approved" })];
        apiMocks.list.mockImplementation(async (companyId: string) => (companyId === "company-2" ? otherCompany : approvals));
        let fail: () => void = () => {};
        apiMocks.approve.mockImplementation(
          () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
        );
        await render();
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        await click(button(row("oldest"), "Approve"));
        // Paused, so only the change of company can be what sends it.
        await pointer("pointermove", row("oldest"));
        await advance(APPROVE_HOLD_MS * 2);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        companyMock.selectedCompanyId = "company-2";
        await rerender();
        expect(apiMocks.approve.mock.calls).toEqual([["oldest", "Month to month only", heldFor("oldest")]]);
        await vi.waitFor(() => expect(container.textContent).toContain("Nothing needs a decision."));
        // The other company's queue starts afresh: no row of the first company, nothing counted as decided.
        expect(order()).toEqual([]);
        expect(progress()).toBeNull();

        await act(async () => fail());
        // That request has no row on this page: the failure is raised as a toast with a way to it.
        expect(alerts()).toHaveLength(0);
        expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
        expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
          title: "Error while approving Request oldest: Session expired",
          tone: "error",
          action: { label: "View request", onClick: expect.any(Function) },
        });
        // This queue is another company's: the action opens the request's own page.
        await act(async () => toastMock.pushToast.mock.calls[0][0].action.onClick());
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith("/approvals/oldest");
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("are not offered for a second approval after a change of tab while the list reload is still on its way", async () => {
        // The approve request answers at once; the reload of the list that follows does not answer.
        const loaded = approvals;
        let loads = 0;
        apiMocks.list.mockImplementation(() => {
          loads += 1;
          return loads === 1 ? Promise.resolve(loaded) : new Promise<Approval[]>(() => {});
        });
        apiMocks.approve.mockImplementation(async (id: string) => (
          { ...loaded.find((approval) => approval.id === id)!, status: "approved", decidedAt: LATER, updatedAt: LATER } as Approval
        ));
        await render();
        await click(button(row("oldest"), "Approve"));

        // To All decisions (which sends the hold) and back: the rows decided on this visit are forgotten.
        routerMock.location.pathname = "/approvals/all";
        await rerender();
        await vi.waitFor(() => expect(announced()).toBe("Approved: Request oldest"));
        expect(loads).toBe(2);
        routerMock.location.pathname = "/approvals/pending";
        await rerender();

        // The list has not reloaded, yet the approved request is not a card with Approve again.
        expect(order()).toEqual(["email", "newest"]);
        expect(container.querySelector("[data-tab='pending']")!.textContent).toBe("To decide2");
        for (const approve of approveButtons()) await click(approve);
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve.mock.calls.filter((call) => call[0] === "oldest")).toHaveLength(1);
      });

      it("report a failure as a toast when the page was left with no other request open, or the list no longer holds the request", async () => {
        const failure = {
          title: "Error while approving Request oldest: Session expired",
          tone: "error",
          action: { label: "View request", onClick: expect.any(Function) },
        };
        approvals = approvals.filter((approval) => approval.id === "oldest");
        let fail: () => void = () => {};
        apiMocks.approve.mockImplementation(
          () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
        );
        await render();
        // The only request: nothing opens after it, so nothing but the page being gone tells the two cases apart.
        await click(button(row("oldest"), "Approve"));
        expect(openIds()).toEqual([]);
        act(() => root.unmount());
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        await act(async () => fail());
        expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
        expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject(failure);

        // Again on a page that stays, whose list stops holding the request while the approval is on its way.
        root = createRoot(container);
        await render();
        await click(button(row("oldest"), "Approve"));
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(2);
        approvals = [];
        await reload();
        await vi.waitFor(() => expect(container.textContent).toContain("Nothing needs a decision."));
        await act(async () => fail());
        expect(alerts()).toHaveLength(0);
        expect(toastMock.pushToast).toHaveBeenCalledTimes(2);
        expect(toastMock.pushToast.mock.calls[1][0]).toMatchObject(failure);
        // The queue is on screen but has no row for the request: the action opens the request's own page.
        await act(async () => toastMock.pushToast.mock.calls[1][0].action.onClick());
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith("/approvals/oldest");
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
        await pastDoubleClick();
        expect(notice("newest")!.dataset.approvalRevised).toBe("unreviewed");
        await click(button(row("newest"), "Approve"));
        expect(heldRows()).toHaveLength(0);

        await click(button(row("newest"), "I have reviewed it"));
        expect(notice("newest")!.dataset.approvalRevised).toBe("reviewed");
        await click(button(container, "Email replies"));
        await click(button(container, "All"));
        await click(header(row("newest"))!);
        await pastDoubleClick();
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
        await pastDoubleClick();
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
        await pastDoubleClick();
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

      it("is not approved by an approval still held when the revision arrived: the hold is taken back, with its note", async () => {
        approveAtOnce();
        await render();
        await click(header(row("newest"))!);
        await pastDoubleClick();
        await click(button(row("newest"), "Add a note"));
        await typeText(row("newest"), "Month to month only");
        await click(button(row("newest"), "Approve"));
        // The pointer rests on the held row: its five seconds stand still for as long as it does.
        await pointer("pointermove", row("newest"));
        await advance(APPROVE_HOLD_MS * 4);
        expect(holdStatus(row("newest"))).toBe("Paused, 5s left");

        // Meanwhile another board member sends the request back and the requester resubmits it with
        // another recommendation, before the list reloads. The approval was pressed for the version
        // before: it is not sent for this one.
        revise("newest", LATER_STILL);
        await reload();
        // The reloaded list is drawn a moment after it arrives.
        await advance(1);
        expect(heldRows()).toHaveLength(0);
        expect(header(row("newest"))!.getAttribute("aria-expanded")).toBe("false");
        expect(row("newest").textContent).toContain(REVISED_ROW);
        expect(unsentNote("newest")).toBe("Note not sent");
        // The row itself says why nothing went out, and that line stays until the reader acts on it.
        const NOT_SENT = "Not approved. The requester revised this request before your approval was sent.";
        expect(row("newest").querySelector("[data-approval-row-error]")!.textContent).toBe(NOT_SENT);
        expect(announced()).toBe(
          "Not approved: Request newest. The requester revised it before it was sent. Nothing was sent.",
        );
        // The row is in view and says it: no toast is laid over the request being read.
        expect(toastMock.pushToast).not.toHaveBeenCalled();
        expect(progress()).toBeNull();

        // Whatever the pointer does next, and however long the page stays open, nothing goes out.
        await pointer("pointerout", row("newest"));
        await advance(APPROVE_HOLD_MS * 4);
        await press("Z", document, { shiftKey: true });
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // It stays on the page under a kind filter that would leave it out, like any request with such a line.
        await click(button(container, "Email replies"));
        expect(order()).toEqual(["email", "newest"]);
        await click(button(container, "All"));

        // The card is held back like any revised request, and the note typed with the approval is still there.
        await click(header(row("newest"))!);
        await pastDoubleClick();
        expect(row("newest").textContent).toContain("Order ten times the standing quantity.");
        expect(notice("newest")!.dataset.approvalRevised).toBe("unreviewed");
        expect(field("newest")!.value).toBe("Month to month only");
        expect(row("newest").querySelector("[data-approval-decision-error]")!.textContent).toBe(NOT_SENT);
        await click(button(row("newest"), "Approve"));
        expect(heldRows()).toHaveLength(0);
        await click(button(row("newest"), "I have reviewed it"));
        await click(button(row("newest"), "Approve"));
        // Approved again, for the version now read: the line is gone.
        expect(alerts()).toHaveLength(0);
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        // The new hold names the revision the reader confirmed, not the version first held.
        expect(apiMocks.approve).toHaveBeenCalledWith("newest", "Month to month only", heldFor("newest", LATER_STILL));
      });

      it("is not approved by an approval still held when the list shows it was sent back for changes", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        await click(button(row("oldest"), "Approve"));
        // Focus on Undo holds the clock.
        await act(async () => undoButton(row("oldest"))!.focus());
        await advance(APPROVE_HOLD_MS * 2);
        expect(holdStatus(row("oldest"))).toBe("Paused, 5s left");

        // Another board member sends the request back with a note. The server would still store an
        // approval over that change request, so the hold is taken back as soon as the list shows it.
        changeElsewhere("oldest", {
          status: "revision_requested",
          decisionNote: "Wrong price, fix before sending",
          decidedAt: LATER,
          updatedAt: LATER,
        });
        await reload();
        await advance(1);
        expect(heldRows()).toHaveLength(0);
        const SENT_BACK = "Not approved. This request was sent back for changes before your approval was sent.";
        expect(row("oldest").querySelector("[data-approval-row-error]")!.textContent).toBe(SENT_BACK);
        expect(announced()).toBe(
          "Not approved: Request oldest. It was sent back for changes before your approval was sent. Nothing was sent.",
        );
        // The request stays in its place, with its real status and this line, not folded away below the queue.
        expect(order()).toEqual(["oldest", "email", "newest"]);
        expect(row("oldest").textContent).toContain("revision requested");
        expect(container.querySelector("[data-approval-sent-back-section]")).toBeNull();
        // Focus that rested on Undo is on the row that took its place; the request being read stays open.
        expect(document.activeElement).toBe(row("oldest"));
        expect(openIds()).toEqual(["email"]);
        expect(progress()).toBeNull();
        expect(toastMock.pushToast).not.toHaveBeenCalled();

        // However long the page stays open, nothing goes out.
        await act(async () => (document.activeElement as HTMLElement).blur());
        await advance(APPROVE_HOLD_MS * 4);
        await press("Z", document, { shiftKey: true });
        expect(apiMocks.approve).not.toHaveBeenCalled();

        // Opened, it shows the colleague's change request and offers no decision.
        await click(header(row("oldest"))!);
        expect(row("oldest").textContent).toContain("Waiting on the requester to revise");
        expect(row("oldest").textContent).toContain("Wrong price, fix before sending");
        expect(row("oldest").querySelector("[data-approval-decision-error]")!.textContent).toBe(SENT_BACK);
        expect(approveButtons().filter((approve) => row("oldest").contains(approve))).toHaveLength(0);
      });

      describe("a held approval whose request is decided somewhere else before it is sent", () => {
        const UNTOUCHED = "Not approved: Request oldest. Nothing was sent. Its status is now";
        /** Approves the first request with a note; the reader is moved on to the next one. */
        const holdOldest = async () => {
          approveAtOnce();
          await render();
          await click(button(row("oldest"), "Add a note"));
          await typeText(row("oldest"), "Month to month only");
          await click(button(row("oldest"), "Approve"));
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
          expect(openIds()).toEqual(["email"]);
        };
        /** The hold is gone, nothing went out, and the row is the other session's decision, not the reader's. */
        const expectDecidedElsewhere = async (status: string, note: string | null) => {
          expect(heldRows()).toHaveLength(0);
          expect(order()).toEqual(["oldest", "email", "newest"]);
          expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
          expect(row("oldest").textContent).toContain(status);
          expect(row("oldest").textContent).toContain("Decided elsewhere");
          if (note) expect(row("oldest").textContent).toContain(`Decision note. ${note}`);
          expect(row("oldest").textContent).not.toContain("Your note.");
          expect(row("oldest").textContent).not.toContain("Month to month only");
          expect(alerts()).toHaveLength(0);
          expect(announced()).toBe(`${UNTOUCHED} ${status}: decided elsewhere.`);
          // In view, the row says it: no toast is laid over the request being read, which stays open.
          expect(toastMock.pushToast).not.toHaveBeenCalled();
          expect(openIds()).toEqual(["email"]);
          // Not the reader's decision.
          expect(progress()).toBeNull();
          // However long the page stays open, and whatever Shift+Z is pressed for, nothing goes out.
          await advance(APPROVE_HOLD_MS * 4);
          await press("Z", document, { shiftKey: true });
          expect(apiMocks.approve).not.toHaveBeenCalled();
          expect(announced()).toBe(`${UNTOUCHED} ${status}: decided elsewhere.`);
        };

        it("is not sent when the request was approved: the row shows the other decision and its note", async () => {
          await holdOldest();
          await advance(APPROVE_HOLD_MS - 1000);
          changeElsewhere("oldest", { status: "approved", decisionNote: "Fine by me", decidedAt: LATER, updatedAt: LATER });
          await reload();
          await advance(1);
          await expectDecidedElsewhere("approved", "Fine by me");
        });

        it("is not sent when the request was rejected", async () => {
          await holdOldest();
          changeElsewhere("oldest", { status: "rejected", decisionNote: "No longer needed", decidedAt: LATER, updatedAt: LATER });
          await reload();
          await advance(1);
          await expectDecidedElsewhere("rejected", "No longer needed");
        });

        it("is not sent when the request was cancelled", async () => {
          await holdOldest();
          changeElsewhere("oldest", { status: "cancelled", updatedAt: LATER });
          await reload();
          await advance(1);
          await expectDecidedElsewhere("cancelled", null);
        });

        it("is not sent when the hold was paused, and focus on its Undo goes to the row", async () => {
          await holdOldest();
          await act(async () => undoButton(row("oldest"))!.focus());
          await advance(APPROVE_HOLD_MS * 2);
          expect(holdStatus(row("oldest"))).toBe("Paused, 5s left");
          changeElsewhere("oldest", { status: "approved", decisionNote: "Fine by me", decidedAt: LATER, updatedAt: LATER });
          await reload();
          await advance(1);
          expect(document.activeElement).toBe(row("oldest"));
          await act(async () => (document.activeElement as HTMLElement).blur());
          await expectDecidedElsewhere("approved", "Fine by me");
        });

        it("is sent as before when a reload shows the request still pending", async () => {
          await holdOldest();
          await advance(APPROVE_HOLD_MS - 1000);
          // Another request is decided elsewhere, and this one only carries a newer time.
          changeElsewhere("newest", { status: "approved", decidedAt: LATER, updatedAt: LATER });
          changeElsewhere("oldest", { updatedAt: LATER });
          await reload();
          await advance(1);
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
          expect(apiMocks.approve).not.toHaveBeenCalled();
          await advance(1000);
          expect(apiMocks.approve).toHaveBeenCalledTimes(1);
          expect(apiMocks.approve).toHaveBeenCalledWith("oldest", "Month to month only", heldFor("oldest"));
          await vi.waitFor(() => expect(row("oldest").textContent).toContain("Your note. Month to month only"));
          expect(row("oldest").textContent).not.toContain("Decided elsewhere");
        });

        it("leaves another hold alone when this page's own approval lands and corrects the list", async () => {
          await holdOldest();
          await advance(APPROVE_HOLD_MS - 1000);
          await pastDoubleClick();
          await click(button(row("email"), "Approve"));
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest", "email"]);
          // The first approval goes out and lands; the list is corrected and reloaded.
          await advance(1000);
          await vi.waitFor(() => expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true));
          expect(row("oldest").textContent).not.toContain("Decided elsewhere");
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);
          await advance(APPROVE_HOLD_MS);
          expect(apiMocks.approve).toHaveBeenCalledTimes(2);
          await vi.waitFor(() => expect(row("email").hasAttribute("data-approval-decided-row")).toBe(true));
          expect(row("email").textContent).not.toContain("Decided elsewhere");
          expect(toastMock.pushToast).not.toHaveBeenCalled();
        });

        it("says so in a toast too when its row is out of view, and keeps the typed note for a resubmission", async () => {
          const rect = placeRows((element) =>
            element.dataset.approvalCard === "oldest" ? { top: -400, bottom: -338 } : null,
          );
          try {
            await holdOldest();
            changeElsewhere("oldest", { status: "rejected", decidedAt: LATER, updatedAt: LATER });
            await reload();
            await advance(1);
            expect(heldRows()).toHaveLength(0);
            expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
            expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
              title: "Not approved: Request oldest",
              body: "Its status is now rejected: decided elsewhere. Nothing was sent.",
              tone: "warn",
            });
          } finally {
            rect.mockRestore();
          }
          // Pending again later: its card returns with the note that was typed with the approval.
          changeElsewhere("oldest", { status: "pending", decidedAt: null, updatedAt: LATER_STILL });
          await reload();
          await advance(1);
          await click(header(row("oldest"))!);
          expect(field("oldest")!.value).toBe("Month to month only");
          expect(apiMocks.approve).not.toHaveBeenCalled();
        });
      });

      it("counts an approval the server stored but answered with an error as the reader's own after a retry", async () => {
        // The first send is stored and its answer is lost.
        apiMocks.approve.mockImplementation(async (id: string) => {
          changeElsewhere(id, { status: "approved", decidedAt: LATER, updatedAt: LATER });
          throw new Error("Network down");
        });
        await render();
        await click(button(row("oldest"), "Approve"));
        // The reload that follows the error is slow to answer.
        const answers: Array<() => void> = [];
        apiMocks.list.mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(approvals))));
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());

        // The reader approves again before it does.
        if (!openIds().includes("oldest")) await click(header(row("oldest"))!);
        await pastDoubleClick();
        await click(button(row("oldest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
        expect(answers.length).toBeGreaterThan(0);
        await act(async () => answers.forEach((answer) => answer()));
        await advance(1);

        // The second approval is not sent, and the row is the reader's own decision.
        expect(heldRows()).toHaveLength(0);
        expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
        expect(row("oldest").textContent).toContain("approved");
        expect(row("oldest").textContent).not.toContain("Decided elsewhere");
        expect(announced()).toBe("Approved: Request oldest");
        expect(progress()).toContain("1 decided this visit");
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("shows the other decision, and takes a later Approve, when the reader had sent the request back before", async () => {
        approveAtOnce();
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
        // Sent back here, resubmitted, and approved here: the approval is held.
        await click(button(row("oldest"), "Request changes"));
        await typeText(row("oldest"), "Shorter please");
        await click(button(row("oldest"), "Send request"));
        await vi.waitFor(() => expect(row("oldest").textContent).toContain("Your note. Shorter please"));
        const resubmitted = { title: "Request oldest", recommendedAction: "A shorter version." };
        changeElsewhere("oldest", {
          status: "pending",
          decidedAt: null,
          decisionNote: null,
          updatedAt: LATER_STILL,
          payload: resubmitted,
        });
        await reload();
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());
        await click(header(row("oldest"))!);
        await pastDoubleClick();
        await click(button(row("oldest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);

        // A colleague rejects it before the approval goes out.
        const AGAIN = new Date("2026-10-06T11:00:00.000Z");
        changeElsewhere("oldest", { status: "rejected", decisionNote: "Wrong price", decidedAt: AGAIN, updatedAt: AGAIN });
        await reload();
        await advance(1);
        expect(heldRows()).toHaveLength(0);
        expect(row("oldest").textContent).toContain("rejected");
        expect(row("oldest").textContent).toContain("Decided elsewhere");
        expect(row("oldest").textContent).toContain("Decision note. Wrong price");
        expect(row("oldest").textContent).not.toContain("Your note.");

        // Pending once more: nothing of the cancelled hold is left on it, and Approve is taken.
        const ONCE_MORE = new Date("2026-10-06T12:00:00.000Z");
        changeElsewhere("oldest", { status: "pending", decidedAt: null, decisionNote: null, updatedAt: ONCE_MORE });
        await reload();
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());
        if (!openIds().includes("oldest")) await click(header(row("oldest"))!);
        await pastDoubleClick();
        await click(button(row("oldest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("says in a toast that a hold was taken back only when its row is out of view", async () => {
        approveAtOnce();
        let place: { top: number; bottom: number } | null = { top: -400, bottom: -338 };
        const rect = placeRows((element) => (element.dataset.approvalCard === "newest" ? place : null));
        try {
          await render();
          await click(header(row("newest"))!);
          await pastDoubleClick();
          await click(button(row("newest"), "Approve"));
          await pointer("pointermove", row("newest"));

          // Revised while its held row is scrolled off above the list.
          revise("newest", LATER);
          await reload();
          await advance(1);
          expect(heldRows()).toHaveLength(0);
          expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
          expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
            title: "Not approved: Request newest",
            body: "The requester revised it before your approval was sent. Nothing was sent.",
            tone: "warn",
          });

          // Approved again for the revised version, then sent back while its row is below the window.
          await click(header(row("newest"))!);
          await pastDoubleClick();
          await click(button(row("newest"), "I have reviewed it"));
          await click(button(row("newest"), "Approve"));
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["newest"]);
          place = { top: window.innerHeight + 40, bottom: window.innerHeight + 102 };
          changeElsewhere("newest", { status: "revision_requested", decidedAt: LATER_STILL, updatedAt: LATER_STILL });
          await reload();
          await advance(1);
          expect(heldRows()).toHaveLength(0);
          expect(toastMock.pushToast).toHaveBeenCalledTimes(2);
          expect(toastMock.pushToast.mock.calls[1][0]).toMatchObject({
            title: "Not approved: Request newest",
            body: "It was sent back for changes before your approval was sent. Nothing was sent.",
            tone: "warn",
          });
          await advance(APPROVE_HOLD_MS * 4);
          expect(apiMocks.approve).not.toHaveBeenCalled();
        } finally {
          rect.mockRestore();
        }
      });

      it("says so in a toast, in view or not, when the request is then drawn as a row decided elsewhere", async () => {
        approveAtOnce();
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
        // The reader sends the request back; its requester resubmits it and its card returns.
        await click(button(row("oldest"), "Request changes"));
        await typeText(row("oldest"), "Shorter please");
        await click(button(row("oldest"), "Send request"));
        await vi.waitFor(() => expect(row("oldest").textContent).toContain("Your note. Shorter please"));
        changeElsewhere("oldest", {
          status: "pending",
          decidedAt: null,
          decisionNote: null,
          updatedAt: LATER_STILL,
          payload: { title: "Request oldest", recommendedAction: "A shorter version." },
        });
        await reload();
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());

        // This time they approve it, and rest the pointer on the held row.
        await click(header(row("oldest"))!);
        await pastDoubleClick();
        await click(button(row("oldest"), "Approve"));
        await pointer("pointermove", row("oldest"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);

        // A colleague sends that version back before the approval goes out.
        const AGAIN = new Date("2026-10-06T11:00:00.000Z");
        changeElsewhere("oldest", {
          status: "revision_requested",
          decisionNote: "Wrong price",
          decidedAt: AGAIN,
          updatedAt: AGAIN,
        });
        await reload();
        await advance(1);
        expect(heldRows()).toHaveLength(0);
        // The row that takes the held row's place is a decided one, with no line for what happened
        // to the reader's approval: it is in view, and the toast is raised all the same.
        expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
        expect(row("oldest").textContent).toContain("Decided elsewhere");
        expect(alerts(row("oldest"))).toHaveLength(0);
        expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
        expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
          title: "Not approved: Request oldest",
          body: "It was sent back for changes before your approval was sent. Nothing was sent.",
          tone: "warn",
        });
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });

      it("moves focus from the Undo of a hold that is taken back to the card that returns", async () => {
        approveAtOnce();
        await render();
        await click(header(row("newest"))!);
        await pastDoubleClick();
        await click(button(row("newest"), "Approve"));
        // Focus on Undo holds the clock too.
        await act(async () => undoButton(row("newest"))!.focus());
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();

        changeElsewhere("newest", { status: "revision_requested", decidedAt: LATER, updatedAt: LATER });
        await reload();
        revise("newest", LATER_STILL);
        await reload();
        await vi.waitFor(() => expect(heldRows()).toHaveLength(0));
        // Not dropped to the page, and not opened under the reader either.
        expect(document.activeElement).toBe(row("newest"));
        expect(header(row("newest"))!.getAttribute("aria-expanded")).toBe("false");
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });

      it("still sends a held approval whose request did not change in substance, and leaves one on its way alone", async () => {
        let land: (approval: Approval) => void = () => {};
        apiMocks.approve.mockImplementation(
          () => new Promise<Approval>((resolve) => { land = resolve; }),
        );
        await render();
        await click(button(row("oldest"), "Approve"));
        await pointer("pointermove", row("oldest"));

        // A newer time with the same payload is not a revision.
        changeElsewhere("oldest", { updatedAt: LATER });
        await reload();
        // The reloaded list is drawn a moment after it arrives: only then does the page know of it.
        await advance(1);
        expect(holdStatus(row("oldest"))).toBe("Paused, 5s left");
        await pointer("pointerout", row("oldest"));
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(row("oldest").dataset.approvalHeldRow).toBe("sending");

        // A revision that shows up once the approval is on its way cannot take it back.
        revise("oldest", LATER_STILL);
        await reload();
        await advance(1);
        expect(row("oldest").dataset.approvalHeldRow).toBe("sending");
        expect(toastMock.pushToast).not.toHaveBeenCalled();
        await act(async () => land({ ...approvals.find((a) => a.id === "oldest")!, status: "approved" } as Approval));
        expect(announced()).toBe("Approved: Request oldest");
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });

      it("interrupts with the notice once, when the revision arrives, and not again each time the card is opened", async () => {
        await render();
        await click(header(row("newest"))!);
        revise("newest", LATER);
        await reload();
        await vi.waitFor(() => expect(notice("newest")).not.toBeNull());
        // It arrived under the reader: an alert.
        expect(notice("newest")!.querySelectorAll("[role='alert']")).toHaveLength(1);

        // Closing and opening the card draws the notice again. It is still there, and still names
        // the group focus goes to, but it does not speak up a second time.
        await click(header(row("oldest"))!);
        expect(row("newest").textContent).toContain(REVISED_ROW);
        await click(header(row("newest"))!);
        await pastDoubleClick();
        expect(notice("newest")!.dataset.approvalRevised).toBe("unreviewed");
        expect(notice("newest")!.querySelectorAll("[role='alert']")).toHaveLength(0);
        const labelled = document.getElementById(notice("newest")!.getAttribute("aria-labelledby")!)!;
        expect(labelled.textContent).toBe(
          "The requester revised this request while it was open. Review it before you decide.",
        );
        await click(button(row("newest"), "Approve"));
        expect(heldRows()).toHaveLength(0);
        expect(document.activeElement).toBe(notice("newest"));
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

      it("does not show the reader's own row and note for a request they sent back, that was resubmitted and then sent back again by someone else", async () => {
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

        // The requester resubmits it: its card returns.
        changeElsewhere("oldest", {
          status: "pending",
          decidedAt: null,
          decisionNote: null,
          updatedAt: LATER_STILL,
          payload: { title: "Request oldest", recommendedAction: "A shorter version." },
        });
        await reload();
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());

        // Another board member sends that version back, with another note.
        const AGAIN = new Date("2026-10-06T11:00:00.000Z");
        changeElsewhere("oldest", {
          status: "revision_requested",
          decisionNote: "Wrong price",
          decidedAt: AGAIN,
          updatedAt: AGAIN,
        });
        await reload();
        await vi.waitFor(() => expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true));
        expect(row("oldest").textContent).toContain("revision requested");
        expect(row("oldest").textContent).toContain("Decided elsewhere");
        expect(row("oldest").textContent).toContain("Decision note. Wrong price");
        expect(row("oldest").textContent).not.toContain("Shorter please");
        expect(row("oldest").textContent).not.toContain("Your note.");
      });
    });

    describe("the reader's own second decision on a request they sent back before", () => {
      const AGAIN = new Date("2026-10-06T11:00:00.000Z");
      /** Sends "oldest" back from this page; the requester resubmits it and its card returns. */
      const sendBackAndResubmit = async () => {
        await click(button(row("oldest"), "Request changes"));
        await typeText(row("oldest"), "Shorter please");
        await click(button(row("oldest"), "Send request"));
        await vi.waitFor(() => expect(row("oldest").textContent).toContain("Your note. Shorter please"));
        changeElsewhere("oldest", {
          status: "pending",
          decidedAt: null,
          decisionNote: null,
          updatedAt: LATER_STILL,
          payload: { title: "Request oldest", recommendedAction: "A shorter version." },
        });
        await reload();
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());
        await click(header(row("oldest"))!);
      };
      /** The server stores a decision at once; the answer to the page waits for `land`. */
      const storedBeforeAnswered = (status: Approval["status"]) => {
        let land: () => void = () => {};
        const answer = (id: string, note?: string) => {
          const decided = {
            ...approvals.find((approval) => approval.id === id)!,
            status,
            decisionNote: note ?? null,
            decidedAt: AGAIN,
            updatedAt: AGAIN,
          } as Approval;
          approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
          return new Promise<Approval>((resolve) => { land = () => resolve(decided); });
        };
        return { answer, land: () => act(async () => land()) };
      };
      const firstSendBack = async (id: string, note: string) => {
        const decided = {
          ...approvals.find((approval) => approval.id === id)!,
          status: "revision_requested",
          decisionNote: note,
          decidedAt: LATER,
          updatedAt: LATER,
        } as Approval;
        approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
        return decided;
      };

      it("is not called decided elsewhere when the list reloads before a second send-back is answered", async () => {
        const second = storedBeforeAnswered("revision_requested");
        apiMocks.requestRevision.mockImplementationOnce(firstSendBack).mockImplementation(second.answer);
        await render();
        await sendBackAndResubmit();

        await click(button(row("oldest"), "Request changes"));
        await typeText(row("oldest"), "Still too long");
        await click(button(row("oldest"), "Send request"));
        // The live update that follows the stored decision reloads the list before the request answers.
        await reload();
        await advance(1);
        expect(row("oldest").textContent).toContain("revision requested");
        expect(row("oldest").textContent).not.toContain("Decided elsewhere");
        expect(row("oldest").textContent).not.toContain("Decision note.");
        // The note is the one just sent, not the one sent the first time.
        expect(row("oldest").textContent).toContain("Your note. Still too long");
        expect(row("oldest").textContent).not.toContain("Shorter please");

        await second.land();
        await advance(1);
        expect(row("oldest").textContent).toContain("Your note. Still too long");
        expect(row("oldest").textContent).not.toContain("Decided elsewhere");
        expect(announced()).toBe("Changes requested: Request oldest");
      });

      it("is not called decided elsewhere when the list reloads before their rejection is answered", async () => {
        const rejection = storedBeforeAnswered("rejected");
        apiMocks.requestRevision.mockImplementationOnce(firstSendBack);
        apiMocks.reject.mockImplementation(rejection.answer);
        await render();
        await sendBackAndResubmit();

        await click(button(row("oldest"), "Reject"));
        await click(button(row("oldest"), "Reject request"));
        await reload();
        await advance(1);
        expect(row("oldest").textContent).toContain("rejected");
        expect(row("oldest").textContent).not.toContain("Decided elsewhere");

        await rejection.land();
        await advance(1);
        expect(row("oldest").textContent).toContain("rejected");
        expect(row("oldest").textContent).not.toContain("Decided elsewhere");
      });

      it("is said in a toast, row in view or not, when the server refuses their approval because a colleague sent the request back", async () => {
        apiMocks.requestRevision.mockImplementationOnce(firstSendBack);
        // A colleague sends the resubmitted version back, and no reload reaches the page before the hold ends.
        apiMocks.approve.mockImplementation(async (id: string) => {
          changeElsewhere(id, { status: "revision_requested", decisionNote: "Wrong price", decidedAt: AGAIN, updatedAt: AGAIN });
          throw refusal("revision_requested", AGAIN);
        });
        await render();
        await sendBackAndResubmit();
        await pastDoubleClick();
        await click(button(row("oldest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
        await advance(APPROVE_HOLD_MS);

        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        expect(heldRows()).toHaveLength(0);
        // The row is drawn as one decided elsewhere, which has no line for the approval that was not
        // sent: the toast says it, though the row is in view.
        expect(row("oldest").textContent).toContain("Decided elsewhere");
        expect(alerts(row("oldest"))).toHaveLength(0);
        expect(toastMock.pushToast).toHaveBeenCalledTimes(1);
        expect(toastMock.pushToast.mock.calls[0][0]).toMatchObject({
          title: "Not approved: Request oldest",
          body: "It was sent back for changes before your approval was sent. Nothing was sent.",
          tone: "warn",
        });
      });
    });

    describe("a held approval the server refuses because no reload showed the change in time", () => {
      it("is the reader's own approval when their first send was stored and answered with an error", async () => {
        // The first send is stored and its answer is lost; the second is refused for the stored one.
        apiMocks.approve.mockImplementationOnce(async (id: string) => {
          changeElsewhere(id, { status: "approved", decidedAt: LATER, updatedAt: LATER });
          throw new Error("Network down");
        });
        apiMocks.approve.mockImplementation(async () => {
          throw refusal("approved", LATER);
        });
        await render();
        await click(button(row("oldest"), "Approve"));
        // No reload answers before the second hold ends.
        const answerReloads = holdReloads();
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(header(row("oldest"))).not.toBeNull());
        if (!openIds().includes("oldest")) await click(header(row("oldest"))!);
        await pastDoubleClick();
        await click(button(row("oldest"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(2);

        // Their own decision: counted, and nothing is said about another session or "nothing was sent".
        const own = () => {
          expect(heldRows()).toHaveLength(0);
          expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
          expect(row("oldest").textContent).toContain("approved");
          expect(row("oldest").textContent).not.toContain("Decided elsewhere");
          expect(announced()).toBe("Approved: Request oldest");
          expect(progress()).toContain("1 decided this visit");
        };
        own();
        expect(toastMock.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "warn" }));
        await answerReloads();
        own();
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).toHaveBeenCalledTimes(2);
      });

      it("moves focus from the held row to the card that returns in its place", async () => {
        apiMocks.approve.mockImplementation(async (id: string) => {
          changeElsewhere(id, {
            updatedAt: LATER,
            payload: { title: "Request oldest", recommendedAction: "Another plan." },
          });
          throw refusal("pending", LATER);
        });
        await render();
        await click(button(row("oldest"), "Approve"));
        // Focus on Undo holds the clock for thirty seconds at most; then the approval is sent.
        await act(async () => undoButton(row("oldest"))!.focus());
        await advance(APPROVE_PAUSE_LIMIT_MS + APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
        await advance(1);

        expect(heldRows()).toHaveLength(0);
        expect(alerts(row("oldest"))[0].textContent).toBe(
          "Not approved. The requester revised this request before your approval was sent.",
        );
        // Not dropped to the page, and not opened under the reader either.
        expect(document.activeElement).toBe(row("oldest"));
        expect(header(row("oldest"))!.getAttribute("aria-expanded")).toBe("false");
      });

      it("shows the status the server named before the reload answers, and keeps the typed note", async () => {
        apiMocks.approve.mockImplementation(async (id: string) => {
          changeElsewhere(id, { status: "rejected", decisionNote: "No longer needed", decidedAt: LATER, updatedAt: LATER });
          throw refusal("rejected", LATER);
        });
        await render();
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        await click(button(row("oldest"), "Approve"));
        const answerReloads = holdReloads();
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);

        // The reload has not answered: the row already has the status of the refusal, as someone else's decision.
        expect(heldRows()).toHaveLength(0);
        expect(row("oldest").textContent).toContain("rejected");
        expect(row("oldest").textContent).toContain("Decided elsewhere");
        expect(row("oldest").textContent).not.toContain("Your note.");
        expect(button(row("oldest"), "Approve")).toBeUndefined();

        await answerReloads();
        expect(row("oldest").textContent).toContain("Decision note. No longer needed");

        // Pending again later: its card returns with the note that was typed with the approval.
        changeElsewhere("oldest", { status: "pending", decidedAt: null, decisionNote: null, updatedAt: LATER_STILL });
        await reload();
        await advance(1);
        if (!openIds().includes("oldest")) await click(header(row("oldest"))!);
        expect(field("oldest")!.value).toBe("Month to month only");
        expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      });
    });

    describe("a held approval that is undone after its request was decided somewhere else", () => {
      it("keeps the request as a row with its real status, and leaves the card being read open", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        // The reader has moved on and is typing a rejection reason in the next request.
        expect(openIds()).toEqual(["email"]);
        await click(button(row("email"), "Reject"));
        await typeText(row("email"), "Too expensive");
        const typing = field("email")!;

        // Someone else rejects the held request. The reload has reached the loaded list, and the
        // reader presses Undo before the page has drawn it.
        changeElsewhere("oldest", { status: "rejected", decisionNote: "No longer needed", decidedAt: LATER, updatedAt: LATER });
        await reload();
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);

        await click(undoButton(row("oldest"))!);
        await advance(1);
        expect(heldRows()).toHaveLength(0);
        // There is no card to return to: the request keeps its place, with the status the server holds.
        expect(order()).toEqual(["oldest", "email", "newest"]);
        expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
        expect(row("oldest").textContent).toContain("rejected");
        expect(row("oldest").textContent).toContain("Decided elsewhere");
        expect(row("oldest").textContent).toContain("Decision note. No longer needed");
        expect(announced()).toBe(
          "Not approved: Request oldest. Nothing was sent. Its status is now rejected: decided elsewhere.",
        );
        // The card the reader is at is still open, with what they typed; focus is on the row, not on the page.
        expect(openIds()).toEqual(["email"]);
        expect(field("email")).toBe(typing);
        expect(typing.value).toBe("Too expensive");
        expect(document.activeElement).toBe(row("oldest"));
        expect(progress()).toBeNull();

        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });

      it("leaves Approve on the card being read working at once: Undo is the reader's own act", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Approve"));
        // The page has just opened the next request by itself: its Approve waits a moment.
        expect(openIds()).toEqual(["email"]);

        changeElsewhere("oldest", { status: "rejected", decidedAt: LATER, updatedAt: LATER });
        await reload();
        await click(undoButton(row("oldest"))!);
        await advance(1);
        expect(toastMock.pushToast).not.toHaveBeenCalled();
        expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
        expect(openIds()).toEqual(["email"]);

        // The reader has acted since: that moment is over, as after any Undo.
        await click(button(row("email"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);
      });

      it("does so too when the reload has arrived and is not drawn yet, and the card returns with its note once the request is resubmitted", async () => {
        approveAtOnce();
        await render();
        await click(button(row("oldest"), "Add a note"));
        await typeText(row("oldest"), "Month to month only");
        await click(button(row("oldest"), "Approve"));
        expect(openIds()).toEqual(["email"]);

        // Sent back elsewhere. The reload has reached the loaded list; the page has not drawn it yet.
        changeElsewhere("oldest", { status: "revision_requested", decidedAt: LATER, updatedAt: LATER });
        await reload();
        expect(container.querySelector("[data-tab='pending']")!.textContent).toBe("To decide3");
        await press("Z", document, { shiftKey: true });

        expect(heldRows()).toHaveLength(0);
        expect(announced()).toBe(
          "Not approved: Request oldest. Nothing was sent. Its status is now revision requested: decided elsewhere.",
        );
        await advance(1);
        expect(order()).toEqual(["oldest", "email", "newest"]);
        expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
        expect(row("oldest").textContent).toContain("revision requested");
        expect(row("oldest").textContent).toContain("Decided elsewhere");
        expect(container.querySelector("[data-approval-sent-back-section]")).toBeNull();
        expect(openIds()).toEqual(["email"]);
        expect(document.activeElement).toBe(row("oldest"));

        // Resubmitted: it is a card again, closed, marked revised, and the note typed with the approval is kept.
        changeElsewhere("oldest", {
          status: "pending",
          decidedAt: null,
          updatedAt: LATER_STILL,
          payload: { title: "Request oldest", recommendedAction: "Order ten times the standing quantity." },
        });
        await reload();
        await advance(1);
        expect(header(row("oldest"))!.getAttribute("aria-expanded")).toBe("false");
        expect(row("oldest").textContent).toContain("Revised while this page was open");
        expect(unsentNote("oldest")).toBe("Note not sent");
        await advance(APPROVE_HOLD_MS * 4);
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });
    });

    it("corrects and reloads the list of the request's own company when a rejection lands after a change of company", async () => {
      // As the app sets it: a list is not fetched again for thirty seconds.
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000, staleTime: 30_000 } } });
      const otherCompany = [createApproval("other", "2026-09-25T00:00:00.000Z", { companyId: "company-2" })];
      apiMocks.list.mockImplementation(async (companyId: string) => (companyId === "company-2" ? otherCompany : approvals));
      let land: () => void = () => {};
      apiMocks.reject.mockImplementation(
        (id: string) =>
          new Promise<Approval>((resolve) => {
            land = () => {
              const decided = {
                ...approvals.find((approval) => approval.id === id)!,
                status: "rejected",
                decidedAt: LATER,
                updatedAt: LATER,
              } as Approval;
              approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
              resolve(decided);
            };
          }),
      );
      await render();
      await click(button(row("oldest"), "Reject"));
      await click(button(row("oldest"), "Reject request"));

      // The reader changes company before the rejection answers.
      companyMock.selectedCompanyId = "company-2";
      await rerender();
      await vi.waitFor(() => expect(order()).toEqual(["other"]));
      await act(async () => land());
      await advance(1);
      // The other company's list is neither corrected nor fetched again for it.
      expect(order()).toEqual(["other"]);
      expect(apiMocks.list.mock.calls.map((call) => call[0])).toEqual(["company-1", "company-2"]);

      // Back within the thirty seconds: the rejected request is not offered again, before any reload.
      companyMock.selectedCompanyId = "company-1";
      await rerender();
      expect(order()).toEqual(["email", "newest"]);
      expect(container.querySelector("[data-tab='pending']")!.textContent).toBe("To decide2");
      // And its list, marked out of date when the rejection landed, is fetched again.
      await advance(1);
      expect(apiMocks.list.mock.calls.map((call) => call[0])).toEqual(["company-1", "company-2", "company-1"]);
    });

    it("reloads the list of the request's own company when a rejection fails after a change of company", async () => {
      // As the app sets it: a list is not fetched again for thirty seconds.
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000, staleTime: 30_000 } } });
      const otherCompany = [createApproval("other", "2026-09-25T00:00:00.000Z", { companyId: "company-2" })];
      apiMocks.list.mockImplementation(async (companyId: string) => (companyId === "company-2" ? otherCompany : approvals));
      let fail: () => void = () => {};
      apiMocks.reject.mockImplementation(
        () => new Promise<Approval>((_resolve, reject) => { fail = () => reject(new Error("Session expired")); }),
      );
      await render();
      await click(button(row("oldest"), "Reject"));
      await click(button(row("oldest"), "Reject request"));

      // The reader changes company before the rejection comes back as an error.
      companyMock.selectedCompanyId = "company-2";
      await rerender();
      await vi.waitFor(() => expect(order()).toEqual(["other"]));
      await act(async () => fail());
      await advance(1);
      // The other company's list is not fetched again for it.
      expect(order()).toEqual(["other"]);
      expect(apiMocks.list.mock.calls.map((call) => call[0])).toEqual(["company-1", "company-2"]);

      // An error does not prove the rejection was not stored. Back within the thirty seconds, the
      // request's own list, marked out of date when the error came, is fetched again.
      companyMock.selectedCompanyId = "company-1";
      await rerender();
      await advance(1);
      expect(apiMocks.list.mock.calls.map((call) => call[0])).toEqual(["company-1", "company-2", "company-1"]);
    });

    describe("an outgoing email whose draft is cut", () => {
      const ENDING = "We will ship the same day and split the order at no extra charge.";
      const READ_TO_APPROVE = "Read full reply to approve";
      const longDraft = () => {
        const body = `Hi Sam,\n\n${"Our wholesale terms are in the attached price list. ".repeat(60)}\n\n${ENDING}`;
        approvals = approvals.map((approval) =>
          approval.id === "email"
            ? { ...approval, payload: { ...(approval.payload as Record<string, unknown>), body } }
            : approval);
      };
      const labels = (id: string) => [...row(id).querySelectorAll("button")].map((candidate) => candidate.textContent);

      it("is never held for approval before the whole draft is on the page, by button or Shift+A, and again after Undo", async () => {
        approveAtOnce();
        longDraft();
        await render();
        await click(header(row("email"))!);
        await pastDoubleClick();
        expect(row("email").textContent).not.toContain(ENDING);
        expect(labels("email")).toContain(READ_TO_APPROVE);
        expect(labels("email")).not.toContain("Approve");

        // The first press, by the key, opens the draft and holds nothing.
        await press("A", row("email"), { shiftKey: true });
        expect(heldRows()).toHaveLength(0);
        expect(row("email").textContent).toContain(ENDING);
        expect(row("email").querySelector("[data-approval-held-back]")!.textContent).toBe(
          "Read the full reply, then approve.",
        );
        expect(labels("email")).toContain("Approve");

        // Cutting the draft again arms the stop again, for the button as for the key.
        await click(button(row("email"), "Show less"));
        expect(row("email").textContent).not.toContain(ENDING);
        await click(button(row("email"), READ_TO_APPROVE));
        expect(heldRows()).toHaveLength(0);
        expect(row("email").textContent).toContain(ENDING);

        // Closing the card and opening it again shows the draft as the reader left it: whole.
        await click(header(row("oldest"))!);
        await click(header(row("email"))!);
        await pastDoubleClick();
        expect(row("email").textContent).toContain(ENDING);
        await click(button(row("email"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);

        // Undo draws the card afresh, with its draft cut: the next Approve opens it again and sends nothing.
        await click(undoButton(row("email"))!);
        expect(row("email").textContent).not.toContain(ENDING);
        await click(button(row("email"), READ_TO_APPROVE));
        await press("Z", document, { shiftKey: true });
        expect(heldRows()).toHaveLength(0);
        await advance(APPROVE_HOLD_MS * 3);
        expect(apiMocks.approve).not.toHaveBeenCalled();
      });

      it("is stopped the same way in the Full cards view", async () => {
        approveAtOnce();
        longDraft();
        chooseFullCards();
        await render();
        expect(row("email").textContent).not.toContain(ENDING);
        await click(button(row("email"), READ_TO_APPROVE));
        expect(heldRows()).toHaveLength(0);
        expect(row("email").textContent).toContain(ENDING);
        await press("A", row("email"), { shiftKey: true });
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);
      });

      it("is stopped the same way under All decisions", async () => {
        approveAtOnce();
        longDraft();
        routerMock.location.pathname = "/approvals/all";
        await render("Request email");
        await click(header(row("email"))!);
        await pastDoubleClick();
        expect(row("email").textContent).not.toContain(ENDING);
        await press("A", row("email"), { shiftKey: true });
        expect(heldRows()).toHaveLength(0);
        expect(row("email").textContent).toContain(ENDING);
        await click(button(row("email"), "Approve"));
        expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);
        await advance(APPROVE_HOLD_MS);
        expect(apiMocks.approve.mock.calls).toEqual([["email", undefined, heldFor("email")]]);
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

    describe("finding a request and coming back to it", () => {
      const searchField = () => container.querySelector<HTMLInputElement>("input[data-page-search-target='true']")!;
      /** Types a term into the search field above the list. */
      const search = (value: string) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(searchField(), value);
          searchField().dispatchEvent(new Event("input", { bubbles: true }));
        });
      /** What the status beside the search field says; null while it says nothing. */
      const found = () => container.querySelector("[data-approval-search-count][role='status']")!.textContent || null;
      /** The number each kind chip shows, by kind. */
      const chipCounts = () =>
        Object.fromEntries(
          [...container.querySelectorAll<HTMLElement>("button[data-approval-kind]")].map((chip) => [
            chip.dataset.approvalKind,
            chip.querySelector("[data-approval-kind-count]")!.firstChild!.textContent,
          ]),
        );
      /** The page is opened anew, as after a reload of the browser or a way back from another page. */
      const openAgain = async (firstTitle = "Request oldest") => {
        act(() => root.unmount());
        root = createRoot(container);
        await render(firstTitle);
      };
      /** What a "View details" link carries to the page it opens. */
      const carried = (link: Element | null | undefined) => JSON.parse(link?.getAttribute("data-link-state") ?? "null");
      const detailsLink = (scope: ParentNode) =>
        [...scope.querySelectorAll("a")].find((anchor) => anchor.textContent === "View details");

      describe("the search field", () => {
        beforeEach(() => {
          apiMocks.agentsList.mockResolvedValue([
            { id: "agent-requester", name: "Operations Lead" },
            { id: "agent-pricing", name: "Pricing Analyst" },
          ]);
          approvals = [
            ...approvals,
            createApproval("hosting", "2026-09-25T00:00:00.000Z", {
              requestedByAgentId: "agent-pricing",
              payload: {
                title: "Staging hosting",
                summary: "Costs 40 dollars a month.",
                recommendedAction: "Sign with Provider X.",
                reasoning: "It is the cheapest offer.",
              },
            }),
          ];
        });

        it("narrows the queue by subject, requester, summary and recommendation, whatever the case", async () => {
          await render();
          expect(order()).toEqual(["oldest", "hosting", "email", "newest"]);
          expect(searchField().getAttribute("aria-label")).toBe(
            "Search requests by subject, requester, summary or recommendation",
          );
          expect(found()).toBeNull();

          // The subject.
          await search("  REQUEST EMAIL ");
          expect(order()).toEqual(["email"]);
          expect(found()).toBe("1 found");
          // The requester's name, from the company's agents.
          await search("pricing analyst");
          expect(order()).toEqual(["hosting"]);
          await search("operations");
          expect(order()).toEqual(["oldest", "email", "newest"]);
          expect(found()).toBe("3 found");
          // The summary.
          await search("40 DOLLARS");
          expect(order()).toEqual(["hosting"]);
          // The recommendation.
          await search("provider x");
          expect(order()).toEqual(["hosting"]);
          await search("send the reply");
          expect(order()).toEqual(["email"]);
          // The rationale is not searched.
          await search("cheapest offer");
          expect(order()).toEqual([]);
          expect(found()).toBe("None found");
          expect(container.textContent).toContain("No request matches the search.");
          expect(container.textContent).not.toContain("Nothing needs a decision.");
          // The field is still there to change the term.
          await search("");
          expect(order()).toEqual(["oldest", "hosting", "email", "newest"]);
          expect(found()).toBeNull();
          // The term is not written into the address.
          expect(routerMock.location.search).toBe("");
          expect(routerMock.searchChanges).toEqual([]);
        });

        it("lists what it finds as closed rows, and opens the first card again once the term is cleared", async () => {
          approveAtOnce();
          await render();
          expect(openIds()).toEqual(["oldest"]);

          await search("request");
          expect(order()).toEqual(["oldest", "email", "newest"]);
          // Nothing is open, so nothing can be decided until the reader opens a row.
          expect(openIds()).toEqual([]);
          expect(approveButtons()).toHaveLength(0);
          expect(container.querySelector("textarea")).toBeNull();
          await act(async () => row("oldest").focus());
          await press("A", row("oldest"), { shiftKey: true });
          expect(heldRows()).toHaveLength(0);
          // Focus in the list does not open one either.
          expect(openIds()).toEqual([]);

          // A row the reader opens is decided as usual, and the next result opens after it.
          await click(header(row("email"))!);
          expect(openIds()).toEqual(["email"]);
          await advance(APPROVE_AFTER_ADVANCE_MS);
          await click(button(row("email"), "Approve"));
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["email"]);
          expect(openIds()).toEqual(["newest"]);

          await click(undoButton(row("email"))!);
          await search("");
          expect(order()).toEqual(["oldest", "hosting", "email", "newest"]);
          expect(openIds()).toEqual(["oldest"]);
          await advance(APPROVE_HOLD_MS * 2);
          expect(apiMocks.approve).not.toHaveBeenCalled();
        });

        it("lists closed rows in the Full cards view too, for as long as a term is set", async () => {
          chooseFullCards();
          await render();
          expect(approveButtons()).toHaveLength(4);

          await search("request");
          expect(order()).toEqual(["oldest", "email", "newest"]);
          expect(openIds()).toEqual([]);
          expect(approveButtons()).toHaveLength(0);

          await search("");
          expect(approveButtons()).toHaveLength(4);
        });

        it("opens no card when the kind or the order is changed while a term is set", async () => {
          await render();
          await search("request");

          await click(button(container, "Email replies"));
          expect(order()).toEqual(["email"]);
          expect(openIds()).toEqual([]);
          await click(button(container, "All"));
          await click(button(container, "Sort: Oldest first"));
          expect(order()).toEqual(["newest", "email", "oldest"]);
          expect(openIds()).toEqual([]);
          expect(approveButtons()).toHaveLength(0);
        });

        it("keeps a held approval with its Undo, and the card an undo brings back, whatever the term", async () => {
          approveAtOnce();
          await render();
          await click(button(row("oldest"), "Add a note"));
          await typeText(row("oldest"), "Month to month only");
          await click(button(row("oldest"), "Approve"));
          expect(holdStatus(row("oldest"))).toBe("Approving in 5s");

          await search("hosting");
          // The held request does not hold the term, but its Undo must stay within reach.
          expect(order()).toEqual(["oldest", "hosting"]);
          expect(undoButton(row("oldest"))).not.toBeNull();
          expect(openIds()).toEqual([]);
          // Searching sends nothing early.
          expect(apiMocks.approve).not.toHaveBeenCalled();

          await click(undoButton(row("oldest"))!);
          // The undone card returns open, with its note, and stays listed as the open card.
          expect(order()).toEqual(["oldest", "hosting"]);
          expect(openIds()).toEqual(["oldest"]);
          expect(field("oldest")!.value).toBe("Month to month only");
          await advance(APPROVE_HOLD_MS * 3);
          expect(apiMocks.approve).not.toHaveBeenCalled();
        });

        it("sends a held approval once when its time is up, also while a term hides its kind of request", async () => {
          approveAtOnce();
          await render();
          await click(button(row("oldest"), "Approve"));
          await search("hosting");
          await search("hosting co");
          await search("");

          expect(apiMocks.approve).not.toHaveBeenCalled();
          await advance(APPROVE_HOLD_MS);
          expect(apiMocks.approve).toHaveBeenCalledExactlyOnceWith("oldest", undefined, heldFor("oldest"));
        });

        it("keeps a request whose approval failed on the page, with its error, whatever the term", async () => {
          apiMocks.approve.mockRejectedValue(new Error("Session expired"));
          await render();
          await click(button(row("oldest"), "Approve"));
          await search("hosting");

          await advance(APPROVE_HOLD_MS);
          expect(apiMocks.approve).toHaveBeenCalledTimes(1);
          expect(order()).toEqual(["oldest", "hosting"]);
          expect(alerts(row("oldest"))[0].textContent).toBe("Error while approving: Session expired");
          // The reader was typing a term: the failed card is not opened under them.
          expect(openIds()).toEqual([]);
        });

        it("keeps what was typed in a card through a search", async () => {
          await render();
          await click(button(row("oldest"), "Request changes"));
          await typeText(row("oldest"), "Quote the delivery date");

          await search("hosting");
          expect(order()).toEqual(["hosting"]);
          await search("request o");
          // Found again as a closed row, which says a text is waiting in it.
          expect(order()).toEqual(["oldest"]);
          expect(unsentNote("oldest")).toBe("Change request not sent");

          await search("");
          expect(openIds()).toEqual(["oldest"]);
          expect(field("oldest")!.value).toBe("Quote the delivery date");
          expect(row("oldest").textContent).toContain("What should change?");
        });

        it("starts the page size again, so a term does not list every request it finds at once", async () => {
          approvals = pendingRequests(45);
          const showMore = () =>
            [...container.querySelectorAll("button")].find((candidate) => /^Show \d+ more$/.test(candidate.textContent ?? ""));
          await render("Request r01");
          await click(showMore()!);
          expect(rows()).toHaveLength(40);

          await search("request r");
          expect(found()).toBe("45 found");
          expect(rows()).toHaveLength(20);
          expect(openIds()).toEqual([]);
          expect(showMore()!.textContent).toBe("Show 20 more");
        });

        it("is where the app's / key puts focus, and J, K and Shift+Z leave it alone", async () => {
          approveAtOnce();
          await render();
          expect(searchField().getAttribute("data-page-search-target")).toBe("true");
          await click(button(row("oldest"), "Approve"));
          expect(heldRows()).toHaveLength(1);
          const openBefore = openIds();

          await act(async () => searchField().focus());
          await press("j", searchField());
          await press("k", searchField());
          await press("Z", searchField(), { shiftKey: true });
          expect(document.activeElement).toBe(searchField());
          expect(openIds()).toEqual(openBefore);
          expect(heldRows()).toHaveLength(1);

          // Escape leaves the field once it is empty; a term is not thrown away by it.
          await search("hosting");
          await press("Escape", searchField());
          expect(document.activeElement).toBe(searchField());
          expect(searchField().value).toBe("hosting");
          await search("");
          await press("Escape", searchField());
          expect(document.activeElement).not.toBe(searchField());
          // Enter leaves the field, and the keys work again from there.
          await act(async () => searchField().focus());
          await press("Enter", searchField());
          expect(document.activeElement).not.toBe(searchField());
          await press("Z", document, { shiftKey: true });
          expect(heldRows()).toHaveLength(0);
          expect(apiMocks.approve).not.toHaveBeenCalled();
        });

        it("counts only the chosen kind in what it found", async () => {
          await render();
          await search("request");
          expect(found()).toBe("3 found");
          await click(button(container, "Email replies"));
          expect(order()).toEqual(["email"]);
          expect(found()).toBe("1 found");
        });

        it("leaves the open result open when only a space is typed after the term", async () => {
          await render();
          await search("request");
          await click(header(row("email"))!);
          expect(openIds()).toEqual(["email"]);
          await search("request ");
          expect(searchField().value).toBe("request ");
          expect(openIds()).toEqual(["email"]);
        });

        it("makes Approve wait on the card the page opens when the term is cleared", async () => {
          approveAtOnce();
          await render();
          await search("request");
          expect(approveButtons()).toHaveLength(0);

          // The first card is drawn open again, maybe under a pointer that rested on a result.
          await search("");
          expect(openIds()).toEqual(["oldest"]);
          await click(button(row("oldest"), "Approve"));
          expect(heldRows()).toHaveLength(0);
          await pastDoubleClick();
          await click(button(row("oldest"), "Approve"));
          expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
        });

        it("keeps a held approval that is decided elsewhere listed as that row under any term or kind", async () => {
          approveAtOnce();
          await render();
          await click(button(row("oldest"), "Approve"));
          // During the hold the reader searches for another request.
          await search("hosting");
          expect(order()).toEqual(["oldest", "hosting"]);
          changeElsewhere("oldest", { status: "rejected", decisionNote: "No longer needed", decidedAt: LATER, updatedAt: LATER });
          await reload();
          await advance(1);

          expect(heldRows()).toHaveLength(0);
          expect(order()).toEqual(["oldest", "hosting"]);
          expect(row("oldest").textContent).toContain("rejected");
          expect(row("oldest").textContent).toContain("Decided elsewhere");
          // Under another kind too.
          await search("");
          await click(button(container, "Email replies"));
          expect(order()).toEqual(["oldest", "email"]);
          expect(row("oldest").textContent).toContain("Decided elsewhere");
          await advance(APPROVE_HOLD_MS * 4);
          expect(apiMocks.approve).not.toHaveBeenCalled();
        });

        it("stays on the page while a term is set, also when the tab lists nothing any more", async () => {
          approvals = approvals.filter((approval) => approval.id === "oldest" || approval.id === "done");
          await render();
          await search("oldest");
          expect(order()).toEqual(["oldest"]);
          changeElsewhere("oldest", { status: "cancelled", updatedAt: LATER });
          await reload();
          await vi.waitFor(() => expect(order()).toEqual([]));

          // The term can still be read and cleared.
          expect(searchField()).not.toBeNull();
          expect(searchField().value).toBe("oldest");
          await search("");
          expect(container.textContent).toContain("Nothing needs a decision.");
        });

        it("is emptied by a change of tab", async () => {
          await render();
          await search("hosting");
          expect(order()).toEqual(["hosting"]);

          routerMock.location.pathname = "/approvals/all";
          await rerender();
          expect(searchField().value).toBe("");
          expect(order()).toEqual(["newest", "email", "hosting", "oldest", "done"]);
        });

        it("counts on each kind chip the undecided requests of that kind, and follows decisions and the term", async () => {
          approveAtOnce();
          await render();
          expect(chipCounts()).toEqual({ all: "4", request_board_approval: "3", email_reply: "1" });
          // The chip is still found and named by its label.
          expect(button(container, "Email replies").textContent).toBe("Email replies1 to decide");

          // A held approval counts as decided; undoing it brings the request back into the count.
          await click(button(row("oldest"), "Approve"));
          expect(chipCounts()).toEqual({ all: "3", request_board_approval: "2", email_reply: "1" });
          await click(undoButton(row("oldest"))!);
          expect(chipCounts()).toEqual({ all: "4", request_board_approval: "3", email_reply: "1" });

          await advance(APPROVE_AFTER_ADVANCE_MS);
          await click(button(row("oldest"), "Approve"));
          await advance(APPROVE_HOLD_MS);
          expect(row("oldest").hasAttribute("data-approval-decided-row")).toBe(true);
          expect(chipCounts()).toEqual({ all: "3", request_board_approval: "2", email_reply: "1" });

          // A term narrows the numbers as it narrows the list. The decided row is not counted.
          await search("request");
          expect(chipCounts()).toEqual({ all: "2", request_board_approval: "1", email_reply: "1" });
          await search("hosting");
          expect(chipCounts()).toEqual({ all: "1", request_board_approval: "1", email_reply: "0" });
        });

        it("counts every listed request of a kind under All decisions", async () => {
          routerMock.location.pathname = "/approvals/all";
          await render();
          // The approved request is counted here: the tab lists it.
          expect(chipCounts()).toEqual({ all: "5", request_board_approval: "4", email_reply: "1" });
          expect(button(container, "All").textContent).toBe("All5 listed");
        });
      });

      describe("the order of All decisions", () => {
        const WEEK_AGO = new Date("2026-09-28T09:00:00.000Z");
        const YESTERDAY = new Date("2026-10-04T09:00:00.000Z");
        beforeEach(() => {
          routerMock.location.pathname = "/approvals/all";
          approvals = [
            // Filed long ago and decided yesterday.
            createApproval("old-late", "2026-08-01T00:00:00.000Z", { status: "approved", decidedAt: YESTERDAY }),
            // Filed later and decided a week ago.
            createApproval("new-early", "2026-09-27T00:00:00.000Z", { status: "rejected", decidedAt: WEEK_AGO }),
            // Still waiting: it has no decision, so it is placed by the time it was filed.
            createApproval("waiting", "2026-10-01T00:00:00.000Z"),
            createApproval("waiting-long", "2026-09-10T00:00:00.000Z"),
          ];
        });

        it("reads by the time of the last decision, latest first", async () => {
          await render("Request old-late");
          expect(order()).toEqual(["old-late", "waiting", "new-early", "waiting-long"]);
          expect(button(container, "Sort: Newest first")).toBeDefined();
        });

        it("is reversed by the Sort button", async () => {
          await render("Request old-late");
          await click(button(container, "Sort: Newest first"));
          expect(order()).toEqual(["waiting-long", "new-early", "waiting", "old-late"]);
        });

        it("still orders To decide by the time a request was filed", async () => {
          routerMock.location.pathname = "/approvals/pending";
          await render("Request waiting-long");
          expect(order()).toEqual(["waiting-long", "waiting"]);
        });

        it("keeps a request decided in this tab in its place, until the tab is changed", async () => {
          apiMocks.reject.mockImplementation(async (id: string) => {
            const decided = {
              ...approvals.find((approval) => approval.id === id)!,
              status: "rejected",
              decidedAt: new Date(),
              updatedAt: new Date(),
            } as Approval;
            approvals = approvals.map((approval) => (approval.id === id ? decided : approval));
            return decided;
          });
          await render("Request old-late");
          await click(header(row("waiting-long"))!);
          await click(button(row("waiting-long"), "Reject"));
          await click(button(row("waiting-long"), "Reject request"));
          await vi.waitFor(() => expect(row("waiting-long").hasAttribute("data-approval-decided-row")).toBe(true));

          // Its decision is now the latest of all, and the reloaded list says so. The row does not move.
          await reload();
          expect(order()).toEqual(["old-late", "waiting", "new-early", "waiting-long"]);
          expect(document.activeElement).toBe(row("waiting-long"));

          // On the next visit to the tab it leads the history.
          routerMock.location.pathname = "/approvals/pending";
          await rerender();
          routerMock.location.pathname = "/approvals/all";
          await rerender();
          expect(order()).toEqual(["waiting-long", "old-late", "waiting", "new-early"]);
        });

        it("keeps a request whose approval is held, on its way or failed in its place", async () => {
          let fail: (error: Error) => void = () => {};
          apiMocks.approve.mockImplementation(
            () => new Promise<Approval>((_resolve, reject) => { fail = reject; }),
          );
          await render("Request old-late");
          await click(header(row("waiting-long"))!);
          await advance(APPROVE_AFTER_ADVANCE_MS);
          await click(button(row("waiting-long"), "Approve"));
          expect(heldRows()).toHaveLength(1);
          await advance(APPROVE_HOLD_MS);
          expect(apiMocks.approve).toHaveBeenCalledTimes(1);

          // The server has stored it before the request answers: the list now carries a decision time for it.
          changeElsewhere("waiting-long", { status: "approved", decidedAt: new Date(), updatedAt: new Date() });
          await reload();
          await advance(1);
          expect(apiMocks.approve).toHaveBeenCalledTimes(1);
          expect(order()).toEqual(["old-late", "waiting", "new-early", "waiting-long"]);

          await act(async () => fail(new Error("Session expired")));
          await vi.waitFor(() => expect(alerts(row("waiting-long"))).toHaveLength(1));
          expect(order()).toEqual(["old-late", "waiting", "new-early", "waiting-long"]);
        });

        it("keeps a request in its place when its held approval is taken back because it was decided elsewhere", async () => {
          approveAtOnce();
          await render("Request old-late");
          await click(header(row("waiting-long"))!);
          await advance(APPROVE_AFTER_ADVANCE_MS);
          await click(button(row("waiting-long"), "Approve"));
          expect(heldRows()).toHaveLength(1);

          // Someone else approves it during the hold: its decision is now the latest of all.
          changeElsewhere("waiting-long", { status: "approved", decidedAt: new Date(), updatedAt: new Date() });
          await reload();
          await advance(1);
          expect(heldRows()).toHaveLength(0);
          expect(row("waiting-long").textContent).toContain("Decided elsewhere");
          expect(order()).toEqual(["old-late", "waiting", "new-early", "waiting-long"]);
          await advance(APPROVE_HOLD_MS * 4);
          expect(apiMocks.approve).not.toHaveBeenCalled();
        });
      });

      describe("the kind filter and the sort in the address", () => {
        it("reads both from the address when the page opens", async () => {
          routerMock.location.search = "?kind=email_reply&sort=newest";
          await render("Request email");
          expect(order()).toEqual(["email"]);
          expect(openIds()).toEqual(["email"]);
          expect(button(container, "Email replies").getAttribute("aria-pressed")).toBe("true");
          expect(button(container, "Sort: Newest first")).toBeDefined();

          routerMock.location.search = "?sort=newest";
          await openAgain();
          expect(order()).toEqual(["newest", "email", "oldest"]);
          expect(openIds()).toEqual(["newest"]);
          expect(button(container, "All").getAttribute("aria-pressed")).toBe("true");
        });

        it("shows every kind, in the default order, for values it does not know", async () => {
          routerMock.location.search = "?kind=no_such_kind&sort=sideways";
          await render();
          expect(order()).toEqual(["oldest", "email", "newest"]);
          expect(button(container, "All").getAttribute("aria-pressed")).toBe("true");
          expect(button(container, "Sort: Oldest first")).toBeDefined();
        });

        it("drops a kind the tab does not list from the address, so a later reload cannot narrow the queue", async () => {
          // The way back from the page of the last email reply, approved there.
          changeElsewhere("email", { status: "approved", decidedAt: LATER, updatedAt: LATER });
          const carried = { queue: "/approvals/pending?from=mail&kind=email_reply" };
          routerMock.location.search = "?from=mail&kind=email_reply";
          routerMock.location.hash = "#approval-newest";
          (routerMock.location as { state?: unknown }).state = carried;
          // The address is changed as the router changes it.
          routerMock.navigate.mockImplementation((to: { search: string }) => {
            routerMock.location.search = to.search;
            for (const listener of [...routerMock.searchListeners]) listener();
          });
          try {
            await render();
            await vi.waitFor(() => expect(routerMock.navigate).toHaveBeenCalled());
            // In place, with the rest of the query, the #target and the state kept.
            expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith(
              { pathname: "/approvals/pending", search: "?from=mail", hash: "#approval-newest" },
              { replace: true, state: carried },
            );
            expect(order()).toEqual(["oldest", "newest"]);
            expect(openIds()).toEqual(["newest"]);

            // An agent files a new email reply: the list does not narrow to it.
            approvals = [
              ...approvals,
              createApproval("email2", "2026-10-02T00:00:00.000Z", {
                payload: { title: "Request email2", recipient: "buyer@example.test", body: "Draft body" },
              }),
            ];
            await reload();
            await vi.waitFor(() => expect(order()).toEqual(["oldest", "email2", "newest"]));
            expect(button(container, "All").getAttribute("aria-pressed")).toBe("true");
            expect(button(container, "Email replies").getAttribute("aria-pressed")).toBe("false");
            expect(openIds()).toEqual(["newest"]);
            expect(routerMock.navigate).toHaveBeenCalledTimes(1);
          } finally {
            delete (routerMock.location as { state?: unknown }).state;
          }
        });

        it("keeps a kind in the address that the tab lists", async () => {
          routerMock.location.search = "?kind=email_reply";
          await render("Request email");
          await reload();
          expect(order()).toEqual(["email"]);
          expect(routerMock.navigate).not.toHaveBeenCalled();
        });

        it("writes each choice into the address in place, and leaves a default out", async () => {
          routerMock.location.search = "?from=mail";
          await render();

          await click(button(container, "Email replies"));
          expect(routerMock.location.search).toBe("?from=mail&kind=email_reply");
          await click(button(container, "Sort: Oldest first"));
          expect(routerMock.location.search).toBe("?from=mail&kind=email_reply&sort=newest");
          expect(order()).toEqual(["email"]);
          await click(button(container, "All"));
          expect(routerMock.location.search).toBe("?from=mail&sort=newest");
          expect(order()).toEqual(["newest", "email", "oldest"]);
          await click(button(container, "Sort: Newest first"));
          expect(routerMock.location.search).toBe("?from=mail");
          expect(order()).toEqual(["oldest", "email", "newest"]);

          // Every change replaces the address: no history entry, and the page is not left.
          expect(routerMock.searchChanges).toEqual(Array(4).fill({ replace: true }));
          expect(routerMock.navigate).not.toHaveBeenCalled();
        });

        it("leaves the default order of All decisions out of the address too", async () => {
          routerMock.location.pathname = "/approvals/all";
          await render();
          await click(button(container, "Sort: Newest first"));
          expect(routerMock.location.search).toBe("?sort=oldest");
          await click(button(container, "Sort: Oldest first"));
          expect(routerMock.location.search).toBe("");
        });

        it("shows the same view after a reload", async () => {
          await render();
          await click(button(container, "Sort: Oldest first"));
          await click(button(container, "Email replies"));
          expect(order()).toEqual(["email"]);

          await openAgain("Request email");
          expect(order()).toEqual(["email"]);
          expect(button(container, "Email replies").getAttribute("aria-pressed")).toBe("true");
          expect(button(container, "Sort: Newest first")).toBeDefined();
          await click(button(container, "All"));
          expect(order()).toEqual(["newest", "email", "oldest"]);
        });

        it("returns to every kind and the default order on a change of tab, whose link carries no query", async () => {
          await render();
          await click(button(container, "Email replies"));
          await click(button(container, "Sort: Oldest first"));

          // What the tab link does: the bare address of the other tab.
          routerMock.location.pathname = "/approvals/all";
          routerMock.location.search = "";
          await rerender();
          expect(order()).toEqual(["newest", "email", "oldest", "done"]);
          expect(button(container, "All").getAttribute("aria-pressed")).toBe("true");
          expect(button(container, "Sort: Newest first")).toBeDefined();
        });

        it("does not send a held approval, or take its Undo away, when the filter or the order changes", async () => {
          approveAtOnce();
          await render();
          await click(button(row("oldest"), "Approve"));
          const held = row("oldest");

          await click(button(container, "Email replies"));
          await click(button(container, "Sort: Oldest first"));
          await click(button(container, "All"));
          expect(routerMock.location.search).toBe("?sort=newest");
          // The same row, still counting: the page was not started afresh.
          expect(row("oldest")).toBe(held);
          expect(undoButton(held)).not.toBeNull();
          expect(apiMocks.approve).not.toHaveBeenCalled();
          expect(progress()).toBe("1 decided this visit · 2 left to decide");

          await advance(APPROVE_HOLD_MS);
          expect(apiMocks.approve).toHaveBeenCalledExactlyOnceWith("oldest", undefined, heldFor("oldest"));
        });

        it("starts the page size again when the kind is changed", async () => {
          approvals = [
            ...pendingRequests(45),
            createApproval("mail", "2026-10-01T00:00:00.000Z", {
              payload: { title: "Request mail", recommendedAction: "Send it.", recipient: "buyer@example.test", body: "Draft" },
            }),
          ];
          await render("Request r01");
          await click([...container.querySelectorAll("button")].find((b) => /^Show \d+ more$/.test(b.textContent ?? ""))!);
          expect(rows()).toHaveLength(40);

          await click(button(container, "Email replies"));
          await click(button(container, "All"));
          expect(rows()).toHaveLength(20);
          expect(openIds()).toEqual(["r01"]);
        });

        it("drops a link's #approval target when the reader chooses another view", async () => {
          routerMock.location.hash = "#approval-newest";
          await render();
          await vi.waitFor(() => expect(openIds()).toEqual(["newest"]));

          await click(button(container, "Email replies"));
          expect(routerMock.location.hash).toBe("");
          // The list starts like a fresh one: its first card is open, not the linked one.
          expect(order()).toEqual(["email"]);
          expect(openIds()).toEqual(["email"]);
        });

        it("hands the address of the view to every View details link", async () => {
          approveAtOnce();
          approvals = [
            ...approvals,
            createApproval("sent-back", "2026-09-15T00:00:00.000Z", {
              status: "revision_requested",
              decidedAt: LATER,
              decisionNote: "Quote the delivery date",
            }),
          ];
          routerMock.location.pathname = "/PAP/approvals/pending";
          routerMock.location.search = "?sort=newest";
          await render();
          const state = { queue: "/PAP/approvals/pending?sort=newest" };

          // The open card.
          expect(openIds()).toEqual(["newest"]);
          expect(detailsLink(row("newest"))!.getAttribute("href")).toBe("/approvals/newest");
          expect(carried(detailsLink(row("newest")))).toEqual(state);
          // A row under "Waiting on the requester".
          await click([...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Waiting on the requester"))!);
          const sentBackRow = container.querySelector("[data-approval-sent-back-row='sent-back']")!;
          expect(carried(detailsLink(sentBackRow))).toEqual(state);
          // A decided row. The link follows the view as it changes.
          await click(button(row("newest"), "Approve"));
          await advance(APPROVE_HOLD_MS);
          expect(row("newest").hasAttribute("data-approval-decided-row")).toBe(true);
          await click(button(container, "Email replies"));
          await click(button(container, "All"));
          await click(button(container, "Sort: Newest first"));
          expect(carried(detailsLink(row("newest")))).toEqual({ queue: "/PAP/approvals/pending" });
        });
      });
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

});
