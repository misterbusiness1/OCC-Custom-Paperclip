---
title: Approvals
summary: Approval workflow endpoints
---

Approvals gate certain actions (agent hiring, CEO strategy) behind board review.

## List Approvals

```
GET /api/companies/{companyId}/approvals
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (e.g. `pending`) |

## Get Approval

```
GET /api/approvals/{approvalId}
```

Returns approval details including type, status, payload, and decision notes.

## Create Approval Request

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Create Hire Request

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

Creates a draft agent and a linked `hire_agent` approval.

## Approve

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## Reject

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## Request Revision

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## Expected Version

Approve, Reject and Request Revision accept an optional `expectedUpdatedAt`: the `updatedAt` of the approval as the caller read it, as an ISO 8601 string.

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved.", "expectedUpdatedAt": "2026-10-07T12:34:56.789Z" }
```

When the field is sent and the approval has changed since (resubmitted, sent back, decided, cancelled), nothing is stored and the answer is `409`:

```
{
  "error": "This request changed after you opened it. Reload it and decide again.",
  "code": "approval_version_conflict",
  "details": {
    "code": "approval_version_conflict",
    "currentStatus": "pending",
    "currentUpdatedAt": "2026-10-07T12:40:00.000Z",
    "expectedUpdatedAt": "2026-10-07T12:34:56.789Z"
  }
}
```

Read the approval again and decide on what it shows now. Every change of an approval's state or payload (send-back, resubmission, decision, cancellation, a budget decision that marks it) moves `updatedAt` to a later millisecond than the stored one, also when two changes fall within the same millisecond; comments and issue links do not move it. The comparison is made at millisecond precision, the precision of the value the API returns, so two versions of an approval never read the same. A value that is not an ISO 8601 date-time is a `400`.

Without the field the routes behave as before: the decision is applied to whatever version is stored, and repeating a decision that is already stored changes nothing.

## Resubmit

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

Only a `revision_requested` approval can be resubmitted (`422` otherwise). An agent can resubmit only an approval it requested. The caller needs the same access as for reading or creating an approval: write access to the company and its company scope. Without it the answer is `403`, also for the agent that requested the approval. `payload` is optional; without it the stored payload is kept.

The approval returns to `pending` with `decidedAt` and `decidedByUserId` cleared. `decisionNote` is kept: on a `pending` approval it is the board's change request that this revision answers. The next decision overwrites it.

## Linked Issues

```
GET /api/approvals/{approvalId}/issues
```

Returns issues linked to this approval.

## Approval Comments

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

Both need the same company-scope access as reading the approval (`403` without it).

## Approval Lifecycle

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
