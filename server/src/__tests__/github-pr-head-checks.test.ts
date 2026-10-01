import { describe, expect, it, vi } from "vitest";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createGitHubPrHeadCheckService } from "../services/github-pr-head-checks.ts";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

function createDispatcherWithResponses(responses: Record<string, ToolResult>) {
  return {
    listToolsForAgent: vi.fn(() => ([
      { name: "github:_get_pr_info" },
      { name: "github:_get_commit_combined_status" },
      { name: "github:_fetch_commit_workflow_runs" },
      { name: "github:_fetch_pr_comments" },
    ])),
    executeTool: vi.fn(async (toolName: string) => ({
      pluginId: "github",
      toolName,
      result: responses[toolName] ?? { data: {} },
    })),
  };
}

function createWorkProduct() {
  const now = new Date("2026-05-16T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request" as const,
    provider: "github",
    externalId: null,
    title: "occ-mcp-server PR 39",
    url: "https://github.com/oxfordcigarcompany/occ-mcp-server/pull/39",
    status: "active",
    reviewState: "none" as const,
    isPrimary: true,
    healthStatus: "unknown" as const,
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

const issueContext = {
  id: "issue-1",
  companyId: "company-1",
  projectId: "project-1",
};

const runContext = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
  projectId: "project-1",
};

describe("createGitHubPrHeadCheckService", () => {
  it("falls back to PR comments when native GitHub checks are empty and marks passed", async () => {
    const dispatcher = createDispatcherWithResponses({
      "github:_get_pr_info": {
        data: {
          repository_full_name: "oxfordcigarcompany/occ-mcp-server",
          pr_number: 39,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      },
      "github:_get_commit_combined_status": { data: { statuses: [] } },
      "github:_fetch_commit_workflow_runs": { data: { workflow_runs: [] } },
      "github:_fetch_pr_comments": {
        data: {
          comments: [
            {
              body: '<!-- paperclip-head-check: {"headSha":"abcdef1234567890abcdef1234567890abcdef12","state":"passed"} -->',
              user: { login: "occ-review-bot[bot]" },
              html_url: "https://github.com/oxfordcigarcompany/occ-mcp-server/pull/39#issuecomment-1",
            },
          ],
        },
      },
    });
    const svc = createGitHubPrHeadCheckService(dispatcher as any);

    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "passed",
      source: "pr_comment",
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
    }));
  });

  it("classifies pending and failed comment fallback states", async () => {
    const dispatcher = createDispatcherWithResponses({
      "github:_get_pr_info": {
        data: {
          repository_full_name: "oxfordcigarcompany/occ-mcp-server",
          pr_number: 39,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      },
      "github:_get_commit_combined_status": { data: { statuses: [] } },
      "github:_fetch_commit_workflow_runs": { data: { workflow_runs: [] } },
      "github:_fetch_pr_comments": {
        data: {
          comments: [
            { body: '<!-- paperclip-head-check: {"headSha":"abcdef1234567890abcdef1234567890abcdef12","state":"pending"} -->', user: { login: "occ-review-bot[bot]" } },
            { body: '<!-- paperclip-head-check: {"headSha":"abcdef1234567890abcdef1234567890abcdef12","state":"failed"} -->', user: { login: "occ-review-bot[bot]" } },
          ],
        },
      },
    });
    const svc = createGitHubPrHeadCheckService(dispatcher as any);

    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "failed",
      source: "pr_comment",
    }));
  });

  it("ignores human MEMBER structured records and unstructured bot prose", async () => {
    const dispatcher = createDispatcherWithResponses({
      "github:_get_pr_info": {
        data: {
          repository_full_name: "oxfordcigarcompany/occ-mcp-server",
          pr_number: 39,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      },
      "github:_get_commit_combined_status": { data: { statuses: [] } },
      "github:_fetch_commit_workflow_runs": { data: { workflow_runs: [] } },
      "github:_fetch_pr_comments": {
        data: {
          comments: [
            {
              body: "Head abcdef1234567890abcdef1234567890abcdef12 passed scoped CI.",
              user: { login: "occ-review-bot[bot]" },
            },
            {
              body: '<!-- paperclip-head-check: {"headSha":"abcdef1234567890abcdef1234567890abcdef12","state":"passed"} -->',
              author_association: "MEMBER",
              user: { login: "repository-member" },
            },
          ],
        },
      },
    });
    const svc = createGitHubPrHeadCheckService(dispatcher as any);

    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "no_evidence",
      source: "none",
    }));
  });

  it("makes terminal workflow failure win over a pending run", async () => {
    const dispatcher = createDispatcherWithResponses({
      "github:_get_pr_info": {
        data: {
          repository_full_name: "oxfordcigarcompany/occ-mcp-server",
          pr_number: 39,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      },
      "github:_get_commit_combined_status": { data: { statuses: [] } },
      "github:_fetch_commit_workflow_runs": {
        data: {
          workflow_runs: [
            { status: "in_progress", conclusion: null },
            { status: "completed", conclusion: "failure" },
          ],
        },
      },
    });
    const svc = createGitHubPrHeadCheckService(dispatcher as any);

    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "failed",
      source: "workflow_run",
    }));
  });

  it("returns no_evidence when commit statuses, workflow runs, and PR comments are empty", async () => {
    const dispatcher = createDispatcherWithResponses({
      "github:_get_pr_info": {
        data: {
          repository_full_name: "oxfordcigarcompany/occ-mcp-server",
          pr_number: 39,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      },
      "github:_get_commit_combined_status": { data: { statuses: [] } },
      "github:_fetch_commit_workflow_runs": { data: { workflow_runs: [] } },
      "github:_fetch_pr_comments": { data: { comments: [] } },
    });
    const svc = createGitHubPrHeadCheckService(dispatcher as any);

    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "no_evidence",
      source: "none",
    }));
  });

  it("prefers workflow runs over PR comments when native statuses are empty", async () => {
    const dispatcher = createDispatcherWithResponses({
      "github:_get_pr_info": {
        data: {
          repository_full_name: "oxfordcigarcompany/occ-mcp-server",
          pr_number: 39,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      },
      "github:_get_commit_combined_status": { data: { statuses: [] } },
      "github:_fetch_commit_workflow_runs": {
        data: {
          workflow_runs: [{ status: "completed", conclusion: "failure" }],
        },
      },
      "github:_fetch_pr_comments": {
        data: {
          comments: [{ body: '<!-- paperclip-head-check: {"headSha":"abcdef1234567890abcdef1234567890abcdef12","state":"passed"} -->', user: { login: "occ-review-bot[bot]" } }],
        },
      },
    });
    const svc = createGitHubPrHeadCheckService(dispatcher as any);

    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "failed",
      source: "workflow_run",
    }));
  });

  it("recovers when GitHub tools are unavailable at service construction and appear later", async () => {
    let toolsAvailable = false;
    const dispatcher = {
      listToolsForAgent: vi.fn(() => (
        toolsAvailable
          ? [
            { name: "github:_get_pr_info" },
            { name: "github:_get_commit_combined_status" },
            { name: "github:_fetch_commit_workflow_runs" },
            { name: "github:_fetch_pr_comments" },
          ]
          : []
      )),
      executeTool: vi.fn(async (toolName: string) => ({
        pluginId: "github",
        toolName,
        result: {
          data: toolName === "github:_get_pr_info"
            ? {
              repository_full_name: "oxfordcigarcompany/occ-mcp-server",
              pr_number: 39,
              head_sha: "abcdef1234567890abcdef1234567890abcdef12",
            }
            : toolName === "github:_get_commit_combined_status"
              ? { statuses: [] }
              : toolName === "github:_fetch_commit_workflow_runs"
                ? { workflow_runs: [] }
                : {
                  comments: [
                    {
                      body: '<!-- paperclip-head-check: {"headSha":"abcdef1234567890abcdef1234567890abcdef12","state":"passed"} -->',
                      user: { login: "occ-review-bot[bot]" },
                    },
                  ],
                },
        },
      })),
    };
    const svc = createGitHubPrHeadCheckService(dispatcher as any);

    toolsAvailable = true;
    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({
      state: "passed",
      source: "pr_comment",
    }));
  });

  it("does not execute plugin tools without an authenticated agent run context", async () => {
    const dispatcher = createDispatcherWithResponses({});
    const svc = createGitHubPrHeadCheckService(dispatcher as any);
    const workProduct = createWorkProduct();

    const [result] = await svc.enrichForIssue(issueContext, [workProduct]);

    expect(result).toBe(workProduct);
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("propagates the authenticated identity across the real dispatcher boundary", async () => {
    const call = vi.fn(async (_pluginId: string, _method: string, params: any) => ({
      data: params.toolName === "_get_pr_info"
        ? {
          repository_full_name: "oxfordcigarcompany/occ-mcp-server",
          pr_number: 39,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        }
        : params.toolName === "_get_commit_combined_status"
          ? { statuses: [{ state: "success" }] }
          : {},
    }));
    const workerManager = {
      isRunning: vi.fn(() => true),
      call,
    } as unknown as PluginWorkerManager;
    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.registerPluginTools("github", {
      id: "github",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "GitHub",
      description: "Test fixture",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "dist/worker.js" },
      tools: [
        "_get_pr_info",
        "_get_commit_combined_status",
        "_fetch_commit_workflow_runs",
        "_fetch_pr_comments",
      ].map((name) => ({
        name,
        displayName: name,
        description: name,
        parametersSchema: { type: "object", properties: {} },
      })),
    } as unknown as PaperclipPluginManifestV1, "github-plugin-db-id");
    const svc = createGitHubPrHeadCheckService(dispatcher);

    const [result] = await svc.enrichForIssue(issueContext, [createWorkProduct()], runContext);

    expect(result?.metadata?.githubHeadCheck).toEqual(expect.objectContaining({ state: "passed" }));
    expect(call).toHaveBeenCalledWith(
      "github-plugin-db-id",
      "executeTool",
      expect.objectContaining({ runContext }),
    );
  });
});
