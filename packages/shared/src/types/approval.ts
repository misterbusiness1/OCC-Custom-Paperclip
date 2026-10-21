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
  /**
   * What the board reads when it decides: a hash of the type, the stored payload and the change
   * request. Send it back with `expectedUpdatedAt` and `expectedStatus` when deciding, so a newer
   * version that asks the same thing (an unchanged resubmission) is decided instead of refused.
   * Absent from servers older than this field.
   */
  contentVersion?: string;
}

/**
 * `GET /api/companies/:companyId/approvals/queue?decidedLimit=`: every open approval (pending or
 * sent back) and the `decidedLimit` most recently decided ones. `decidedHasMore` says whether older
 * decided approvals exist; read them by asking again with a larger `decidedLimit`.
 */
export interface ApprovalQueue {
  approvals: Approval[];
  decidedLimit: number;
  decidedHasMore: boolean;
}

/** The create response normalizes the approval's durable issue links. */
export interface CreatedApproval extends Approval {
  issueIds: string[];
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
