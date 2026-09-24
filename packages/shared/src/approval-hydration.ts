import type { Approval, ApprovalDetailV2, HydratedApprovalSideEffect } from "./types/approval.js";

const REFUND_ACTION_LABELS: Record<string, string> = {
  refund_full: "Refund issued",
  refund_partial: "Partial refund issued",
  store_credit: "Store credit issued",
  gift_card: "Gift card issued",
  void_auth: "Authorization voided",
  capture_auth: "Authorization captured",
  adjustment: "Order adjustment applied",
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildHireAgentSideEffects(payload: Record<string, unknown>): HydratedApprovalSideEffect[] {
  const name = asString(payload.name) ?? "New agent";
  const role = asString(payload.role) ?? "general";
  const budgetMonthlyCents = asNumber(payload.budgetMonthlyCents);
  const budgetDetail = budgetMonthlyCents && budgetMonthlyCents > 0
    ? ` with a $${(budgetMonthlyCents / 100).toFixed(2)} monthly budget`
    : "";
  return [
    {
      label: "Agent will be hired",
      detail: `${name} (${role}) will be added to the company roster${budgetDetail}`,
    },
  ];
}

function buildRefundSideEffects(payload: Record<string, unknown>): HydratedApprovalSideEffect[] {
  const actionType = asString(payload.actionType) ?? "adjustment";
  const label = REFUND_ACTION_LABELS[actionType] ?? "Order adjustment applied";
  const amountUsd = asNumber(payload.amountUsd);
  const orderId = asString(payload.orderId);
  const customerId = asString(payload.customerId);
  const amountDetail = amountUsd !== null ? `$${amountUsd.toFixed(2)} ` : "";
  const orderDetail = orderId ? ` on order ${orderId}` : "";
  const customerDetail = customerId ? ` for customer ${customerId}` : "";
  return [
    {
      label,
      detail: `${amountDetail}${label.toLowerCase()}${customerDetail}${orderDetail}`.trim(),
    },
  ];
}

function buildReplySideEffects(payload: Record<string, unknown>): HydratedApprovalSideEffect[] {
  const recipient = asString(payload.recipient) ?? "the customer";
  const channel = asString(payload.channel) ?? "email";
  return [
    {
      label: "Customer reply will be sent",
      detail: `Message will be sent to ${recipient} via ${channel}`,
    },
  ];
}

function buildRefundDetail(payload: Record<string, unknown>): ApprovalDetailV2["refund"] {
  const orderId = asString(payload.orderId);
  const customerId = asString(payload.customerId);
  const amountUsd = asNumber(payload.amountUsd);
  const actionType = asString(payload.actionType);
  const reason = asString(payload.reason);
  if (!orderId || !customerId || amountUsd === null || !actionType || !reason) return null;
  return {
    orderId,
    customerId,
    amountUsd,
    currency: asString(payload.currency),
    actionType,
    reasonCode: asString(payload.reasonCode),
    reason,
  };
}

function buildReplyDetail(payload: Record<string, unknown>): ApprovalDetailV2["reply"] {
  const recipient = asString(payload.recipient);
  const channel = asString(payload.channel);
  const subject = asString(payload.subject);
  const proposedMessage = asString(payload.body);
  if (!recipient || !channel || !subject || !proposedMessage) return null;
  return {
    recipient,
    channel,
    subject,
    proposedMessage,
    originalMessage: asString(payload.originalMessage),
  };
}

function summarize(
  approval: { type: string; payload: Record<string, unknown> },
  refund: ApprovalDetailV2["refund"],
  reply: ApprovalDetailV2["reply"],
): string {
  if (refund) {
    return `Refund request: ${refund.actionType} of $${refund.amountUsd.toFixed(2)} on order ${refund.orderId}`;
  }
  if (reply) {
    return `Reply request: message to ${reply.recipient} via ${reply.channel}`;
  }
  if (approval.type === "hire_agent") {
    const payload = approval.payload as Record<string, unknown>;
    return `Hire request: ${asString(payload.name) ?? "new agent"}`;
  }
  return `${approval.type} approval`;
}

type HydratableApproval = Omit<Approval, "type" | "status"> & { type: string; status: string };

/**
 * Builds the opt-in `?v=2` hydrated detail envelope for an approval: strips the
 * raw gate-specific `payload` by default and replaces it with curated,
 * contract-checked `refund`/`reply`/`sideEffects` fields (see approvalDetailV2Schema).
 */
export function buildHydratedApprovalDetail<T extends HydratableApproval>(
  approval: T,
  options: { includeRawPayload?: boolean } = {},
): ApprovalDetailV2 {
  const payload = approval.payload as Record<string, unknown>;
  const gate = asString(payload.gate);

  let sideEffects: HydratedApprovalSideEffect[] = [];
  let refund: ApprovalDetailV2["refund"] = null;
  let reply: ApprovalDetailV2["reply"] = null;

  if (approval.type === "hire_agent") {
    sideEffects = buildHireAgentSideEffects(payload);
  } else if (approval.type === "request_board_approval" && gate === "gate_a") {
    refund = buildRefundDetail(payload);
    sideEffects = buildRefundSideEffects(payload);
  } else if (approval.type === "request_board_approval" && gate === "gate_b") {
    reply = buildReplyDetail(payload);
    sideEffects = buildReplySideEffects(payload);
  }

  const { payload: _payload, ...base } = approval;

  return {
    ...base,
    type: approval.type as ApprovalDetailV2["type"],
    status: approval.status as ApprovalDetailV2["status"],
    version: 2,
    summary: summarize(approval, refund, reply),
    sideEffects,
    refund,
    reply,
    ...(options.includeRawPayload ? { rawPayload: payload } : {}),
  };
}
