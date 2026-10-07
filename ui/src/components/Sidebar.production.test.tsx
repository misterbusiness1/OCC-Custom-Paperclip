// @vitest-environment jsdom

import { type ReactNode } from "react";
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

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

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
    const approvalsLink = primaryNavLinks.find((anchor) => anchor.getAttribute("href") === "/approvals/pending");
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
