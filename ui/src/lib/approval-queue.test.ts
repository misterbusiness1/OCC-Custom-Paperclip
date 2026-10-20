import { beforeEach, describe, expect, it, vi } from "vitest";

const listQueue = vi.hoisted(() => vi.fn());
vi.mock("../api/approvals", () => ({ approvalsApi: { listQueue } }));

import { fetchApprovalList, resetApprovalQueueWindows, widenDecidedWindow } from "./approval-queue";

describe("the approvals list window", () => {
  beforeEach(() => {
    listQueue.mockReset();
    resetApprovalQueueWindows();
  });

  it("starts at one page and widens by a page while the server says more exist", async () => {
    listQueue.mockImplementation(async (_companyId: string, decidedLimit: number) => ({
      approvals: [],
      decidedLimit,
      decidedHasMore: decidedLimit < 300,
    }));

    expect(widenDecidedWindow("c1")).toBe(false);
    await fetchApprovalList("c1");
    expect(listQueue).toHaveBeenLastCalledWith("c1", 100);
    expect(widenDecidedWindow("c1")).toBe(true);
    await fetchApprovalList("c1");
    expect(listQueue).toHaveBeenLastCalledWith("c1", 200);
    expect(widenDecidedWindow("c1")).toBe(true);
    await fetchApprovalList("c1");
    expect(listQueue).toHaveBeenLastCalledWith("c1", 300);
    expect(widenDecidedWindow("c1")).toBe(false);
  });

  it("keeps a window per company", async () => {
    listQueue.mockImplementation(async (_companyId: string, decidedLimit: number) => ({ approvals: [], decidedLimit, decidedHasMore: true }));
    await fetchApprovalList("c1");
    widenDecidedWindow("c1");
    await fetchApprovalList("c2");
    expect(listQueue).toHaveBeenLastCalledWith("c2", 100);
    await fetchApprovalList("c1");
    expect(listQueue).toHaveBeenLastCalledWith("c1", 200);
  });
});
