import type { ApprovalStatus, ApprovalType, IssueStatus } from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A task linked to an approval, as the batch read returns it: enough to name it and link to it. */
export interface ApprovalLinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

/**
 * `GET /api/companies/:companyId/approvals/linked-issues?ids=`: the linked
 * tasks of each requested approval, keyed by approval id. An approval without
 * linked tasks, and an id that is not an approval of the company, has no key.
 */
export type ApprovalLinkedIssuesByApproval = Record<string, ApprovalLinkedIssue[]>;
