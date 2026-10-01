import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import {
  buildHeartbeatProgressLogLine,
  heartbeatHistoryHasNextPage,
  heartbeatProgressLogLineKey,
  mergeHeartbeatRunPages,
  scopedDeepLinkedRun,
  syncAgentRouteAfterRename,
} from "./AgentDetail";
import type { HeartbeatRun } from "@paperclipai/shared";

function run(id: string, companyId = "company-1", agentId = "agent-1"): HeartbeatRun {
  return { id, companyId, agentId } as HeartbeatRun;
}

describe("heartbeat history paging", () => {
  it("appends pages with id deduplication", () => {
    expect(
      mergeHeartbeatRunPages([
        [run("run-3"), run("run-2")],
        [run("run-2"), run("run-1")],
      ]).map((item) => item.id),
    ).toEqual(["run-3", "run-2", "run-1"]);
  });

  it("stops paging when a page is shorter than the requested limit", () => {
    expect(heartbeatHistoryHasNextPage([run("run-2"), run("run-1")], 2)).toBe(true);
    expect(heartbeatHistoryHasNextPage([run("run-1")], 2)).toBe(false);
  });

  it("adds an older targeted run only when company and agent scope match", () => {
    const olderRun = run("older-run");

    expect(scopedDeepLinkedRun(olderRun, "company-1", "agent-1")).toBe(olderRun);
    expect(mergeHeartbeatRunPages([[run("recent-run")]], olderRun).map((item) => item.id)).toEqual([
      "recent-run",
      "older-run",
    ]);
    expect(scopedDeepLinkedRun(olderRun, "company-2", "agent-1")).toBeNull();
    expect(scopedDeepLinkedRun(olderRun, "company-1", "agent-2")).toBeNull();
  });
});

describe("buildHeartbeatProgressLogLine", () => {
  it("renders progress messages with phase prefixes as system log lines", () => {
    expect(
      buildHeartbeatProgressLogLine(
        {
          message: "Syncing issue history",
          phase: "workspace",
          updatedAt: "2026-07-04T05:00:00.000Z",
        },
        "2026-07-04T04:59:00.000Z",
      ),
    ).toEqual({
      ts: "2026-07-04T05:00:00.000Z",
      stream: "system",
      chunk: "[workspace] Syncing issue history",
    });
  });

  it("renders progress messages without phases using the live event timestamp", () => {
    expect(
      buildHeartbeatProgressLogLine(
        { message: "Preparing workspace" },
        "2026-07-04T05:01:00.000Z",
      ),
    ).toEqual({
      ts: "2026-07-04T05:01:00.000Z",
      stream: "system",
      chunk: "Preparing workspace",
    });
  });

  it("ignores empty progress messages", () => {
    expect(
      buildHeartbeatProgressLogLine(
        { message: "   ", phase: "workspace" },
        "2026-07-04T05:02:00.000Z",
      ),
    ).toBeNull();
  });
});

describe("heartbeatProgressLogLineKey", () => {
  it("uses the rendered log line fields as the replay key", () => {
    const line = {
      ts: "2026-07-04T05:03:00.000Z",
      stream: "system" as const,
      chunk: "[workspace] Syncing issue history",
    };

    expect(heartbeatProgressLogLineKey(line)).toBe(
      "2026-07-04T05:03:00.000Z\u0000system\u0000[workspace] Syncing issue history",
    );
  });
});

describe("syncAgentRouteAfterRename", () => {
  it("replaces stale agent routes after a rename changes the URL key", () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    queryClient.setQueryData(queryKeys.agents.detail("old-agent"), { id: "agent-1" });
    queryClient.setQueryData(queryKeys.agents.detail("renamed-agent"), { id: "agent-1" });

    const redirected = syncAgentRouteAfterRename(
      queryClient,
      navigate,
      { id: "agent-1", name: "Old Agent", urlKey: "old-agent" },
      { id: "agent-1", name: "Renamed Agent", urlKey: "renamed-agent" },
      "configuration",
    );

    expect(redirected).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/agents/renamed-agent/configuration", { replace: true });
    expect(queryClient.getQueryData(queryKeys.agents.detail("old-agent"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.agents.detail("renamed-agent"))).toEqual({ id: "agent-1" });
  });

  it("does not redirect when the canonical route ref stays the same", () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    queryClient.setQueryData(queryKeys.agents.detail("same-agent"), { id: "agent-1" });

    const redirected = syncAgentRouteAfterRename(
      queryClient,
      navigate,
      { id: "agent-1", name: "Same Agent", urlKey: "same-agent" },
      { id: "agent-1", name: "Same Agent", urlKey: "same-agent" },
      "configuration",
    );

    expect(redirected).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.agents.detail("same-agent"))).toEqual({ id: "agent-1" });
  });
});
