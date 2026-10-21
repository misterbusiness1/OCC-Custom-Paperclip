// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { ApprovalQueueAttention } from "./ApprovalQueueAttention";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.innerHTML = ""; });
function render(status: Approval["status"], attention: NonNullable<Approval["queueAttention"]>) {
  const el = document.createElement("div"); document.body.append(el);
  const root = createRoot(el); roots.push(root);
  act(() => root.render(<ApprovalQueueAttention approval={{ status, queueAttention: attention } as Approval} />));
  return el.textContent!;
}
const base = {
  revisionRequestedAt: null,
  owner: { agentId: null, userId: null, name: null, status: null },
  tasks: [], staleReasons: [], supersededByApprovalId: null,
};
describe("approval queue attention", () => {
  it("makes missing revision ownership, decision time and follow-up explicit", () => {
    const text = render("revision_requested", base);
    expect(text).toContain("decision time not recorded");
    expect(text).toContain("missing owner");
    expect(text).toContain("Next follow-up: not scheduled");
    expect(text).not.toContain("overdue");
  });
  it("shows a real blocker and only marks a recorded follow-up overdue", () => {
    const text = render("revision_requested", { ...base,
      revisionRequestedAt: new Date("2020-01-01Z"),
      owner: { agentId: "owner", userId: null, name: "Revision requester", status: "paused" },
      tasks: [{ id: "task", identifier: "OXFA-1", status: "blocked", assigneeAgentId: "owner", assigneeUserId: null,
        blockerAction: "Await board decision", nextFollowUpAt: new Date("2020-02-01Z") }],
    });
    expect(text).toContain("Revision requester (paused)");
    expect(text).toContain("OXFA-1: Await board decision");
    expect(text).toContain("overdue");
  });
  it("shows exact-cycle blocked work with its follow-up while retaining the outstanding revision", () => {
    const text = render("revision_requested", { ...base, revisionOutcome: {
      outcome: "durable_blocker", blocker: "Recipient contract needs board action", nextAction: "Check board response",
      nextFollowUpAt: new Date("2099-01-01T00:00:00.000Z"), executionActive: true, attemptCount: 1, recordedAt: new Date(),
    } });
    expect(text).toContain("Revision still outstanding; resubmission required.");
    expect(text).toContain("Work outcome: blocked; agent execution active");
    expect(text).toContain("Successful execution alone does not complete a revision");
    expect(text).toContain("Recipient contract needs board action");
    expect(text).toContain("Check board response");
    expect(text).not.toContain("Next follow-up: not scheduled");
  });
  it("shows stale approvals as review flags instead of declaring them completed", () => {
    const text = render("pending", { ...base, staleReasons: ["linked_task_closed", "explicitly_superseded"], supersededByApprovalId: "replacement" });
    expect(text).toContain("approval is still open");
    expect(text).toContain("explicitly superseded by approval replacement");
  });
});
