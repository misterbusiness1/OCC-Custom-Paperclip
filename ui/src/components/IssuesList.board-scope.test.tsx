// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesList } from "./IssuesList";
import { TooltipProvider } from "@/components/ui/tooltip";
import { operatorTaskViewFilters } from "../lib/operator-task-views";
import { taskCollectionPreferencesStorageKey } from "../lib/task-collection-preferences";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockExternalObjectsApi = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
  useDialogActions: () => dialogState,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    ...mockIssuesApi,
    listCompact: mockIssuesApi.list,
  },
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/externalObjects", () => ({
  externalObjectsApi: mockExternalObjectsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Render the real collection selector, legacy/streamlined list and Kanban board.
// Only the list row presentation and surrounding API/context providers are stubbed.
vi.mock("./IssueRow", () => ({
  IssueRow: ({ issue }: { issue: Issue }) => <div>{issue.title}</div>,
}));

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      await flush();
    }
  }

  throw lastError;
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {node}
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

const statuses = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
const labels = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Blocked", "Cancelled"];
const key = "paperclip:board-scope";
for (const streamlined of [false, true]) describe(`real board (streamlined=${streamlined})`, () => {
  let container: HTMLDivElement;
  let mounted: ReturnType<typeof renderWithQueryClient> | undefined;
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); companyState.selectedCompanyId = "company-1";
    container = document.createElement("div"); document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" }, session: null });
    mockAccessApi.listMembers.mockResolvedValue({ members: [], access: {} });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockExternalObjectsApi.getIssueSummaries.mockResolvedValue({ summaries: {} });
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: streamlined });
    mockIssuesApi.list.mockImplementation((_company, q) => Promise.resolve(statuses
      .filter((s) => !q.status || q.status.split(",").includes(s))
      .map((status) => createIssue({ id: status, title: `Card ${status}`, status, assigneeUserId: "user-1" }))));
  });
  afterEach(async () => {
    if (mounted) { await act(() => mounted!.root.unmount()); mounted.queryClient.clear(); }
    mounted = undefined; container.remove();
  });
  function persist(saved: string[] = [], viewMode = "board") {
    const viewState = { viewMode, statuses: saved, boardColdLaneMode: "expanded" };
    localStorage.setItem(`${key}:company-1`, JSON.stringify(viewState));
    localStorage.setItem(taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey: key }),
      JSON.stringify({ version: 1, companyId: "company-1", collectionKey: key, viewState, columns: [] }));
  }
  function node(filters = {}, search = "", rows: Issue[] = []) {
    return <IssuesList issues={rows} agents={[]} projects={[]} viewStateKey={key} searchFilters={filters}
      initialSearch={search} projectId="project-1" onUpdateIssue={() => undefined} />;
  }
  function render(filters = {}, search = "", rows: Issue[] = []) {
    mounted = renderWithQueryClient(node(filters, search, rows), container);
  }
  async function change(filters = {}, search = "", rows: Issue[] = []) {
    await act(() => mounted!.root.render(<QueryClientProvider client={mounted!.queryClient}>
      <TooltipProvider>{node(filters, search, rows)}</TooltipProvider></QueryClientProvider>));
  }
  function lanes(allowed: readonly string[]) {
    expect([...container.querySelectorAll("span.uppercase")].map((s) => s.textContent))
      .toEqual(allowed.map((s) => labels[statuses.indexOf(s as typeof statuses[number])]));
  }
  it.each(["blocked", "review", "assigned"] as const)("scopes %s on persisted entry and changing/cleared search", async (view) => {
    persist();
    const filters = { ...operatorTaskViewFilters(view), participantAgentId: "participant", workspaceId: "workspace" };
    const allowed = filters.status!.split(","); render(filters);
    for (const search of ["", "needle", "changed", ""]) {
      await change(filters, search);
      await waitForAssertion(() => {
        lanes(allowed);
        for (const s of allowed) expect(container.textContent).toContain(`Card ${s}`);
        for (const s of statuses.filter((s) => !allowed.includes(s))) expect(container.textContent).not.toContain(`Card ${s}`);
        const calls = mockIssuesApi.list.mock.calls.filter(([, q]) => q.q === (search || undefined));
        expect(calls.length).toBeGreaterThan(0);
        for (const [company, q, options] of calls) {
          expect(company).toBe("company-1");
          expect(q).toMatchObject({ ...filters, status: q.status, projectId: "project-1", limit: 200 });
          expect(q.status.split(",").every((s: string) => allowed.includes(s))).toBe(true);
          expect(options.signal).toBeInstanceOf(AbortSignal);
        }
      }, 100);
    }
  });
  it.each([["done"], ["blocked", "done"]])("intersects saved statuses %j", async (...saved) => {
    persist(saved); render(operatorTaskViewFilters("blocked"));
    const allowed = saved.includes("blocked") ? ["blocked"] : [];
    await waitForAssertion(() => lanes(allowed));
    expect(mockIssuesApi.list.mock.calls.every(([, q]) => q.status === "blocked")).toBe(true);
    expect(container.textContent).not.toContain("Card done");
  });
  it("retains task-view scope through list/board and task-view switches", async () => {
    persist([], "list"); render(operatorTaskViewFilters("blocked"), "", [createIssue({ title: "Loaded blocked", status: "blocked" })]);
    await waitForAssertion(() => expect(container.textContent).toContain("Loaded blocked"));
    await act(() => (container.querySelector('[aria-label="Board view"]') as HTMLButtonElement).click());
    await waitForAssertion(() => { lanes(["blocked"]); expect(container.textContent).toContain("Card blocked"); });
    await change(operatorTaskViewFilters("review"));
    await waitForAssertion(() => { lanes(["in_review"]); expect(container.textContent).toContain("Card in_review"); });
    await act(() => (container.querySelector('[aria-label="List view"]') as HTMLButtonElement).click());
    await waitForAssertion(() => expect(container.textContent).not.toContain("Card blocked"));
    await act(() => (container.querySelector('[aria-label="Board view"]') as HTMLButtonElement).click());
    await waitForAssertion(() => lanes(["in_review"]));
  });
  it("guards fallback and remote rows against other companies, assignees and statuses", async () => {
    persist();
    const rows = [createIssue({ id: "ok", title: "Allowed fallback", status: "blocked", assigneeUserId: "user-1" }),
      createIssue({ id: "foreign", title: "Foreign company", companyId: "company-2", status: "blocked", assigneeUserId: "user-1" }),
      createIssue({ id: "other", title: "Other assignee", status: "blocked", assigneeUserId: "user-2" }),
      createIssue({ id: "done", title: "Terminal", status: "done", assigneeUserId: "user-1" })];
    let resolve!: (rows: Issue[]) => void;
    mockIssuesApi.list.mockImplementation(() => new Promise<Issue[]>((done) => { resolve = done; }));
    const filters = { ...operatorTaskViewFilters("assigned"), status: "blocked" }; render(filters, "", rows);
    const assertRows = () => {
      expect(container.textContent).toContain("Allowed fallback");
      for (const s of ["Foreign company", "Other assignee", "Terminal"]) expect(container.textContent).not.toContain(s);
    };
    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalled();
      expect(container.textContent).not.toContain("Allowed fallback");
      lanes(["blocked"]);
    });
    await act(() => resolve(rows)); await waitForAssertion(assertRows);
    await change(filters, "new search", rows);
    await waitForAssertion(() => expect(container.textContent).not.toContain("Allowed fallback"), 100);
    companyState.selectedCompanyId = "company-2"; await change(filters, "new search", rows);
    await waitForAssertion(() => expect(mockIssuesApi.list.mock.calls.some(([c]) => c === "company-2")).toBe(true), 100);
    expect(container.textContent).not.toContain("Allowed fallback");
  });
  it("retains All tasks and server overdue predicates", async () => {
    persist(); render(operatorTaskViewFilters("all"));
    await waitForAssertion(() => { lanes(statuses); expect(container.textContent).toContain("Card done"); });
    await change(operatorTaskViewFilters("overdue"));
    await waitForAssertion(() => {
      lanes(statuses); const calls = mockIssuesApi.list.mock.calls.filter(([, q]) => q.overdueFollowUp);
      expect(calls).toHaveLength(7);
      for (const [c, q] of calls) { expect(c).toBe("company-1"); expect(q.overdueFollowUp).toBe(true); }
    });
  });
});
