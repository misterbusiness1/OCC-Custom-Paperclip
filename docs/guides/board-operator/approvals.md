---
title: Approvals
summary: Governance flows for hiring and strategy
---

Paperclip includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Hire Agent

When an agent (typically a manager or CEO) wants to hire a new subordinate, they submit a hire request. This creates a `hire_agent` approval that appears in your approval queue.

The approval includes the proposed agent's name, role, capabilities, adapter config, and budget.

### CEO Strategy

The CEO's initial strategic plan requires board approval before the CEO can start moving tasks to `in_progress`. This ensures human sign-off on the company direction.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> retired (rejected, without requester wake)
        -> revision_requested -> resubmitted -> pending
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

### Retiring Obsolete Closed Requests

When a `request_board_approval` has become obsolete because all of its linked
issues are already `done` or `cancelled`, the board can retire it through
`POST /api/approvals/{approvalId}/retire`. Supply a nonempty `decisionNote` and
the approval's freshly read `expectedUpdatedAt` value.

Retirement is deliberately conservative: the request must have at least one
linked issue, every linked issue must belong to the same company and be closed,
and no linked issue may retain checkout or execution ownership. An ineligible or
stale request is rejected without changing the approval; re-read the approval
and its links before retrying.

The operation records a rejected administrative disposition and visible
retirement activity, but it does **not** wake the requesting agent or launch the
approved action. Use ordinary rejection when the requester should receive and
act on a rejection. Retirement is board-only and has no UI button; use the API
or typed client.

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config for hires)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign any task to a different agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
