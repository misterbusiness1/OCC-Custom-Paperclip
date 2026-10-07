// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval, HeartbeatRun, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyJoinRequest } from "../api/access";
import {
  clearLocalInboxArchive,
  getLocalInboxArchiveIssueIds,
} from "../lib/inboxArchiveCache";
import { taskCollectionPreferencesStorageKey } from "../lib/task-collection-preferences";

const routerMock = vi.hoisted(() => ({
  location: { pathname: "/", search: "", hash: "" },
  navigate: vi.fn(),
}));

const externalObjectMocks = vi.hoisted(() => ({
  summaries: new Map(),
}));

const apiMocks = vi.hoisted(() => ({
  approvalsList: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  joinRequestsList: vi.fn(),
  userDirectoryList: vi.fn(),
  authSession: vi.fn(),
  dashboardSummary: vi.fn(),
  executionWorkspaceSummaries: vi.fn(),
  issuesList: vi.fn(),
  issuesCount: vi.fn(),
  issueLabels: vi.fn(),
  archiveFromInbox: vi.fn(),
  unarchiveFromInbox: vi.fn(),
  agentsList: vi.fn(),
  heartbeatRunsList: vi.fn(),
  liveRunsForCompany: vi.fn(),
  experimentalSettings: vi.fn(),
  projectsList: vi.fn(),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: apiMocks.approvalsList,
    approve: apiMocks.approve,
    reject: apiMocks.reject,
    requestRevision: apiMocks.requestRevision,
  },
}));

vi.mock("../api/access", async () => {
  const actual = await vi.importActual<typeof import("../api/access")>("../api/access");
  return {
    ...actual,
    accessApi: {
      listJoinRequests: apiMocks.joinRequestsList,
      listUserDirectory: apiMocks.userDirectoryList,
    },
  };
});

vi.mock("../api/auth", () => ({
  authApi: { getSession: apiMocks.authSession },
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: { summary: apiMocks.dashboardSummary },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: { listSummaries: apiMocks.executionWorkspaceSummaries },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: apiMocks.issuesList,
    listCompact: apiMocks.issuesList,
    count: apiMocks.issuesCount,
    listLabels: apiMocks.issueLabels,
    markRead: vi.fn(),
    markUnread: vi.fn(),
    archiveFromInbox: apiMocks.archiveFromInbox,
    unarchiveFromInbox: apiMocks.unarchiveFromInbox,
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: apiMocks.agentsList },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    list: apiMocks.heartbeatRunsList,
    liveRunsForCompany: apiMocks.liveRunsForCompany,
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: apiMocks.experimentalSettings },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: apiMocks.projectsList },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

const generalSettingsMock = { keyboardShortcutsEnabled: false };
vi.mock("../context/GeneralSettingsContext", () => ({
  useGeneralSettings: () => generalSettingsMock,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useDismissedInboxAlerts: () => ({ dismissed: new Set(), dismiss: vi.fn() }),
  useInboxDismissals: () => ({ dismissedAtByKey: new Map(), dismiss: vi.fn() }),
  useReadInboxItems: () => ({
    readItems: new Set(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
  }),
}));

vi.mock("../hooks/useIssueExternalObjects", () => ({
  useIssueExternalObjectSummaries: () => ({
    summaries: externalObjectMocks.summaries,
    isLoading: false,
    isReady: true,
  }),
}));

import {
  FailedRunInboxRow,
  Inbox,
  InboxGroupHeader,
  InboxIssueMetaLeading,
  InboxIssueTrailingColumns,
  formatJoinRequestInboxLabel,
} from "./Inbox";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
  useLocation: () => routerMock.location,
  useNavigate: () => routerMock.navigate,
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

// jsdom doesn't implement scrollIntoView; the inbox calls it from a passive effect.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-904",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Inbox item",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 904,
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
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: new Date("2026-03-11T00:00:00.000Z"),
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createJoinRequest(
  overrides: Partial<CompanyJoinRequest> = {},
): CompanyJoinRequest {
  return {
    id: "join-1",
    inviteId: "invite-1",
    companyId: "company-1",
    requestType: "human",
    status: "pending_approval",
    requestIp: "127.0.0.1",
    requestingUserId: "user-1",
    requestEmailSnapshot: "joiner@example.com",
    agentName: null,
    adapterType: null,
    capabilities: null,
    agentDefaultsPayload: null,
    claimSecretExpiresAt: null,
    claimSecretConsumedAt: null,
    createdAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    requesterUser: {
      id: "user-1",
      name: "Jordan Example",
      email: "joiner@example.com",
      image: null,
    },
    approvedByUser: null,
    rejectedByUser: null,
    invite: null,
    ...overrides,
  };
}

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: "local-board",
    status: "pending",
    payload: { name: "New teammate" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

function createFailedRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    responsibleUserId: null,
    invocationSource: "assignment",
    triggerDetail: null,
    status: "failed",
    error: "boom",
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    startedAt: new Date("2026-03-11T00:00:00.000Z"),
    finishedAt: new Date("2026-03-11T00:01:00.000Z"),
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:01:00.000Z"),
    ...overrides,
  };
}

function resetInboxApiMocks() {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  externalObjectMocks.summaries.clear();
  routerMock.location.pathname = "/";
  routerMock.location.search = "";
  routerMock.location.hash = "";
  routerMock.navigate.mockReset();
  apiMocks.approvalsList.mockResolvedValue([]);
  apiMocks.approve.mockResolvedValue(createApproval({ status: "approved" }));
  apiMocks.reject.mockResolvedValue(createApproval({ status: "rejected" }));
  apiMocks.requestRevision.mockResolvedValue(createApproval({ status: "revision_requested" }));
  apiMocks.joinRequestsList.mockResolvedValue([]);
  apiMocks.userDirectoryList.mockResolvedValue({ users: [] });
  apiMocks.authSession.mockResolvedValue({
    user: { id: "local-board" },
    session: { userId: "local-board" },
  });
  apiMocks.dashboardSummary.mockResolvedValue({
    agents: { error: 0 },
    costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 },
  });
  apiMocks.executionWorkspaceSummaries.mockResolvedValue([]);
  apiMocks.issuesList.mockResolvedValue([]);
  apiMocks.issuesCount.mockResolvedValue({ count: 0 });
  apiMocks.issueLabels.mockResolvedValue([]);
  apiMocks.archiveFromInbox.mockResolvedValue({ id: "issue-1", archivedAt: new Date() });
  apiMocks.unarchiveFromInbox.mockResolvedValue({ id: "issue-1", archivedAt: new Date() });
  apiMocks.agentsList.mockResolvedValue([]);
  apiMocks.heartbeatRunsList.mockResolvedValue([]);
  apiMocks.liveRunsForCompany.mockResolvedValue([]);
  apiMocks.experimentalSettings.mockResolvedValue({
    enableIsolatedWorkspaces: false,
    enableStreamlinedUi: true,
  });
  apiMocks.projectsList.mockResolvedValue([]);
}

describe("Inbox toolbar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    resetInboxApiMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    for (const issueId of getLocalInboxArchiveIssueIds("company-1")) {
      clearLocalInboxArchive("company-1", issueId);
    }
    container.remove();
  });

  it("restores the legacy toolbar and issue-row presentation when Streamlined UI is off", async () => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedUi: false,
    });
    apiMocks.issuesList.mockResolvedValue([
      createIssue({ id: "legacy-row", identifier: "PAP-1904", title: "Legacy inbox task" }),
    ]);
    localStorage.setItem(
      taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey: "inbox" }),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        collectionKey: "inbox",
        viewState: {},
        columns: [],
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Legacy inbox task"));

    expect(container.querySelector('[data-slot="collection-toolbar"]')).toBeNull();
    expect(container.querySelector('[role="toolbar"][aria-label="Inbox controls"]')).toBeNull();
    expect(container.textContent).toContain("Mine");
    expect(container.querySelector('[data-slot="task-row"]')).toBeNull();
    const issueLink = container.querySelector('[data-inbox-issue-link]');
    // Production reads the legacy Inbox column key and must ignore the
    // Streamlined collection envelope above when the experiment is disabled.
    expect(issueLink?.parentElement?.textContent).toContain("PAP-1904");

    act(() => root.unmount());
  });

  it("does not render external-object summaries in inbox rows", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issue = createIssue({ title: "Inbox row without external object column" });
    apiMocks.issuesList.mockResolvedValue([issue]);
    externalObjectMocks.summaries.set(issue.id, {
      total: 1,
      highestSeverity: "failed",
      byStatusCategory: { failed: 1 },
      objects: [],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(issue.title);
    });

    expect(container.querySelector('[aria-label^="External objects:"]')).toBeNull();

    act(() => root.unmount());
  });

  it("keeps archive hover actions and swipe targets on every unread non-task Mine row", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:group-by", "none");
    apiMocks.approvalsList.mockResolvedValue([createApproval()]);
    apiMocks.heartbeatRunsList.mockResolvedValue([createFailedRun()]);
    apiMocks.joinRequestsList.mockResolvedValue([createJoinRequest()]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Hire Agent: New teammate");
      expect(container.textContent).toContain("Failed run");
      expect(container.textContent).toContain("Jordan Example");
    });

    const rowFor = (text: string) =>
      [...container.querySelectorAll("[data-inbox-item]")]
        .find((row) => row.textContent?.includes(text));

    for (const text of ["Hire Agent: New teammate", "Failed run", "Jordan Example"]) {
      const row = rowFor(text);
      expect(row, `missing inbox row for ${text}`).toBeDefined();
      expect(row?.querySelector('button[aria-label="Mark as read"]')).not.toBeNull();
      const archiveButton = row?.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
      expect(archiveButton).not.toBeNull();
      expect(archiveButton?.className).toContain("opacity-0");
      expect(archiveButton?.className).toContain("group-hover:opacity-100");
      expect(row?.querySelector("[data-inbox-row-surface]")).not.toBeNull();
    }

    const approvalRow = rowFor("Hire Agent: New teammate");
    const approvalActions = [...(approvalRow?.querySelectorAll("button") ?? [])]
      .filter((button) => button.textContent === "Approve" || button.textContent === "Reject");
    expect(approvalActions.length).toBeGreaterThanOrEqual(2);
    approvalActions.forEach((button) => {
      expect(button.className).toContain("h-8");
      expect(button.className).toContain("min-w-(--sz-64px)");
      expect(button.className).toContain("justify-center");
    });

    act(() => root.unmount());
  });

  it.each([true, false])("shows verbatim Board source before inbox decisions with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    const original = "\nPlease review this email.\n\n<script>alert('source')</script>\n**Keep this wording**\n"
      + "The original message continues without shortening.\n".repeat(12);
    apiMocks.approvalsList.mockResolvedValue([createApproval({
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      payload: {
        title: "Customer request",
        recommendedAction: "Approve the bounded reply",
        reasoning: "The request fits the agreed scope",
        pros: ["Answers the customer's question"],
        risks: ["Requires a final review"],
        originalRequest: {
          text: original,
          source: { kind: "external", sender: "Customer", snapshotOrigin: "requester" },
        },
      },
    })]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Customer request"));
      const row = [...container.querySelectorAll("[data-inbox-item]")]
        .find((item) => item.textContent?.includes("Customer request"))!;
      const source = row.querySelector("pre")!;
      expect(source.textContent).toBe(original);
      // A long request shows its first lines; the retained text is never shortened.
      expect(source.classList.contains("line-clamp-4")).toBe(true);
      const expandSource = [...row.querySelectorAll("button")]
        .find((button) => button.textContent?.startsWith("Show full request"))!;
      expect(expandSource.textContent).toBe(`Show full request (${original.length.toLocaleString()} characters)`);
      await act(async () => expandSource.click());
      expect(source.classList.contains("line-clamp-4")).toBe(false);
      expect(source.textContent).toBe(original);
      expect(row.querySelector("script")).toBeNull();
      expect(row.textContent).toContain("Customer · Quoted by the requesting agent, not verified");
      const text = row.textContent!;
      expect(text.indexOf("Recommendation")).toBeLessThan(text.indexOf("Original request"));
      expect(text.indexOf("Original request")).toBeLessThan(text.indexOf("Why"));
      expect(text.indexOf("Why")).toBeLessThan(text.indexOf("Pros"));
      expect(text.indexOf("Risks")).toBeLessThan(text.indexOf("ApproveRequest changesReject"));
      const button = (label: string) =>
        [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
      // Rejecting asks for confirmation before anything is sent.
      await act(async () => button("Reject").click());
      expect(apiMocks.reject).not.toHaveBeenCalled();
      await act(async () => button("Cancel").click());
      // Asking for changes needs a note, and the note travels with the request.
      const [pending] = await (apiMocks.approvalsList.mock.results[0].value as Promise<Approval[]>);
      const revised: Approval = {
        ...pending,
        status: "revision_requested",
        decisionNote: "Quote the delivery date",
        decidedAt: new Date("2026-03-11T00:05:00.000Z"),
        updatedAt: new Date("2026-03-11T00:05:00.000Z"),
      };
      const listed = createDeferred<Approval[]>();
      apiMocks.requestRevision.mockImplementation(async () => {
        apiMocks.approvalsList.mockReturnValue(listed.promise);
        return revised;
      });
      await act(async () => button("Request changes").click());
      expect(button("Send request").disabled).toBe(true);
      const note = row.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Quote the delivery date");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button("Send request").click());
      await vi.waitFor(() =>
        expect(apiMocks.requestRevision).toHaveBeenCalledWith("approval-1", "Quote the delivery date"));
      // The decision is stored but the list still shows the old approval: nothing can be sent twice.
      await vi.waitFor(() => expect(apiMocks.approvalsList.mock.calls.length).toBeGreaterThan(1));
      // Let the mutation settle, so only the lock (not the in-flight request) can disable the controls.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(button("Approve").disabled).toBe(true);
      expect(button("Send request").disabled).toBe(true);
      await act(async () => listed.resolve([revised]));
      // Once the list catches up, the row waits on the requester: the version sent back has no one-click decision.
      await vi.waitFor(() => expect(row.querySelector("[data-approval-sent-back]")).not.toBeNull());
      const sentBack = row.querySelector("[data-approval-sent-back]")!;
      expect(sentBack.textContent).toContain("Waiting on the requester to revise");
      expect(sentBack.textContent).toContain("Sent back ");
      expect(sentBack.textContent).toContain("Changes you asked forQuote the delivery date");
      for (const label of ["Approve", "Reject", "Request changes", "Send request", "Add a note"]) {
        expect(button(label)).toBeUndefined();
      }
      expect(row.querySelector("textarea")).toBeNull();
      // The request itself stays readable in the row.
      expect(row.querySelector("pre")!.textContent).toBe(original);
      // A Board request is decided in place: the Inbox stays on screen.
      await act(async () => {});
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(apiMocks.reject).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(row.querySelector('button[aria-label="Mark as read"]')).not.toBeNull();
      expect(row.querySelector('button[aria-label="Archive"]')).not.toBeNull();
      expect(row.querySelector('a[to="/approvals/approval-1"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("shows what a hire or strategy asks for before its inbox decision with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    apiMocks.agentsList.mockResolvedValue([
      { id: "agent-ceo", name: "Chief Executive" },
      { id: "agent-1", name: "Infra Engineer" },
    ]);
    apiMocks.approvalsList.mockResolvedValue([
      createApproval({
        id: "approval-hire",
        type: "hire_agent",
        requestedByAgentId: "agent-1",
        payload: {
          name: "Pricing Analyst",
          role: "researcher",
          reportsTo: "agent-ceo",
          capabilities: "Tracks competitor prices weekly.",
          budgetMonthlyCents: 5000,
          agentId: "agent-pending",
        },
      }),
      createApproval({
        id: "approval-strategy",
        type: "approve_ceo_strategy",
        requestedByAgentId: "agent-1",
        payload: { plan: "1. Grow wholesale.\n2. Cut returns." },
      }),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Hire Agent: Pricing Analyst"));
      const rowFor = (text: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(text))!;

      const hire = rowFor("Hire Agent: Pricing Analyst");
      const summary = hire.querySelector("[data-approval-hire]")!;
      expect(summary.textContent).toContain("Monthly budget$50.00");
      // The manager is named from the company's agent list, on both inbox layouts.
      expect(summary.textContent).toContain("Reports toChief Executive");
      expect(summary.textContent).toContain("What it will doTracks competitor prices weekly.");
      expect(summary.textContent).toContain("If rejectedThe pending agent is terminated.");
      // A hire is never rejected on a single click: the pending agent would be terminated.
      const button = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
      await act(async () => button(hire, "Reject").click());
      expect(apiMocks.reject).not.toHaveBeenCalled();
      expect(hire.textContent).toContain("Reject this request?");
      await act(async () => button(hire, "Cancel").click());

      const strategy = rowFor("CEO Strategy");
      expect(strategy.querySelector("[data-approval-plan] p.whitespace-pre-wrap")!.textContent).toBe(
        "1. Grow wholesale.\n2. Cut returns.",
      );
      expect(button(strategy, "Request changes")).toBeDefined();
      // Approving a hire still opens its confirmation page.
      apiMocks.approve.mockResolvedValue(createApproval({ id: "approval-hire", type: "hire_agent", status: "approved" }));
      await act(async () => button(hire, "Approve").click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("approval-hire"));
      await vi.waitFor(() =>
        expect(routerMock.navigate).toHaveBeenCalledWith("/approvals/approval-hire?resolved=approved"));
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("stays on the inbox when a hire is approved while another decision is on its way, with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    apiMocks.agentsList.mockResolvedValue([{ id: "agent-1", name: "Infra Engineer" }]);
    apiMocks.approvalsList.mockResolvedValue([
      createApproval({
        id: "approval-hire",
        type: "hire_agent",
        requestedByAgentId: "agent-1",
        payload: { name: "Pricing Analyst", role: "researcher", capabilities: "Tracks competitor prices weekly." },
      }),
      createApproval({
        id: "approval-strategy",
        type: "approve_ceo_strategy",
        requestedByAgentId: "agent-1",
        payload: { plan: "1. Grow wholesale.\n2. Cut returns." },
      }),
    ]);
    const sent = new Map<string, ReturnType<typeof createDeferred<Approval>>>();
    apiMocks.approve.mockImplementation((id: string) => {
      const deferred = createDeferred<Approval>();
      sent.set(id, deferred);
      return deferred.promise;
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Hire Agent: Pricing Analyst"));
      const rowFor = (text: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(text))!;
      const button = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
      const hire = rowFor("Hire Agent: Pricing Analyst");
      const strategy = rowFor("CEO Strategy");

      // Both decisions are on their way at once.
      await act(async () => button(hire, "Approve").click());
      await act(async () => button(strategy, "Approve").click());
      await vi.waitFor(() => expect(sent.size).toBe(2));

      // The hire lands first. Leaving now would drop whatever the strategy comes back with.
      await act(async () => {
        sent.get("approval-hire")!.resolve(createApproval({ id: "approval-hire", type: "hire_agent", status: "approved" }));
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(routerMock.navigate).not.toHaveBeenCalled();

      // The strategy fails, and its error is shown on its own row.
      await act(async () => sent.get("approval-strategy")!.reject(new Error("Session expired")));
      await vi.waitFor(() =>
        expect(rowFor("CEO Strategy").textContent).toContain("Error while approving: Session expired"));
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(apiMocks.approve).toHaveBeenCalledTimes(2);

      // With nothing else on its way, the retried strategy opens its confirmation page as before.
      await act(async () => button(rowFor("CEO Strategy"), "Approve").click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledTimes(3));
      await act(async () => {
        sent.get("approval-strategy")!.resolve(
          createApproval({ id: "approval-strategy", type: "approve_ceo_strategy", status: "approved" }),
        );
      });
      await vi.waitFor(() =>
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith("/approvals/approval-strategy?resolved=approved"));
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("stays on the inbox when a hire is approved after another decision has failed, with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    apiMocks.agentsList.mockResolvedValue([{ id: "agent-1", name: "Infra Engineer" }]);
    apiMocks.approvalsList.mockResolvedValue([
      createApproval({
        id: "approval-hire",
        type: "hire_agent",
        requestedByAgentId: "agent-1",
        payload: { name: "Pricing Analyst", role: "researcher", capabilities: "Tracks competitor prices weekly." },
      }),
      createApproval({
        id: "approval-strategy",
        type: "approve_ceo_strategy",
        requestedByAgentId: "agent-1",
        payload: { plan: "1. Grow wholesale.\n2. Cut returns." },
      }),
    ]);
    const sent = new Map<string, ReturnType<typeof createDeferred<Approval>>>();
    apiMocks.approve.mockImplementation((id: string) => {
      const deferred = createDeferred<Approval>();
      sent.set(id, deferred);
      return deferred.promise;
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Hire Agent: Pricing Analyst"));
      const rowFor = (text: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(text))!;
      const button = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

      await act(async () => button(rowFor("Hire Agent: Pricing Analyst"), "Approve").click());
      await act(async () => button(rowFor("CEO Strategy"), "Approve").click());
      await vi.waitFor(() => expect(sent.size).toBe(2));

      // The strategy fails first. It is no longer on its way, but its error is on its row.
      await act(async () => sent.get("approval-strategy")!.reject(new Error("Session expired")));
      await vi.waitFor(() =>
        expect(rowFor("CEO Strategy").textContent).toContain("Error while approving: Session expired"));

      // The hire lands afterwards. Leaving now would drop that error with the inbox.
      await act(async () => {
        sent.get("approval-hire")!.resolve(createApproval({ id: "approval-hire", type: "hire_agent", status: "approved" }));
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(rowFor("CEO Strategy").textContent).toContain("Error while approving: Session expired");

      // A row's own error does not hold back its own retry: the strategy opens its confirmation page.
      await act(async () => button(rowFor("CEO Strategy"), "Approve").click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledTimes(3));
      await act(async () => {
        sent.get("approval-strategy")!.resolve(
          createApproval({ id: "approval-strategy", type: "approve_ceo_strategy", status: "approved" }),
        );
      });
      await vi.waitFor(() =>
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith("/approvals/approval-strategy?resolved=approved"));
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("opens a hire's confirmation page again once the row whose decision failed has left the screen, with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    apiMocks.agentsList.mockResolvedValue([{ id: "agent-1", name: "Infra Engineer" }]);
    const hire = createApproval({
      id: "approval-hire",
      type: "hire_agent",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      payload: { name: "Pricing Analyst", role: "researcher", capabilities: "Tracks competitor prices weekly." },
    });
    const strategy = createApproval({
      id: "approval-strategy",
      type: "approve_ceo_strategy",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      payload: { plan: "1. Grow wholesale.\n2. Cut returns." },
    });
    let listed: Approval[] = [hire, strategy];
    apiMocks.approvalsList.mockImplementation(async () => listed);
    const sent = new Map<string, ReturnType<typeof createDeferred<Approval>>>();
    apiMocks.approve.mockImplementation((id: string) => {
      const deferred = createDeferred<Approval>();
      sent.set(id, deferred);
      return deferred.promise;
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Hire Agent: Pricing Analyst"));
      const rowFor = (text: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(text));
      const button = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

      // A colleague rejected the strategy a moment ago: the server refuses this approval.
      await act(async () => button(rowFor("CEO Strategy")!, "Approve").click());
      await vi.waitFor(() => expect(sent.size).toBe(1));
      await act(async () => sent.get("approval-strategy")!.reject(new Error("Only pending approvals can be approved")));
      await vi.waitFor(() =>
        expect(rowFor("CEO Strategy")!.textContent).toContain("Error while approving: Only pending approvals can be approved"));

      // The list reloads. The server still lists the request, as rejected by that colleague, and
      // Mine does not show a request someone else decided: the row and its error leave the screen.
      const decidedAt = new Date("2026-03-12T00:00:00.000Z");
      listed = [hire, { ...strategy, status: "rejected", decidedByUserId: "user-colleague", decidedAt, updatedAt: decidedAt }];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approvals", "company-1"] });
      });
      await vi.waitFor(() => expect(rowFor("CEO Strategy")).toBeUndefined());
      expect(container.textContent).not.toContain("Error while approving");

      // No row shows an error any more: the hire opens its confirmation page.
      await act(async () => button(rowFor("Hire Agent: Pricing Analyst")!, "Approve").click());
      await vi.waitFor(() => expect(sent.size).toBe(2));
      await act(async () => {
        sent.get("approval-hire")!.resolve({ ...hire, status: "approved" });
      });
      await vi.waitFor(() =>
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith("/approvals/approval-hire?resolved=approved"));
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("shows an honest missing-source state in the inbox with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    apiMocks.approvalsList.mockResolvedValue([createApproval({
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      payload: {
        title: "Historical email approval",
        recommendedAction: "Review the proposed reply",
        reasoning: "Consider the documented risk",
        subject: "Re: historical request",
        body: "A generated outbound draft is not the original email",
      },
    })]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Historical email approval"));
      const row = [...container.querySelectorAll("[data-inbox-item]")]
        .find((item) => item.textContent?.includes("Historical email approval"))!;
      const text = row.textContent!;
      expect(text).toContain("no original request attached");
      // What is missing is stated; the row does not guess that the request is old.
      expect(text).toContain("No pros or risks were recorded.");
      expect(text).not.toContain("Older request");
      // The outbound draft is shown as a draft, after the decision brief; it never fills the source slot.
      expect(row.querySelector("pre")).toBeNull();
      expect(text).not.toContain("Original request");
      expect(text).not.toContain("was not retained");
      const draft = row.querySelector("[data-approval-draft]")!;
      expect(draft.textContent).toContain("Draft reply");
      expect(draft.textContent).toContain("A generated outbound draft is not the original email");
      expect(text.indexOf("Recommendation")).toBeLessThan(text.indexOf("Why"));
      expect(text.indexOf("Why")).toBeLessThan(text.indexOf("Draft reply"));
      expect(text.indexOf("Draft reply")).toBeLessThan(text.indexOf("ApproveRequest changesReject"));
      // A short draft is shown whole: there is nothing to expand.
      expect(draft.querySelector("button")).toBeNull();
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("opens a cut email draft instead of approving it unread with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    const ending = "We will ship the same day and split the order at no extra charge.";
    const draftBody = (length: number) => {
      const filler = "Our wholesale terms are in the attached price list. ";
      const room = length - ending.length - 2;
      return `${filler.repeat(Math.ceil(room / filler.length)).slice(0, room)}\n\n${ending}`;
    };
    const longBody = draftBody(2000);
    const shortBody = draftBody(900);
    expect(longBody).toHaveLength(2000);
    expect(shortBody).toHaveLength(900);
    const emailApproval = (id: string, title: string, body: string) => createApproval({
      id,
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      payload: {
        title,
        recommendedAction: "Send the drafted reply",
        reasoning: "Nothing in the reply commits to a delivery date",
        recipient: "buyer@example.test",
        subject: "Re: wholesale order",
        body,
      },
    });
    apiMocks.approvalsList.mockResolvedValue([
      emailApproval("approval-long", "Long wholesale reply", longBody),
      emailApproval("approval-short", "Short wholesale reply", shortBody),
    ]);
    apiMocks.approve.mockImplementation(async (id: string) =>
      createApproval({ id, type: "request_board_approval", status: "approved" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Long wholesale reply"));
      const rowFor = (title: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(title))!;
      const button = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
      const shownBody = (row: Element) => row.querySelector("[data-approval-draft-body]")!.textContent ?? "";
      const heldBack = (row: Element) =>
        [...row.querySelectorAll("[role='status']")]
          .some((status) => status.textContent === "Read the full reply, then approve.");

      // The long draft is cut near 1,500 characters behind a button that states its size; the short one is whole.
      const long = rowFor("Long wholesale reply");
      const short = rowFor("Short wholesale reply");
      const draft = long.querySelector<HTMLElement>("[data-approval-draft]")!;
      expect(shownBody(long)).not.toContain(ending);
      expect(shownBody(long).length).toBeGreaterThan(1400);
      // The body box holds only the email's own words; that it continues is said under it, above the button.
      expect(longBody.startsWith(shownBody(long))).toBe(true);
      expect(shownBody(long)).not.toContain("…");
      expect(draft.querySelector("[class*='line-clamp']")).toBeNull();
      const expander = button(long, `Show full reply (${longBody.length.toLocaleString()} characters)`);
      expect(expander.getAttribute("aria-expanded")).toBe("false");
      const continues = draft.querySelector("[data-approval-draft-continues]")!;
      expect(continues.textContent).toBe(
        `The reply continues: ${(longBody.length - shownBody(long).length).toLocaleString()} more characters.`,
      );
      expect(continues.nextElementSibling).toBe(expander);
      expect(shownBody(short)).toBe(shortBody);
      expect(short.querySelector("[data-approval-draft] button")).toBeNull();
      expect(short.querySelector("[data-approval-draft-continues]")).toBeNull();
      // The button says before the press that it opens the reply; a draft shown whole keeps "Approve".
      expect(button(long, "Approve")).toBeUndefined();
      expect(button(long, "Read full reply to approve").getAttribute("aria-label")).toBe(
        "Read full reply to approve: Board Approval: Long wholesale reply",
      );
      expect(button(short, "Read full reply to approve")).toBeUndefined();
      // Under each draft the row says what approval sets in motion: the requesting agent is told; nothing is sent here.
      for (const row of [long, short]) {
        expect(row.querySelector("[data-approval-reply-effect]")!.textContent).toBe(
          "If approved, the requester is told to send this reply to buyer@example.test.",
        );
      }

      // The first press opens the draft and puts focus on it; nothing is sent.
      await act(async () => button(long, "Read full reply to approve").click());
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(shownBody(long)).toBe(longBody);
      expect(draft.querySelector("[data-approval-draft-continues]")).toBeNull();
      expect(button(long, "Read full reply to approve")).toBeUndefined();
      expect(button(long, "Approve").getAttribute("aria-label")).toBe("Approve: Board Approval: Long wholesale reply");
      expect(button(long, "Show less").getAttribute("aria-expanded")).toBe("true");
      expect(heldBack(long)).toBe(true);
      expect(heldBack(short)).toBe(false);
      await vi.waitFor(() => expect(document.activeElement).toBe(draft));

      // A draft that is shown whole is approved at once.
      await act(async () => button(short, "Approve").click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledExactlyOnceWith("approval-short"));

      // With the whole draft on the page, the next Approve sends.
      await vi.waitFor(() => expect(button(long, "Approve").disabled).toBe(false));
      await act(async () => button(long, "Approve").click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("approval-long"));
      expect(apiMocks.approve).toHaveBeenCalledTimes(2);
      expect(heldBack(long)).toBe(false);
      expect(apiMocks.reject).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("names who sent the original request and shows the summary with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    const authorId = "44444444-4444-4444-8444-444444444444";
    apiMocks.agentsList.mockResolvedValue([{ id: authorId, name: "Infra Engineer" }]);
    const sentAt = "2026-10-07T01:23:48.000Z";
    const commentApproval = (id: string, title: string, sender: string) => createApproval({
      id,
      type: "request_board_approval",
      requestedByAgentId: authorId,
      payload: {
        title,
        summary: "Estimated cost is $42/month for provider X.",
        recommendedAction: "Approve provider X",
        reasoning: "It meets every condition in the request",
        pros: ["Fixed monthly commitment"],
        risks: ["The bill rises if traffic doubles"],
        channel: "email from info@",
        subject: "Re: hosting",
        body: "We will go with provider X.",
        originalRequest: {
          text: "Use provider X if it stays under $50.",
          source: {
            kind: "paperclip_comment",
            commentId: "22222222-2222-4222-8222-222222222222",
            issueId: "33333333-3333-4333-8333-333333333333",
            sender,
            sentAt,
            snapshotOrigin: "server",
          },
        },
      },
    });
    apiMocks.approvalsList.mockResolvedValue([
      commentApproval("approval-agent", "Asked by an agent", authorId),
      commentApproval("approval-board", "Asked by the board", "local-board"),
      commentApproval("approval-unknown", "Asked by someone unknown", "55555555-5555-4555-8555-555555555555"),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Asked by an agent"));
      const rowFor = (title: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(title))!;
      const time = new Date(sentAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const note = `${time} · Saved from the original comment · View comment`;

      await vi.waitFor(() => expect(rowFor("Asked by an agent").textContent).toContain(`Infra Engineer · ${note}`));
      expect(rowFor("Asked by the board").textContent).toContain(`Board · ${note}`);
      expect(rowFor("Asked by someone unknown").textContent).toContain(`Original request${note}`);
      // No id of a sender and no storage jargon reaches the row.
      for (const leaked of ["local-board", authorId, "55555555-5555-4555-8555-555555555555", "snapshot"]) {
        expect(container.textContent).not.toContain(leaked);
      }
      expect(time).not.toMatch(/\d:\d\d:\d\d/);

      const text = rowFor("Asked by an agent").textContent!;
      expect(text).toContain("SummaryEstimated cost is $42/month for provider X.");
      expect(text.indexOf("SummaryEstimated cost")).toBeLessThan(text.indexOf("RecommendationApprove provider X"));
      // The channel is not a sender address. With no recipient, the row names nobody the reply goes to.
      const draft = rowFor("Asked by an agent").querySelector("[data-approval-draft]")!;
      expect(draft.textContent).toContain("Viaemail from info@");
      expect(draft.textContent).not.toContain("From");
      expect(container.querySelector("[data-approval-reply-effect]")).toBeNull();
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("offers no decision on a request sent back for changes with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    apiMocks.agentsList.mockResolvedValue([{ id: "agent-1", name: "Pricing Agent" }]);
    const sentBackAt = new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000);
    const sentBack = (overrides: Partial<Approval>) => createApproval({
      status: "revision_requested",
      requestedByAgentId: "agent-1",
      decisionNote: "Quote the delivery date.",
      decidedByUserId: "user-board-1",
      decidedAt: sentBackAt,
      updatedAt: sentBackAt,
      ...overrides,
    });
    apiMocks.approvalsList.mockResolvedValue([
      sentBack({
        id: "approval-board",
        type: "request_board_approval",
        payload: { title: "Sent back request", recommendedAction: "Approve it", reasoning: "It fits the request" },
      }),
      // A type with no decision summary would otherwise get the plain Approve / Reject buttons.
      sentBack({
        id: "approval-plain",
        type: "custom_gate" as Approval["type"],
        requestedByAgentId: null,
        decidedAt: null,
        decisionNote: null,
        payload: { title: "Plain sent back request" },
      }),
      createApproval({
        id: "approval-open",
        type: "request_board_approval",
        requestedByAgentId: "agent-1",
        payload: { title: "Open request", recommendedAction: "Approve it", reasoning: "It fits the request" },
      }),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Waiting on Pricing Agent to revise"));
      const rowFor = (title: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(title))!;
      const buttons = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].filter((candidate) => candidate.textContent === label);

      const board = rowFor("Sent back request");
      const waiting = board.querySelector("[data-approval-sent-back]")!;
      expect(waiting.textContent).toContain("Waiting on Pricing Agent to revise");
      expect(waiting.textContent).toContain("Sent back 2h ago");
      expect(waiting.textContent).toContain("Changes you asked forQuote the delivery date.");
      // The summary of what was sent back is still there to read.
      expect(board.textContent).toContain("Approve it");
      for (const label of ["Approve", "Reject", "Request changes", "Add a note"]) {
        expect(buttons(board, label)).toHaveLength(0);
      }
      expect(board.textContent).not.toContain("user-board-1");
      expect(board.querySelector('a[to="/approvals/approval-board"]')).not.toBeNull();

      const plain = rowFor("Plain sent back request");
      expect(plain.querySelector("[data-approval-sent-back]")!.textContent).toContain(
        "Waiting on the requester to revise",
      );
      expect(plain.textContent).not.toContain("Changes you asked for");
      expect(buttons(plain, "Approve")).toHaveLength(0);
      expect(buttons(plain, "Reject")).toHaveLength(0);

      // A pending request beside them keeps its buttons.
      const open = rowFor("Open request");
      expect(open.querySelector("[data-approval-sent-back]")).toBeNull();
      expect(buttons(open, "Approve")).toHaveLength(1);
      expect(buttons(open, "Request changes")).toHaveLength(1);
      expect(apiMocks.approve).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("holds Approve back when a request is revised while its row is open with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    const NOTICE = "The requester revised this request while it was open. Review it before you decide.";
    const boardApproval = (overrides: Partial<Approval> = {}) => createApproval({
      id: "approval-board",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      payload: { title: "Hosting request", recommendedAction: "Approve provider X", reasoning: "It fits the request" },
      ...overrides,
    });
    const plainApproval = (overrides: Partial<Approval> = {}) => createApproval({
      id: "approval-plain",
      type: "custom_gate" as Approval["type"],
      payload: { title: "Plain request", limit: 100 },
      ...overrides,
    });
    const untouched = (overrides: Partial<Approval> = {}) => createApproval({
      id: "approval-same",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      payload: { title: "Unchanged request", recommendedAction: "Approve it", reasoning: "It fits the request" },
      ...overrides,
    });
    apiMocks.approvalsList.mockResolvedValue([boardApproval(), plainApproval(), untouched()]);
    apiMocks.approve.mockImplementation(async (id: string) => createApproval({ id, status: "approved" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Hosting request"));
      const rowFor = (title: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(title))!;
      const buttons = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].filter((candidate) => candidate.textContent === label);
      const notice = (row: Element) => row.querySelector<HTMLElement>("[data-approval-revised]");
      const board = rowFor("Hosting request");
      const plain = rowFor("Plain request");
      const same = rowFor("Unchanged request");
      expect(container.textContent).not.toContain(NOTICE);

      // The board starts a note, then the requester resubmits two of the three requests with new content.
      await act(async () => buttons(board, "Add a note")[0].click());
      await act(async () => {
        const note = board.querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Month to month only");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const later = new Date("2026-03-11T00:10:00.000Z");
      apiMocks.approvalsList.mockResolvedValue([
        boardApproval({
          updatedAt: later,
          payload: { title: "Hosting request", recommendedAction: "Approve provider Y at twice the price", reasoning: "It fits the request" },
        }),
        plainApproval({ updatedAt: later, payload: { title: "Plain request", limit: 900 } }),
        // Only the time changed here.
        untouched({ updatedAt: later }),
      ]);
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approvals", "company-1"] });
      });
      await vi.waitFor(() => expect(board.textContent).toContain("Approve provider Y at twice the price"));

      expect(notice(board)!.textContent).toContain(NOTICE);
      expect(notice(plain)!.textContent).toContain(NOTICE);
      expect(notice(same)).toBeNull();
      // The notice comes before the revised summary, and the note is still there.
      const recommendation = [...board.querySelectorAll("p")].find((p) => p.textContent === "Recommendation")!;
      expect(notice(board)!.compareDocumentPosition(recommendation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(board.querySelector("textarea")!.value).toBe("Month to month only");

      // Approve sends nothing until the revision is confirmed, on the shared controls and on the plain buttons.
      await act(async () => buttons(board, "Approve")[0].click());
      for (const approve of buttons(plain, "Approve")) await act(async () => approve.click());
      expect(buttons(plain, "Approve").length).toBeGreaterThan(0);
      expect(apiMocks.approve).not.toHaveBeenCalled();
      expect(
        [...board.querySelectorAll("[role='status']")].map((status) => status.textContent),
      ).toContain("Confirm that you have reviewed the revised request, then approve.");

      // A request whose content did not change is approved at once.
      await act(async () => buttons(same, "Approve")[0].click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledExactlyOnceWith("approval-same"));

      await act(async () => buttons(board, "I have reviewed it")[0].click());
      expect(board.textContent).not.toContain(NOTICE);
      expect(board.contains(document.activeElement)).toBe(true);
      expect(board.querySelector("textarea")!.value).toBe("Month to month only");
      await act(async () => buttons(board, "Approve")[0].click());
      await vi.waitFor(() =>
        expect(apiMocks.approve).toHaveBeenCalledWith("approval-board", "Month to month only"));

      await act(async () => buttons(plain, "I have reviewed it")[0].click());
      await act(async () => buttons(plain, "Approve")[0].click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledWith("approval-plain"));
      expect(apiMocks.approve).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it.each([true, false])("keeps a pending decision and its error on the row it belongs to with streamlined UI %s", async (streamlinedUi) => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
    const boardApproval = (id: string, title: string) => createApproval({
      id,
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      payload: { title, recommendedAction: "Approve it", reasoning: "It fits the request" },
    });
    apiMocks.approvalsList.mockResolvedValue([
      boardApproval("approval-a", "First request"),
      boardApproval("approval-b", "Second request"),
      // A type with no decision summary gets the plain Approve / Reject buttons.
      createApproval({ id: "approval-plain", type: "custom_gate" as Approval["type"], payload: { title: "Plain request" } }),
    ]);
    const sent = new Map<string, ReturnType<typeof createDeferred<Approval>>>();
    apiMocks.approve.mockImplementation((id: string) => {
      const deferred = createDeferred<Approval>();
      sent.set(id, deferred);
      return deferred.promise;
    });
    apiMocks.reject.mockRejectedValue(new Error("Not allowed"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Second request"));
      const rowFor = (title: string) =>
        [...container.querySelectorAll("[data-inbox-item]")].find((item) => item.textContent?.includes(title))!;
      const buttons = (row: Element, label: string) =>
        [...row.querySelectorAll("button")].filter((candidate) => candidate.textContent === label);
      const alerts = (scope: ParentNode) => [...scope.querySelectorAll("[role='alert']")];
      const rowA = rowFor("First request");
      const rowB = rowFor("Second request");
      const plain = rowFor("Plain request");

      // A decision on its way locks and labels its own row only.
      await act(async () => buttons(rowA, "Approve")[0].click());
      await vi.waitFor(() => expect(sent.has("approval-a")).toBe(true));
      expect(buttons(rowA, "Approving...")[0].disabled).toBe(true);
      expect(buttons(rowA, "Reject")[0].disabled).toBe(true);
      expect(buttons(rowA, "Approving...")[0].closest("[aria-busy]")!.getAttribute("aria-busy")).toBe("true");
      expect(buttons(rowB, "Approve")[0].disabled).toBe(false);
      expect(buttons(rowB, "Reject")[0].disabled).toBe(false);
      expect(buttons(rowB, "Approving...")).toHaveLength(0);
      expect(buttons(plain, "Approve").every((candidate) => !candidate.disabled)).toBe(true);
      expect(buttons(plain, "Approve").length).toBeGreaterThan(0);

      // The second row can be decided while the first is still sending, and neither unlocks the other.
      await act(async () => buttons(rowB, "Approve")[0].click());
      await vi.waitFor(() => expect(sent.has("approval-b")).toBe(true));
      expect(buttons(rowA, "Approving...")[0].disabled).toBe(true);
      expect(buttons(rowB, "Approving...")[0].disabled).toBe(true);

      // A failure is reported on its own row, as an alert above that row's buttons.
      await act(async () => sent.get("approval-a")!.reject(new Error("Session expired")));
      await vi.waitFor(() => expect(alerts(rowA)).toHaveLength(1));
      expect(alerts(rowA)[0].textContent).toBe("Error while approving: Session expired");
      expect(alerts(rowA)[0].nextElementSibling!.contains(buttons(rowA, "Approve")[0])).toBe(true);
      expect(alerts(container)).toHaveLength(1);
      expect(buttons(rowA, "Approve")[0].disabled).toBe(false);
      expect(buttons(rowB, "Approving...")[0].disabled).toBe(true);

      // A row with the plain buttons shows its error under them, once.
      await act(async () => buttons(plain, "Reject")[0].click());
      await vi.waitFor(() => expect(alerts(plain)).toHaveLength(1));
      expect(apiMocks.reject).toHaveBeenCalledExactlyOnceWith("approval-plain");
      expect(alerts(plain)[0].textContent).toBe("Error while rejecting: Not allowed");
      expect(alerts(plain)[0]).toBe(plain.querySelector("[role='alert']:last-child"));
      expect(alerts(container)).toHaveLength(2);
      expect(alerts(rowB)).toHaveLength(0);
      expect(buttons(plain, "Reject").every((candidate) => !candidate.disabled)).toBe(true);

      // Sending the first row's decision again takes its error away.
      await act(async () => buttons(rowA, "Approve")[0].click());
      await vi.waitFor(() => expect(apiMocks.approve).toHaveBeenCalledTimes(3));
      expect(alerts(rowA)).toHaveLength(0);
      expect(alerts(plain)).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it("restores folded and unfolded sub-tasks across remounts", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const storageKey = "paperclip:inbox:collapsed-parents:company-1";
    localStorage.removeItem(storageKey);

    const parent = createIssue({
      id: "parent-issue",
      identifier: "PAP-1001",
      title: "Parent inbox task",
    });
    const child = createIssue({
      id: "child-issue",
      identifier: "PAP-1002",
      parentId: parent.id,
      title: "Nested inbox task",
    });
    const grandchild = createIssue({
      id: "grandchild-issue",
      identifier: "PAP-1003",
      parentId: child.id,
      title: "Deeply nested inbox task",
    });
    apiMocks.issuesList.mockResolvedValue([parent, child, grandchild]);

    const mountInbox = async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
      });
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain(parent.title);
      });
      return root;
    };
    const parentToggle = () => {
      const parentRow = Array.from(container.querySelectorAll("[data-inbox-item]"))
        .find((row) => row.textContent?.includes(parent.title));
      return parentRow?.querySelector<HTMLButtonElement>('button[data-slot="icon-button"]') ?? null;
    };

    let root = await mountInbox();
    try {
      expect(container.textContent).toContain(child.title);
      expect(container.textContent).toContain(grandchild.title);
      const taskRowFor = (title: string) =>
        Array.from(container.querySelectorAll('[data-slot="task-row"]'))
          .find((row) => row.textContent?.includes(title));
      const childTaskRow = taskRowFor(child.title);
      const grandchildTaskRow = taskRowFor(grandchild.title);
      expect(childTaskRow?.querySelectorAll('[data-slot="task-row-tree-guide"]')).toHaveLength(1);
      expect(childTaskRow?.querySelector('button[aria-label="Collapse sub-tasks"]')).not.toBeNull();
      expect(grandchildTaskRow?.querySelectorAll('[data-slot="task-row-tree-guide"]')).toHaveLength(2);
      expect(grandchildTaskRow?.querySelector('[data-slot="task-row-disclosure-spacer"]')).not.toBeNull();

      await act(async () => {
        parentToggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(container.textContent).not.toContain(child.title);
        expect(container.textContent).not.toContain(grandchild.title);
      });
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([parent.id]);

      act(() => root.unmount());
      root = await mountInbox();
      expect(container.textContent).not.toContain(child.title);

      await act(async () => {
        parentToggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain(child.title);
        expect(container.textContent).toContain(grandchild.title);
      });
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([]);

      act(() => root.unmount());
      root = await mountInbox();
      expect(container.textContent).toContain(child.title);
      expect(container.textContent).toContain(grandchild.title);
    } finally {
      localStorage.removeItem(storageKey);
      act(() => root.unmount());
    }
  });

  it("shows blocked toolbar controls on the Blocked tab", async () => {
    routerMock.location.pathname = "/inbox/blocked";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector('input[placeholder="Search inbox…"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inbox-blocked-tab-badge"]')).toBeNull();
    expect(container.querySelector('button[title="Filter"]')).not.toBeNull();
    expect(container.querySelector('button[title="Group"]')).not.toBeNull();
    expect(container.querySelector('button[title="Columns"]')).not.toBeNull();
    expect(container.querySelector('button[title="Sort"]')).not.toBeNull();
    expect(container.querySelector('button[title="Enable parent-child nesting"]')).toBeNull();
    expect(container.textContent).not.toContain("Mark all as read");

    act(() => {
      root.unmount();
    });
  });

  it("keeps Mine, Recent, Unread, Blocked, and All in the shared toolbar geometry", async () => {
    for (const tab of ["mine", "recent", "unread", "blocked", "all"] as const) {
      routerMock.location.pathname = `/inbox/${tab}`;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
      });
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });

      const toolbar = container.querySelector('[data-slot="collection-toolbar"]');
      expect(toolbar?.getAttribute("aria-label")).toBe("Inbox controls");
      expect(toolbar?.querySelector('[data-slot="collection-toolbar-context"]')).not.toBeNull();
      expect(toolbar?.querySelector('[data-slot="collection-toolbar-search"] input[placeholder="Search inbox…"]')).not.toBeNull();
      expect(toolbar?.querySelector('[data-slot="collection-toolbar-controls"]')).not.toBeNull();
      expect(container.querySelectorAll('input[placeholder="Search inbox…"]')).toHaveLength(1);

      act(() => root.unmount());
      container.replaceChildren();
    }
  });

  it("explains that live-run filtering is different from active task statuses", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:filters:company-1", JSON.stringify({
      allCategoryFilter: "everything",
      allApprovalFilter: "all",
      issueFilters: { liveOnly: true },
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector('[data-testid="inbox-filter-scope-feedback"]')?.textContent)
      .toBe("Live runs only — tasks currently connected to an agent run.");
    const migrated = JSON.parse(
      localStorage.getItem("paperclip:task-collection:v1:company-1:inbox") ?? "null",
    ) as { companyId?: string; collectionKey?: string } | null;
    expect(migrated).toMatchObject({ companyId: "company-1", collectionKey: "inbox" });

    act(() => root.unmount());
  });

  it("groups ungrouped attention items by Today, Yesterday, and Earlier", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const now = new Date();
    const localNoon = (daysAgo: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0);
    apiMocks.issuesList.mockResolvedValue([
      createIssue({ id: "today", title: "Today task", lastActivityAt: localNoon(0) }),
      createIssue({ id: "yesterday", title: "Yesterday task", lastActivityAt: localNoon(1) }),
      createIssue({ id: "earlier", title: "Earlier task", lastActivityAt: localNoon(3) }),
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Earlier task"));

    const separators = [...container.querySelectorAll('[data-testid="inbox-date-group"]')];
    expect(separators.map((node) => node.textContent?.trim()))
      .toEqual(["Today", "Yesterday", "Earlier"]);
    expect(separators.every((separator) => (
      separator.querySelectorAll("[data-date-group-rule]").length === 2
    ))).toBe(true);
    expect(separators.every((separator) => (
      separator.querySelector("[data-date-group-label]")?.classList.contains("text-muted-foreground/70")
    ))).toBe(true);

    act(() => root.unmount());
  });

  it("honors the saved Columns option for hiding date group separators", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem(
      taskCollectionPreferencesStorageKey({
        companyId: "company-1",
        collectionKey: "inbox",
      }),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        collectionKey: "inbox",
        viewState: { showDateGroupSeparators: false },
        columns: ["status", "id", "updated"],
      }),
    );
    const now = new Date();
    const localNoon = (daysAgo: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0);
    apiMocks.issuesList.mockResolvedValue([
      createIssue({ id: "today", title: "Today task", lastActivityAt: localNoon(0) }),
      createIssue({ id: "earlier", title: "Earlier task", lastActivityAt: localNoon(3) }),
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Earlier task"));

    expect(container.querySelector('[data-testid="inbox-date-group"]')).toBeNull();

    act(() => root.unmount());
  });

  it("shows the resolved isolated workspace name in canonical task metadata", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "workspace", "updated"]));
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: true });
    apiMocks.executionWorkspaceSummaries.mockResolvedValue([{
      id: "execution-workspace-1",
      name: "Workspace Aurora",
      mode: "isolated_workspace",
      projectWorkspaceId: "project-workspace-1",
    }]);
    apiMocks.projectsList.mockResolvedValue([{
      id: "project-1",
      name: "Launch",
      color: null,
      workspaces: [{ id: "project-workspace-1", name: "Main" }],
      executionWorkspacePolicy: { defaultProjectWorkspaceId: "project-workspace-1" },
      primaryWorkspace: null,
    }]);
    apiMocks.issuesList.mockResolvedValue([createIssue({
      projectId: "project-1",
      executionWorkspaceId: "execution-workspace-1",
      title: "Workspace-aware task",
    })]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    // Workspace metadata resolves independently of the task list.
    await vi.waitFor(() => {
      expect(container.querySelector('[data-slot="task-row"]')?.textContent).toContain("Workspace Aurora");
    });

    const taskRow = container.querySelector('[data-slot="task-row"]');
    const identifier = taskRow?.querySelector('[data-slot="task-row-identifier"]');
    const timestamp = taskRow?.querySelector('[data-slot="task-row-timestamp"]');
    expect(taskRow?.textContent).toContain("Workspace Aurora");
    expect(identifier?.textContent).toBe("PAP-904");
    expect(timestamp).not.toBeNull();
    if (!identifier || !timestamp) throw new Error("Expected canonical identifier and timestamp columns");
    expect(identifier.compareDocumentPosition(timestamp) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    act(() => root.unmount());
  });

  it("hides workspace grouping when isolated workspaces are disabled", async () => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: false });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    const groupButton = container.querySelector<HTMLButtonElement>('button[title="Group"]');
    expect(groupButton).not.toBeNull();

    await act(async () => {
      groupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const groupOptions = Array.from(document.body.querySelectorAll("button")).map((button) => button.textContent);
    expect(groupOptions).not.toContain("Workspace");

    act(() => {
      root.unmount();
    });
  });

  it("requests live descendant summaries for issue rows", async () => {
    routerMock.location.pathname = "/inbox/mine";

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(apiMocks.issuesList).toHaveBeenCalledTimes(3);
    });

    expect(apiMocks.issuesList.mock.calls.map((call) => call[1]?.includeLiveDescendantSummary)).toEqual([
      true,
      true,
      true,
    ]);
    expect(apiMocks.issuesList.mock.calls.map((call) => call[1]?.limit)).toEqual([
      500,
      500,
      500,
    ]);

    act(() => {
      root.unmount();
    });
  });

  it("paints row hover via CSS only, without moving React selection state", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-1001", title: "First inbox row" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-1002", title: "Second inbox row" });
    apiMocks.issuesList.mockResolvedValue([issueA, issueB]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll("[data-inbox-item]").length).toBeGreaterThanOrEqual(2);
    });

    const rows = container.querySelectorAll("[data-inbox-item]");

    // The hover wash lives on the IssueRow root band (the overlay link's
    // parent), not the overlay link itself.
    const bandOf = (row: Element): HTMLElement | null =>
      row.querySelector<HTMLAnchorElement>("a[data-inbox-issue-link]")?.parentElement ?? null;

    // Nothing selected before hover — both rows show the hover-accent class.
    expect(bandOf(rows[0]!)?.className).toContain("hover:bg-accent/50");
    expect(bandOf(rows[1]!)?.className).toContain("hover:bg-accent/50");

    // Hovering paints via CSS `:hover` only — it must NOT flip a row into the
    // state-selected band (which would swap to hover:bg-transparent). Coupling
    // hover to React state was the per-hover re-render storm behind the lag;
    // scrubbing the list must not touch selection state. (Keyboard nav that
    // continues from the hovered row is exercised in live/e2e verification —
    // this unit mocks keyboardShortcutsEnabled off.)
    await act(async () => {
      rows[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      rows[1]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    });
    expect(bandOf(rows[0]!)?.className).toContain("hover:bg-accent/50");
    expect(bandOf(rows[1]!)?.className).toContain("hover:bg-accent/50");
    expect(bandOf(rows[1]!)?.className).not.toContain("hover:bg-transparent");

    act(() => {
      root.unmount();
    });
  });

  it("does not indent unread rows: the mark-read dot overlays the shared task-row gutter", async () => {
    routerMock.location.pathname = "/inbox/mine";
    // Two sibling leaf rows, one unread and one read, so their leading columns
    // are directly comparable.
    const unread = createIssue({
      id: "issue-unread",
      identifier: "PAP-2001",
      title: "Unread inbox row",
      isUnreadForMe: true,
    });
    const read = createIssue({
      id: "issue-read",
      identifier: "PAP-2002",
      title: "Read inbox row",
      isUnreadForMe: false,
    });
    apiMocks.issuesList.mockResolvedValue([unread, read]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Unread inbox row");
      expect(container.textContent).toContain("Read inbox row");
    });

    const rows = Array.from(container.querySelectorAll("[data-inbox-item]"));
    const rowFor = (text: string) => rows.find((row) => row.textContent?.includes(text));
    const markReadButton = (row: Element) => row.querySelector('button[aria-label="Mark as read"]');
    // The canonical spacer reserves the disclosure column on every leaf row.
    const hasLeadingSpacer = (row: Element) =>
      !!row.querySelector('[data-slot="task-row-disclosure-spacer"]');
    // The overlay anchor is present on read AND unread Inbox rows without
    // consuming a layout column.
    const dotSlot = (row: Element) =>
      row.querySelector('[data-testid="issue-row-unread-slot"]');

    const unreadRow = rowFor("Unread inbox row")!;
    const readRow = rowFor("Read inbox row")!;

    // Both rows share the canonical task-row geometry. The dot is absolutely
    // positioned in the row gutter, so Inbox does not gain a column that Tasks
    // lacks and unread state cannot shift status/title alignment.
    const unreadSlot = dotSlot(unreadRow);
    const readSlot = dotSlot(readRow);
    expect(unreadSlot).not.toBeNull();
    expect(readSlot).not.toBeNull();
    expect(unreadSlot?.className).toContain("absolute");
    // Only the unread row carries the dot button; the read slot is empty.
    expect(markReadButton(unreadSlot!)).not.toBeNull();
    expect(readSlot?.querySelector('button[aria-label="Mark as read"]')).toBeNull();
    expect(hasLeadingSpacer(unreadRow)).toBe(true);

    // Read rows keep the same spacer, so both rows line up.
    expect(hasLeadingSpacer(readRow)).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it("keeps hover→j/k selection in sync after the list reshapes (PAP-9679)", async () => {
    routerMock.location.pathname = "/inbox/mine";
    generalSettingsMock.keyboardShortcutsEnabled = true;
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-2001", title: "Sync row A" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-2002", title: "Sync row B" });
    const issueC = createIssue({ id: "issue-c", identifier: "PAP-2003", title: "Sync row C" });
    apiMocks.issuesList.mockResolvedValue([issueA, issueB, issueC]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    // Canonical task rows put the selected wash on the root band (the overlay
    // link's parent); find the row with the standalone selected utility.
    const bandOf = (row: Element): HTMLElement | null =>
      row.querySelector<HTMLAnchorElement>("a[data-inbox-issue-link]")?.parentElement ?? null;
    const selectedRowIndex = () =>
      [...container.querySelectorAll("[data-inbox-item]")].findIndex((row) =>
        bandOf(row)?.className.split(/\s+/).includes("bg-accent/50"),
      );

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.querySelectorAll("[data-inbox-item]").length).toBeGreaterThanOrEqual(3);
      });

      // Pointer physically moves, then hovers the middle row (index 1).
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        const rows = container.querySelectorAll("[data-inbox-item]");
        rows[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        rows[1]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      });

      // A poll reshapes the list (row B's title changes → new nav array) before
      // the keypress. This is what used to null the hovered index and strand
      // j/k back at the top.
      apiMocks.issuesList.mockResolvedValue([issueA, { ...issueB, title: "Sync row B (updated)" }, issueC]);
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Sync row B (updated)");
      });

      // j must continue from the hovered row (index 1) → index 2, not jump to
      // the top of the list.
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      });
      expect(selectedRowIndex()).toBe(2);
    } finally {
      generalSettingsMock.keyboardShortcutsEnabled = false;
      act(() => {
        root.unmount();
      });
    }
  });

  it.each([true, false])(
    "presses a focused button in an approval row on Enter and still opens the selected row otherwise, streamlined UI %s",
    async (streamlinedUi) => {
      routerMock.location.pathname = "/inbox/mine";
      generalSettingsMock.keyboardShortcutsEnabled = true;
      localStorage.setItem("paperclip:inbox:group-by", "none");
      apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: streamlinedUi });
      const boardApproval = (id: string, title: string, createdAt: string) =>
        createApproval({
          id,
          type: "request_board_approval",
          requestedByAgentId: "agent-1",
          payload: { title, recommendedAction: "Approve it.", reasoning: "It fits the request." },
          createdAt: new Date(createdAt),
          updatedAt: new Date(createdAt),
        });
      apiMocks.approvalsList.mockResolvedValue([
        boardApproval("approval-a", "First request", "2026-03-11T00:00:00.000Z"),
        boardApproval("approval-b", "Second request", "2026-03-12T00:00:00.000Z"),
      ]);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const root = createRoot(container);

      const rows = () => [...container.querySelectorAll<HTMLElement>("[data-inbox-item]")];
      const approvalIdOf = (row: HTMLElement) => (row.textContent?.includes("First request") ? "approval-a" : "approval-b");
      const buttonIn = (row: HTMLElement, label: string) =>
        [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
      // A key press goes to the element that holds focus, as in a browser.
      const press = async (key: string) => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        await act(async () => {
          (document.activeElement ?? document.body).dispatchEvent(event);
        });
        return event;
      };
      // Stands for a tab or a toolbar button: a button that is in no inbox row.
      const outside = document.createElement("button");

      try {
        await act(async () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
        await vi.waitFor(() => {
          expect(rows()).toHaveLength(2);
          expect(container.textContent).toContain("Second request");
        });
        const [first, second] = rows();

        // j selects the first row; focus stays on the page.
        await press("j");

        // Enter on a focused button of the row is left to the browser, which presses the button.
        // (Archive is left out: it takes Enter in a handler of its own.)
        for (const label of ["Approve", "Request changes", "Reject", "Add a note"]) {
          const control = buttonIn(first, label);
          control.focus();
          expect(document.activeElement).toBe(control);
          expect((await press("Enter")).defaultPrevented, label).toBe(false);
        }
        expect(routerMock.navigate).not.toHaveBeenCalled();

        // The same holds in the middle of a change request, and the typed note stays.
        await act(async () => buttonIn(first, "Request changes").click());
        const note = first.querySelector("textarea")!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Quote the delivery date");
          note.dispatchEvent(new Event("input", { bubbles: true }));
        });
        buttonIn(first, "Send request").focus();
        expect((await press("Enter")).defaultPrevented).toBe(false);
        expect(routerMock.navigate).not.toHaveBeenCalled();
        expect(first.querySelector("textarea")!.value).toBe("Quote the delivery date");
        expect(apiMocks.requestRevision).not.toHaveBeenCalled();

        // j moves the selection on and takes focus off the button, so Enter opens the new row.
        await press("j");
        expect(document.activeElement).toBe(document.body);
        expect((await press("Enter")).defaultPrevented).toBe(true);
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith(`/approvals/${approvalIdOf(second)}`);

        // k does the same on the way back.
        routerMock.navigate.mockReset();
        buttonIn(second, "Approve").focus();
        await press("k");
        expect(document.activeElement).toBe(document.body);
        await press("Enter");
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith(`/approvals/${approvalIdOf(first)}`);

        // From a button outside the rows, Enter still opens the selected row.
        routerMock.navigate.mockReset();
        document.body.appendChild(outside);
        outside.focus();
        expect((await press("Enter")).defaultPrevented).toBe(true);
        expect(routerMock.navigate).toHaveBeenCalledExactlyOnceWith(`/approvals/${approvalIdOf(first)}`);
        // j from there keeps its focus: only a button inside a row is let go.
        await press("j");
        expect(document.activeElement).toBe(outside);

        expect(apiMocks.approve).not.toHaveBeenCalled();
        expect(apiMocks.reject).not.toHaveBeenCalled();
      } finally {
        outside.remove();
        generalSettingsMock.keyboardShortcutsEnabled = false;
        act(() => root.unmount());
        queryClient.clear();
      }
    },
  );

  it("holds the inbox order across a reordering poll, then re-sorts at an attention boundary (PAP-16015)", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const base = new Date("2026-03-11T00:00:00.000Z").getTime();
    const issueA = createIssue({
      id: "issue-a",
      identifier: "PAP-3001",
      title: "Pin row A",
      lastActivityAt: new Date(base + 3000),
    });
    const issueB = createIssue({
      id: "issue-b",
      identifier: "PAP-3002",
      title: "Pin row B",
      lastActivityAt: new Date(base + 2000),
    });
    const issueC = createIssue({
      id: "issue-c",
      identifier: "PAP-3003",
      title: "Pin row C",
      lastActivityAt: new Date(base + 1000),
    });
    apiMocks.issuesList.mockResolvedValue([issueA, issueB, issueC]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    // Collapse each displayed row to its A/B/C identity so we can assert order.
    const orderOf = () =>
      [...container.querySelectorAll("[data-inbox-item]")].flatMap((row) => {
        const text = row.textContent ?? "";
        if (text.includes("Pin row A")) return ["A"];
        if (text.includes("Pin row B")) return ["B"];
        if (text.includes("Pin row C")) return ["C"];
        return [];
      });

    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    };
    let nowValue = base + 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValue);

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.querySelectorAll("[data-inbox-item]").length).toBeGreaterThanOrEqual(3);
      });
      expect(orderOf()).toEqual(["A", "B", "C"]);

      // A poll makes row C the most-recently-active: the fresh sort is now [C, A, B].
      apiMocks.issuesList.mockResolvedValue([
        { ...issueA },
        { ...issueB },
        { ...issueC, lastActivityAt: new Date(base + 9000) },
      ]);
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Pin row C");
      });

      // No attention boundary has fired, so the displayed order is held, not reshuffled.
      expect(orderOf()).toEqual(["A", "B", "C"]);

      // The tab is hidden long enough to lose attention, then regains focus: that
      // visibility boundary is a commit point, so the inbox adopts the fresh order.
      await act(async () => {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      nowValue += 31_000;
      await act(async () => {
        setVisibility("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await vi.waitFor(() => {
        expect(orderOf()).toEqual(["C", "A", "B"]);
      });
    } finally {
      nowSpy.mockRestore();
      if (visibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      } else {
        setVisibility("visible");
      }
      act(() => {
        root.unmount();
      });
    }
  });

  it("keeps other issue archive controls enabled while one archive is pending", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-1001", title: "First inbox row" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-1002", title: "Second inbox row" });
    apiMocks.issuesList.mockResolvedValue([issueA, issueB]);
    const archiveA = createDeferred<{ id: string; archivedAt: Date }>();
    apiMocks.archiveFromInbox.mockImplementation((id: string) =>
      id === "issue-a" ? archiveA.promise : Promise.resolve({ id, archivedAt: new Date() }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("First inbox row");
      expect(container.textContent).toContain("Second inbox row");
    });

    const initialArchiveButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Archive"]'),
    );
    expect(initialArchiveButtons.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      initialArchiveButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => {
      expect(apiMocks.archiveFromInbox).toHaveBeenCalledWith("issue-a");
      expect(container.textContent).not.toContain("First inbox row");
      expect(container.textContent).toContain("Second inbox row");
    });

    const remainingArchiveButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Archive"]',
    );
    expect(remainingArchiveButton).not.toBeNull();
    expect(remainingArchiveButton?.disabled).toBe(false);

    await act(async () => {
      remainingArchiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => {
      expect(apiMocks.archiveFromInbox).toHaveBeenCalledWith("issue-b");
    });

    await act(async () => {
      archiveA.resolve({ id: "issue-a", archivedAt: new Date() });
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps a successful archive hidden when stale query data arrives", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const archivedIssue = createIssue({
      id: "issue-a",
      identifier: "PAP-1001",
      title: "Archived inbox row",
    });
    apiMocks.issuesList.mockResolvedValue([archivedIssue]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Archived inbox row");
    });

    const archiveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
    expect(archiveButton).not.toBeNull();

    await act(async () => {
      archiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => {
      expect(apiMocks.archiveFromInbox).toHaveBeenCalledWith("issue-a");
      expect(container.textContent).not.toContain("Archived inbox row");
    });

    await act(async () => {
      queryClient.setQueriesData<Issue[]>(
        { queryKey: ["issues", "company-1", "mine-by-me"] },
        [archivedIssue],
      );
    });

    expect(container.textContent).not.toContain("Archived inbox row");

    act(() => {
      root.unmount();
    });
  });

  it("restores a locally hidden archive when undo is pressed", async () => {
    generalSettingsMock.keyboardShortcutsEnabled = true;
    routerMock.location.pathname = "/inbox/mine";
    const archivedIssue = createIssue({
      id: "issue-a",
      identifier: "PAP-1001",
      title: "Undoable inbox row",
    });
    apiMocks.issuesList.mockResolvedValue([archivedIssue]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Undoable inbox row");
      });

      const archiveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
      expect(archiveButton).not.toBeNull();
      await act(async () => {
        archiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await vi.waitFor(() => {
        expect(container.textContent).not.toContain("Undoable inbox row");
        expect(queryClient.isMutating()).toBe(0);
      });

      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(apiMocks.unarchiveFromInbox).toHaveBeenCalledWith("issue-a");
        expect(container.textContent).toContain("Undoable inbox row");
      });
    } finally {
      generalSettingsMock.keyboardShortcutsEnabled = false;
      act(() => root.unmount());
    }
  });
});

describe("FailedRunInboxRow", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("suppresses accent hover styling when selected", () => {
    const root = createRoot(container);
    const run = createFailedRun();

    act(() => {
      root.render(
        <FailedRunInboxRow
          run={run}
          issueById={new Map()}
          agentName="Agent"
          issueLinkState={null}
          onDismiss={() => {}}
          onRetry={() => {}}
          isRetrying={false}
          selected
        />,
      );
    });

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.className).toContain("hover:bg-transparent");
    expect(link?.className).not.toContain("hover:bg-accent/50");

    act(() => {
      root.unmount();
    });
  });
});

describe("InboxIssueMetaLeading", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("keeps status and live accents visible", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<InboxIssueMetaLeading issue={createIssue()} isLive />);
    });

    // The status glyph is an <svg> coloured from its --status-task-icon-* var.
    const statusIcon = Array.from(container.querySelectorAll("svg")).find((svg) =>
      (svg.getAttribute("style") ?? "").includes("--status-task-icon"),
    );
    const liveBadge = container.querySelector('span[class*="px-1.5"][class*="bg-blue-500/10"]');
    const liveBadgeLabel = Array.from(container.querySelectorAll("span")).find(
      // The pill chassis is a Badge (itself a span with textContent "Live");
      // the label is the inner span without the rounded-full chassis class.
      (node) => node.textContent === "Live" && node.className.includes("text-") && !node.className.includes("rounded-full"),
    );
    const liveDot = container.querySelector('span[class*="bg-blue-500"]');
    const pulseRing = container.querySelector('span[class*="animate-pulse"]');

    expect(statusIcon).not.toBeUndefined();
    // Status accent stays visible — not neutralized to muted.
    expect(statusIcon?.getAttribute("class") ?? "").not.toContain("!text-muted-foreground");
    expect(liveBadge).not.toBeNull();
    expect(liveBadge?.className).toContain("bg-blue-500/10");
    expect(liveBadgeLabel).not.toBeNull();
    expect(liveBadgeLabel?.className).toContain("text-blue-600");
    expect(liveDot).not.toBeNull();
    expect(pulseRing).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });
});

describe("InboxIssueTrailingColumns", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders an empty tags cell when an issue has no labels", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <InboxIssueTrailingColumns
          issue={createIssue({ labels: [], labelIds: [] })}
          columns={["labels"]}
          projectName={null}
          projectColor={null}
          workspaceName={null}
          assigneeName={null}
          currentUserId={null}
          parentIdentifier={null}
          parentTitle={null}
        />,
      );
    });

    expect(container.textContent).toBe("");

    act(() => {
      root.unmount();
    });
  });

  it("leaves the workspace cell blank when no explicit workspace label should be shown", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <InboxIssueTrailingColumns
          issue={createIssue()}
          columns={["workspace"]}
          projectName={null}
          projectColor={null}
          workspaceName={null}
          assigneeName={null}
          currentUserId={null}
          parentIdentifier={null}
          parentTitle={null}
        />,
      );
    });

    expect(container.textContent).toBe("");

    act(() => {
      root.unmount();
    });
  });
});

describe("formatJoinRequestInboxLabel", () => {
  it("shows the human requester's name and email when available", () => {
    expect(formatJoinRequestInboxLabel(createJoinRequest())).toBe(
      "Jordan Example (joiner@example.com)",
    );
  });

  it("falls back to the email snapshot when the requester profile is missing", () => {
    expect(
      formatJoinRequestInboxLabel(
        createJoinRequest({
          requesterUser: null,
          requestEmailSnapshot: "snapshot@example.com",
          requestingUserId: null,
        }),
      ),
    ).toBe("snapshot@example.com");
  });
});

describe("InboxGroupHeader", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows a left caret and expanded state for collapsible mobile headers", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<InboxGroupHeader label="Primary workspace (default)" collapsible collapsed={false} />);
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.textContent).toContain("Primary workspace (default)");
    const caret = container.querySelector("svg");
    expect(caret?.className.baseVal).toContain("rotate-90");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the caret collapsed when the mobile group is hidden", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<InboxGroupHeader label="Feature Branch" collapsible collapsed />);
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    const caret = container.querySelector("svg");
    expect(caret?.className.baseVal).not.toContain("rotate-90");

    act(() => {
      root.unmount();
    });
  });
});
