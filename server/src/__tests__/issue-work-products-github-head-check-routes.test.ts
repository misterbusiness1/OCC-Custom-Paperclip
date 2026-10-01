import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getActiveInboxArchiveFields: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  decide: vi.fn(async () => ({ allowed: true })),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

const mockEnvironmentService = vi.hoisted(() => ({}));
const mockDb = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));

vi.mock("../services/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/index.js")>(),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentsService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      runId: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
      source: "agent_jwt",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any, {
    toolDispatcher: {
      listToolsForAgent: vi.fn(() => ([
        { name: "github:_get_pr_info" },
        { name: "github:_get_commit_combined_status" },
        { name: "github:_fetch_commit_workflow_runs" },
        { name: "github:_fetch_pr_comments" },
      ])),
      executeTool: vi.fn(async (toolName: string) => {
        if (toolName === "github:_get_pr_info") {
          return {
            pluginId: "github",
            toolName,
            result: {
              data: {
                repository_full_name: "oxfordcigarcompany/occ-mcp-server",
                pr_number: 39,
                head_sha: "abcdef1234567890abcdef1234567890abcdef12",
              },
            },
          };
        }
        if (toolName === "github:_get_commit_combined_status") {
          return { pluginId: "github", toolName, result: { data: { statuses: [] } } };
        }
        if (toolName === "github:_fetch_commit_workflow_runs") {
          return { pluginId: "github", toolName, result: { data: { workflow_runs: [] } } };
        }
        return {
          pluginId: "github",
          toolName,
          result: {
            data: {
              comments: [
                {
                  body: '<!-- paperclip-head-check: {"headSha":"abcdef1234567890abcdef1234567890abcdef12","state":"passed"} -->',
                  user: { login: "occ-review-bot[bot]" },
                },
              ],
            },
          },
        };
      }),
    } as any,
  }));
  app.use(errorHandler);
  return app;
}

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "OXFA-5402",
  title: "Restore merge gate signal",
  description: "Add GitHub fallback evidence",
  status: "in_progress",
  priority: "medium",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  updatedAt: new Date("2026-05-16T00:00:00Z"),
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

describe.sequential("issue work product GitHub head-check routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
    mockIssueService.listProductivityReviews.mockResolvedValue(new Map());
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getActiveInboxArchiveFields.mockResolvedValue({});
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockDocumentsService.getIssueDocumentPayload.mockResolvedValue({});
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    const emptyQuery: any = {};
    emptyQuery.from = vi.fn(() => emptyQuery);
    emptyQuery.innerJoin = vi.fn(() => emptyQuery);
    emptyQuery.where = vi.fn(() => emptyQuery);
    emptyQuery.orderBy = vi.fn(() => emptyQuery);
    emptyQuery.limit = vi.fn(async () => []);
    emptyQuery.then = (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    mockDb.select.mockReturnValue(emptyQuery);
    mockDb.execute.mockResolvedValue([]);
    mockProjectService.getById.mockResolvedValue(null);
    mockProjectService.listByIds.mockResolvedValue([]);
    mockGoalService.getById.mockResolvedValue(null);
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "work-product-1",
        companyId: "company-1",
        projectId: issue.projectId,
        issueId: issue.id,
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "pull_request",
        provider: "github",
        externalId: null,
        title: "occ-mcp-server PR 39",
        url: "https://github.com/oxfordcigarcompany/occ-mcp-server/pull/39",
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "unknown",
        summary: null,
        metadata: null,
        createdByRunId: null,
        createdAt: new Date("2026-05-16T00:00:00Z"),
        updatedAt: new Date("2026-05-16T00:00:00Z"),
      },
    ]);
  });

  it("enriches GET /issues/:id/work-products with githubHeadCheck fallback evidence", async () => {
    const res = await request(createApp()).get(`/api/issues/${issue.id}/work-products`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "passed",
      source: "pr_comment",
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
    }));
  });

  it("enriches GET /issues/:id with githubHeadCheck fallback evidence", async () => {
    const res = await request(createApp()).get(`/api/issues/${issue.id}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.workProducts).toHaveLength(1);
    expect(res.body.workProducts[0]?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "passed",
      source: "pr_comment",
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
    }));
  });
});
