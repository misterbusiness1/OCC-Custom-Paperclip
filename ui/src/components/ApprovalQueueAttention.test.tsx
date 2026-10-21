// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { ApprovalQueueAttention } from "./ApprovalQueueAttention";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => <a href={to} className={className}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.innerHTML = ""; });
function render(status: Approval["status"], attention: NonNullable<Approval["queueAttention"]>, agentNames?: ReadonlyMap<string, string>) {
  const el = document.createElement("div"); document.body.append(el);
  const root = createRoot(el); roots.push(root);
  act(() => root.render(<ApprovalQueueAttention approval={{ status, queueAttention: attention } as Approval} agentNames={agentNames} />));
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
    expect(text).toContain("Revision still outstanding; resubmission or disposition required.");
    expect(text).toContain("Work outcome: blocked; agent execution active");
    expect(text).toContain("Successful execution alone does not complete a revision");
    expect(text).toContain("Recipient contract needs board action");
    expect(text).toContain("Check board response");
    expect(text).not.toContain("Next follow-up: not scheduled");
  });
  it("keeps the requester separate from reassigned and multiple linked-task owners and links", () => {
    const text = render("revision_requested", { ...base,
      owner: { agentId: "A", userId: null, name: "Requester A", status: "idle" },
      tasks: [
        { id: "first", identifier: "QA-123", status: "todo", assigneeAgentId: "B", assigneeUserId: null, blockerAction: null, nextFollowUpAt: null },
        { id: "second", identifier: null, status: "blocked", assigneeAgentId: null, assigneeUserId: "board-2", blockerAction: "Decision", nextFollowUpAt: null },
        { id: "third", identifier: "QA-125", status: "todo", assigneeAgentId: null, assigneeUserId: null, blockerAction: null, nextFollowUpAt: null },
      ],
    }, new Map([["B", "Current owner B"]]));
    expect(text).toContain("Requester: Requester A");
    expect(text).toContain("QA-123 · todo · Current owner: Current owner B");
    expect(text).toContain("second · blocked · Current owner: board user board-2");
    expect(text).toContain("QA-125 · todo · Current owner: missing owner (unassigned task)");
    expect([...document.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["QA-123", "/issues/QA-123"], ["second", "/issues/second"], ["QA-125", "/issues/QA-125"],
    ]);
  });
  it("preserves assignee identity when an agent name is unavailable", () => {
    const text = render("revision_requested", { ...base, tasks: [
      { id: "task", identifier: "QA-1", status: "todo", assigneeAgentId: "agent-B", assigneeUserId: null, blockerAction: null, nextFollowUpAt: null },
    ] });
    expect(text).toContain("Current owner: agent agent-B");
    expect(text).not.toContain("unassigned task");
  });
  it("shows stale approvals as review flags instead of declaring them completed", () => {
    const text = render("pending", { ...base, staleReasons: ["linked_task_closed", "explicitly_superseded"], supersededByApprovalId: "replacement" });
    expect(text).toContain("approval is still open");
    expect(text).toContain("explicitly superseded by approval replacement");
  });
});
