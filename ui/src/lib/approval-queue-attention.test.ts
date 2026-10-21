import { describe, expect, it } from "vitest";
import type { ApprovalQueueAttention } from "@paperclipai/shared";
import { approvalQueueMissingOwner } from "./approval-queue-attention";

const base: ApprovalQueueAttention = {
  revisionRequestedAt: null, owner: { agentId: "requester", userId: null, name: "Requester", status: "idle" },
  tasks: [], staleReasons: [], supersededByApprovalId: null,
};
const task = (status: string, agentId: string | null = null, userId: string | null = null) => ({
  id: "task", identifier: "QA-1", status, assigneeAgentId: agentId, assigneeUserId: userId,
  blockerAction: null, nextFollowUpAt: null,
});
describe("revision queue missing ownership", () => {
  it("flags linkless revisions even with an agent or board requester", () => {
    expect(approvalQueueMissingOwner(base)).toBe(true);
    expect(approvalQueueMissingOwner({ ...base, owner: { ...base.owner, agentId: null, userId: "board" } })).toBe(true);
  });
  it("accepts assigned active links independently of requester identity", () => {
    for (const linked of [task("todo", "other-agent"), task("blocked", null, "board")]) {
      expect(approvalQueueMissingOwner({ ...base, tasks: [linked] })).toBe(false);
    }
  });
  it("ignores absent assignees on terminal-only links while preserving missing requester attention", () => {
    const tasks = [task("done"), { ...task("cancelled"), id: "cancelled" }];
    expect(approvalQueueMissingOwner({ ...base, tasks })).toBe(false);
    expect(approvalQueueMissingOwner({ ...base, tasks, owner: { ...base.owner, agentId: null } })).toBe(true);
    expect(approvalQueueMissingOwner({ ...base, tasks: [...tasks, { ...task("todo"), id: "active" }] })).toBe(true);
  });
});
