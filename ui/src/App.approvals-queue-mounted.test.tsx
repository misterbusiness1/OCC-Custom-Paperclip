// @vitest-environment jsdom

// The Approvals queue holds what the board has not sent yet: an approval that
// is held for five seconds with Undo, the texts typed into its cards, and the
// revisions the reader has confirmed. All of it lives in the page instance, and
// a held approval is sent the moment that instance unmounts. A link to
// `/approvals` followed from the queue (the sidebar's Approvals item) must
// therefore keep the same instance.
//
// This drives the real <App> route table with the real Approvals page and the
// real sidebar item (both layouts) on a browser history, so a redirect route for
// `/approvals`, or any other element between the three addresses, fails here.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// See App.approvals-routing.test.tsx: jsdom rejects a rule that <App>'s import graph inserts.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papApprovalsQueueMountedPatched?: boolean;
  };
  if (!sheetProto.__papApprovalsQueueMountedPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".approvals-queue-mounted-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papApprovalsQueueMountedPatched = true;
  }
});

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  listIssues: vi.fn(),
  agentsList: vi.fn(),
}));

/** Every mount and unmount of the route element that shows the queue. */
const lifecycle = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("./api/approvals", () => ({ approvalsApi: apiMocks }));
vi.mock("./api/agents", () => ({ agentsApi: { list: apiMocks.agentsList } }));

// The real page, inside a component that mounts and unmounts with it and records both.
vi.mock("./pages/Approvals", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pages/Approvals")>();
  const { useEffect } = await import("react");
  return {
    ...original,
    Approvals: () => {
      useEffect(() => {
        lifecycle.events.push("mount");
        return () => {
          lifecycle.events.push("unmount");
        };
      }, []);
      return <original.Approvals />;
    },
  };
});

vi.mock("./pages/ApprovalDetail", () => ({ ApprovalDetail: () => <div>APPROVAL_DETAIL_PAGE</div> }));

// The shell around the pages: the sidebar's Approvals item as both sidebar layouts draw it (the
// same component, the same target), and two plain links for the other ways to these addresses.
vi.mock("./components/Layout", async () => {
  const { Outlet, useLocation } = await import("react-router-dom");
  const { Link } = await import("@/lib/router");
  const { SidebarNavItem } = await import("./components/SidebarNavItem");
  const { SidebarNavItem: ClassicSidebarNavItem } = await import("./components/SidebarNavItem.production");
  const { approvalsNavTarget } = await import("./lib/shell-navigation");
  return {
    Layout: () => {
      const { pathname } = useLocation();
      return (
        <>
          <nav>
            <div data-sidebar-layout="streamlined">
              <SidebarNavItem to={approvalsNavTarget(pathname)} label="Approvals" />
            </div>
            <div data-sidebar-layout="classic">
              <ClassicSidebarNavItem to={approvalsNavTarget(pathname)} label="Approvals" />
            </div>
            <Link to="/approvals" data-test-link="short">The short address</Link>
            <Link to="/approvals/all" data-test-link="all">All decisions</Link>
          </nav>
          <Outlet />
        </>
      );
    },
  };
});

vi.mock("./context/SidebarContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context/SidebarContext")>()),
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn(), collapsed: false, peeking: false }),
}));

vi.mock("./components/OnboardingWizardVariant", () => ({ OnboardingWizardVariant: () => null }));

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

vi.mock("./components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: ReactNode }> }) => (
    <div>
      {items.map((item) => (
        <span key={item.value} data-tab={item.value}>{item.label}</span>
      ))}
    </div>
  ),
}));

const PAP_COMPANY = { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" };
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./context/BreadcrumbContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context/BreadcrumbContext")>()),
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

import { App } from "./App";
import { APPROVE_HOLD_MS } from "./components/ApprovalHold";
import { SIDEBAR_SCROLL_RESET_STATE } from "./lib/navigation-scroll";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createApproval(id: string, createdAt: string) {
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
  };
}

describe("the Approvals queue stays mounted when a link to /approvals is followed from it", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    // An approval is held for a few seconds before it is sent; the tests move the clock themselves.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    lifecycle.events.length = 0;
    window.localStorage.clear();
    apiMocks.list.mockResolvedValue([
      createApproval("newest", "2026-10-05T00:00:00.000Z"),
      createApproval("middle", "2026-10-01T00:00:00.000Z"),
      createApproval("oldest", "2026-09-20T00:00:00.000Z"),
    ]);
    apiMocks.agentsList.mockResolvedValue([]);
    apiMocks.listIssues.mockResolvedValue([]);
    // A sent approval stays on its way: what matters here is whether and when it is sent.
    apiMocks.approve.mockImplementation(() => new Promise(() => {}));
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

  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const renderAt = async (path: string) => {
    window.history.replaceState(null, "", path);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>,
      );
    });
    // The list loads on its own time; each step is taken inside act, as every later one is.
    for (let step = 0; step < 100 && !container.textContent?.includes("Request oldest"); step += 1) await pass(10);
    expect(container.textContent).toContain("Request oldest");
  };
  const rows = () => [...container.querySelectorAll<HTMLElement>("[data-approval-card]")];
  const row = (id: string) => rows().find((candidate) => candidate.dataset.approvalCard === id)!;
  const header = (card: HTMLElement) => card.querySelector<HTMLButtonElement>("h3 > button[aria-expanded]")!;
  const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  // A real click event, so the router's link handler runs as it does in the browser.
  const click = (element: HTMLElement) =>
    act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
  const typeText = (card: HTMLElement, value: string) =>
    act(async () => {
      const note = card.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, value);
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const heldRows = () => [...container.querySelectorAll<HTMLElement>("[data-approval-held-row]")];
  const unsentNote = (id: string) => row(id).querySelector("[data-approval-unsent-note]")?.textContent ?? null;
  const sidebarItem = (layout: string) =>
    container.querySelector<HTMLAnchorElement>(`[data-sidebar-layout="${layout}"] a`)!;
  const link = (name: string) => container.querySelector<HTMLAnchorElement>(`[data-test-link="${name}"]`)!;

  /** A change request typed into `newest` and left unsent, then an approval of `oldest` held with Undo. */
  const typeANoteAndHoldAnApproval = async () => {
    await click(header(row("newest")));
    await click(button(row("newest"), "Request changes"));
    await typeText(row("newest"), "Quote the delivery date");
    await click(header(row("oldest")));
    expect(unsentNote("newest")).toBe("Change request not sent");
    await click(button(row("oldest"), "Approve"));
    expect(heldRows().map((held) => held.dataset.approvalCard)).toEqual(["oldest"]);
    expect(button(heldRows()[0], "Undo")).toBeDefined();
    expect(apiMocks.approve).not.toHaveBeenCalled();
  };
  const expectTheNoteIsStillThere = async () => {
    await click(header(row("newest")));
    expect(row("newest").querySelector("textarea")!.value).toBe("Quote the delivery date");
    expect(row("newest").textContent).toContain("What should change?");
  };

  it.each(["streamlined", "classic"])(
    "on To decide the %s sidebar item changes nothing: the held approval, its Undo and the typed note stay",
    async (layout) => {
      await renderAt("/PAP/approvals/pending");
      await typeANoteAndHoldAnApproval();
      const heldRow = heldRows()[0];
      const historyLength = window.history.length;
      await pass(700);

      expect(sidebarItem(layout).getAttribute("aria-current")).toBe("page");
      await click(sidebarItem(layout));
      await pass(50);

      expect(lifecycle.events).toEqual(["mount"]);
      expect(window.location.pathname).toBe("/PAP/approvals/pending");
      // The same row, not a new one drawn by a new page; nothing was sent early.
      expect(heldRows()).toEqual([heldRow]);
      expect(heldRow.isConnected).toBe(true);
      expect(button(heldRow, "Undo")).toBeDefined();
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(unsentNote("newest")).toBe("Change request not sent");
      // Back still leaves the queue in one press.
      expect(window.history.length).toBe(historyLength);

      // The hold then runs out as it would have, and the approval is sent once.
      await pass(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(apiMocks.approve.mock.calls[0][0]).toBe("oldest");
      await expectTheNoteIsStillThere();
      expect(lifecycle.events).toEqual(["mount"]);
    },
  );

  it("on To decide a link to the short address keeps the page: nothing is sent early and the address is corrected", async () => {
    await renderAt("/PAP/approvals/pending");
    await typeANoteAndHoldAnApproval();
    const heldRow = heldRows()[0];
    await pass(700);

    await click(link("short"));
    await pass(50);

    expect(lifecycle.events).toEqual(["mount"]);
    expect(window.location.pathname).toBe("/PAP/approvals/pending");
    expect(heldRows()).toEqual([heldRow]);
    expect(button(heldRow, "Undo")).toBeDefined();
    expect(apiMocks.approve).not.toHaveBeenCalled();
    expect(unsentNote("newest")).toBe("Change request not sent");

    await pass(APPROVE_HOLD_MS);
    expect(apiMocks.approve).toHaveBeenCalledTimes(1);
    await expectTheNoteIsStillThere();
  });

  it.each(["streamlined", "classic"])(
    "on All decisions the %s sidebar item goes to To decide without a new page: the typed note stays",
    async (layout) => {
      await renderAt("/PAP/approvals/pending");
      await typeANoteAndHoldAnApproval();

      // To All decisions: a tab change, which sends what is held, as it always did.
      await click(link("all"));
      await pass(50);
      expect(window.location.pathname).toBe("/PAP/approvals/all");
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(lifecycle.events).toEqual(["mount"]);

      const item = sidebarItem(layout);
      expect(item.getAttribute("aria-current")).toBe("page");
      expect(item.getAttribute("href")).toBe("/PAP/approvals");
      await click(item);
      await pass(50);

      // The same page instance now shows To decide, under its full address.
      expect(lifecycle.events).toEqual(["mount"]);
      expect(window.location.pathname).toBe("/PAP/approvals/pending");
      expect(sidebarItem(layout).getAttribute("aria-current")).toBe("page");
      // What the sidebar's link carried (it asks the shell to scroll to the top) is not lost with the short address.
      expect(window.history.state?.usr).toEqual(SIDEBAR_SCROLL_RESET_STATE);
      // Nothing is sent a second time, and the note typed before is still on its card.
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
      expect(unsentNote("newest")).toBe("Change request not sent");
      await expectTheNoteIsStillThere();
      await pass(APPROVE_HOLD_MS);
      expect(apiMocks.approve).toHaveBeenCalledTimes(1);
    },
  );

  it("opens the company's To decide from the short address without a company prefix", async () => {
    await renderAt("/approvals");
    expect(window.location.pathname).toBe("/PAP/approvals/pending");
    expect(lifecycle.events).toEqual(["mount"]);
    expect(rows().map((card) => card.dataset.approvalCard)).toEqual(["oldest", "middle", "newest"]);
  });

  it("opens To decide from the short address, keeping the rest of the address", async () => {
    await renderAt("/PAP/approvals?from=mail#approval-middle");
    expect(window.location.pathname).toBe("/PAP/approvals/pending");
    expect(window.location.search).toBe("?from=mail");
    expect(window.location.hash).toBe("#approval-middle");
    expect(lifecycle.events).toEqual(["mount"]);
    // The link's request is the open card, as it is for /approvals/pending#approval-<id>.
    expect(header(row("middle")).getAttribute("aria-expanded")).toBe("true");
    expect(header(row("oldest")).getAttribute("aria-expanded")).toBe("false");
  });
});
