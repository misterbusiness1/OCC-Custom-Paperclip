import type { ApprovalStatus, ApprovalType } from "../constants.js";

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

export interface HydratedApprovalSideEffect {
  label: string;
  detail: string | null;
}

export interface HydratedApprovalRefundDetail {
  orderId: string;
  customerId: string;
  amountUsd: number;
  currency: string | null;
  actionType: string;
  reasonCode: string | null;
  reason: string;
}

export interface HydratedApprovalReplyDetail {
  recipient: string;
  channel: string;
  subject: string;
  proposedMessage: string;
  originalMessage: string | null;
}

/**
 * Opt-in `?v=2` detail contract: replaces the raw `payload` with curated,
 * type-specific fields so consumers never depend on gate-specific payload shape directly.
 */
export interface ApprovalDetailV2 extends Omit<Approval, "payload"> {
  version: 2;
  summary: string;
  sideEffects: HydratedApprovalSideEffect[];
  refund: HydratedApprovalRefundDetail | null;
  reply: HydratedApprovalReplyDetail | null;
  rawPayload?: Record<string, unknown>;
}
