// @vitest-environment jsdom

import { type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.production";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSidebar = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
  collapsed: false,
  collapseLocked: false,
  peeking: false,
  toggleCollapsed: vi.fn(),
  setCollapsed: vi.fn(),
}));

/** The page the sidebar is drawn on, and the company prefix `@/lib/router` puts before every target. */
const mockLocation = vi.hoisted(() => ({ pathname: "/", companyPrefix: "" }));

// The router's own NavLink, so that which item is current (class and aria-current) is decided by
// the router's matching and not by the test. The company prefix is added as `@/lib/router` adds it.
vi.mock("@/lib/router", async () => {
  const router = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    NavLink: ({ to, ...props }: { to: string } & Omit<ComponentProps<typeof router.NavLink>, "to">) => (
      <router.MemoryRouter initialEntries={[mockLocation.pathname]}>
        <router.NavLink to={`${mockLocation.companyPrefix}${to}`} {...props} />
      </router.MemoryRouter>
    ),
    useLocation: () => ({ pathname: mockLocation.pathname }),
  };
});

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebar,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/attention", () => ({
  attentionApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({}) },
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
}));

vi.mock("./SidebarCompanyMenu.production", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

vi.mock("./SidebarAgents.production", () => ({
  SidebarAgents: () => <div>Agents</div>,
}));

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => null,
}));

vi.mock("./SidebarStarredProjects.production", () => ({
  SidebarStarredProjects: () => null,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Sidebar (classic layout)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockLocation.pathname = "/";
    mockLocation.companyPrefix = "";
  });

  // On To decide the item links to that page itself, so that pressing it there changes nothing: it
  // does not leave the queue, where an approval may be held and a note half typed. Everywhere else
  // it links to the short address, under which every Approvals page is the current one.
  it.each([
    ["/approvals/pending", "", "/approvals/pending"],
    ["/approvals/all", "", "/approvals"],
    ["/approvals/9b2d7c1e-approval", "", "/approvals"],
    ["/PAP/approvals/pending", "/PAP", "/PAP/approvals/pending"],
    ["/PAP/approvals/all", "/PAP", "/PAP/approvals"],
    ["/PAP/approvals/9b2d7c1e-approval", "/PAP", "/PAP/approvals"],
  ])("marks Approvals as the current item on %s", async (pathname, companyPrefix, href) => {
    mockApprovalsApi.list.mockResolvedValue([]);
    mockLocation.pathname = pathname;
    mockLocation.companyPrefix = companyPrefix;
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sidebar />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const current = [...container.querySelectorAll('nav a[aria-current="page"]')];
    expect(current.map((anchor) => anchor.textContent)).toEqual(["Approvals"]);
    expect(current[0].getAttribute("href")).toBe(href);
    expect(current[0].className).toContain("bg-accent text-foreground");
    const inbox = container.querySelector(`nav a[href="${companyPrefix}/inbox"]`)!;
    expect(inbox.getAttribute("aria-current")).toBeNull();

    // On another page it is not the current item.
    flushSync(() => {
      root.unmount();
    });
    mockLocation.pathname = `${companyPrefix}/inbox`;
    const second = createRoot(container);
    flushSync(() => {
      second.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sidebar />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    expect(container.querySelector(`nav a[href="${companyPrefix}/approvals"]`)!.getAttribute("aria-current")).toBeNull();
    flushSync(() => {
      second.unmount();
    });
    queryClient.clear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("links to the approval queue next to Inbox, with the number of requests to decide", async () => {
    mockApprovalsApi.list.mockResolvedValue([
      { id: "approval-1", status: "pending" },
      { id: "approval-2", status: "revision_requested" },
      { id: "approval-3", status: "approved" },
    ]);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sidebar />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const primaryNavLinks = [...container.querySelectorAll("nav > div:first-child a")];
    const approvalsLink = primaryNavLinks.find((anchor) => anchor.getAttribute("href") === "/approvals");
    const inboxLink = primaryNavLinks.find((anchor) => anchor.getAttribute("href") === "/inbox");
    expect(approvalsLink?.textContent).toBe("Approvals1");
    expect(approvalsLink?.querySelector("svg")?.classList.contains("lucide-shield-check")).toBe(true);
    expect(primaryNavLinks.indexOf(approvalsLink!)).toBe(primaryNavLinks.indexOf(inboxLink!) + 1);
    expect(mockApprovalsApi.list).toHaveBeenCalledExactlyOnceWith("company-1");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
