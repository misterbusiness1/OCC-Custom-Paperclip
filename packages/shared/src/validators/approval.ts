import { z } from "zod";
import { multilineTextSchema } from "./text.js";

export const gateABoardApprovalActionTypes = [
  "refund_full",
  "refund_partial",
  "store_credit",
  "gift_card",
  "void_auth",
  "capture_auth",
  "adjustment",
] as const;

export const gateABoardApprovalReasonCodes = [
  "customer_request",
  "fraud_suspected",
  "fulfillment_issue",
  "order_adjustment",
  "tax_fee_correction",
  "goodwill",
] as const;

export const gateBBoardApprovalChannels = [
  "email",
  "helpdesk",
  "klaviyo",
  "sms",
  "whatsapp",
  "ig_dm",
  "fb_dm",
  "marketplace",
] as const;

export const gateBBoardApprovalPriorities = ["normal", "high", "urgent"] as const;

const requestedByAgentPayloadField = z.object({
  requestedByAgentId: z.string().uuid().optional(),
});

export const gateABoardApprovalPayloadSchema = requestedByAgentPayloadField.extend({
  gate: z.literal("gate_a"),
  orderId: z.string().trim().min(1),
  customerId: z.string().trim().min(1),
  amountUsd: z.number().finite().nonnegative(),
  actionType: z.enum(gateABoardApprovalActionTypes),
  reason: multilineTextSchema.pipe(z.string().min(1)),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  wooCommerceTransactionRef: z.string().trim().min(1).optional(),
  reasonCode: z.enum(gateABoardApprovalReasonCodes).optional(),
});

export const gateBBoardApprovalPayloadSchema = requestedByAgentPayloadField.extend({
  gate: z.literal("gate_b"),
  recipient: z.string().trim().min(1),
  channel: z.enum(gateBBoardApprovalChannels),
  subject: z.string().trim().min(1),
  body: multilineTextSchema.pipe(z.string().min(1)),
  originalMessage: multilineTextSchema.pipe(z.string().min(1)).optional(),
  threadOrOrderRef: z.string().trim().min(1),
  contentType: z.enum(["text/plain", "text/html"]).optional(),
  bodyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  threadRef: z.object({
    ticketId: z.string().trim().min(1),
    orderRef: z.string().trim().min(1),
  }).strict().optional(),
  priority: z.enum(gateBBoardApprovalPriorities).optional(),
  slaDeadline: z.string().datetime({ offset: true }).optional(),
  contextPulled: z.object({
    at: z.string().datetime({ offset: true }),
    sources: z.array(z.string().trim().min(1)).min(1),
  }).strict().optional(),
  risks: z.array(z.object({
    code: z.string().trim().min(1),
    description: multilineTextSchema.pipe(z.string().min(1)),
  }).strict()).min(1).optional(),
}).strict();

const genericBoardApprovalPayloadWithDiscriminatorSchema = requestedByAgentPayloadField.extend({
  gate: z.literal("generic"),
  title: z.string().trim().min(1),
  summary: multilineTextSchema.pipe(z.string().min(1)),
  recommendedAction: multilineTextSchema.pipe(z.string().min(1)),
  reasoning: multilineTextSchema.pipe(z.string().min(1)).optional(),
  pros: z.array(multilineTextSchema.pipe(z.string().min(1))).min(1).optional(),
  risks: z.array(multilineTextSchema.pipe(z.string().min(1))).min(1),
  context: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const genericBoardApprovalPayloadSchema = genericBoardApprovalPayloadWithDiscriminatorSchema
  .omit({ gate: true });

export const requestBoardApprovalPayloadSchema = z.preprocess(
  (payload) => (
    typeof payload === "object" && payload !== null && !("gate" in payload)
      ? { ...payload, gate: "generic" }
      : payload
  ),
  z.discriminatedUnion("gate", [
    gateABoardApprovalPayloadSchema.strict(),
    gateBBoardApprovalPayloadSchema,
    genericBoardApprovalPayloadWithDiscriminatorSchema,
  ]).transform((payload) => {
    if (payload.gate !== "generic") return payload;
    const { gate: _gate, ...genericPayload } = payload;
    return genericPayload;
  }),
);

const requestBoardApprovalSchema = z.object({
  type: z.literal("request_board_approval"),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: requestBoardApprovalPayloadSchema,
  issueIds: z.array(z.string().uuid()).optional(),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
});

const passthroughApprovalSchema = z.object({
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export const createApprovalSchema = z.discriminatedUnion("type", [
  requestBoardApprovalSchema,
  passthroughApprovalSchema.extend({ type: z.literal("hire_agent") }),
  passthroughApprovalSchema.extend({ type: z.literal("approve_ceo_strategy") }),
  passthroughApprovalSchema.extend({ type: z.literal("budget_override_required") }),
]);

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

export const hydratedApprovalSideEffectSchema = z.object({
  label: z.string().trim().min(1),
  detail: z.string().nullable(),
}).strict();

export const hydratedApprovalRefundDetailSchema = z.object({
  orderId: z.string().trim().min(1),
  customerId: z.string().trim().min(1),
  amountUsd: z.number().finite().nonnegative(),
  currency: z.string().nullable(),
  actionType: z.string().trim().min(1),
  reasonCode: z.string().nullable(),
  reason: z.string().trim().min(1),
}).strict();

export const hydratedApprovalReplyDetailSchema = z.object({
  recipient: z.string().trim().min(1),
  channel: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  proposedMessage: z.string().trim().min(1),
  originalMessage: z.string().nullable(),
}).strict();

/**
 * Contract-checks the delta the `?v=2` envelope adds over the legacy approval
 * object; the inherited base fields (id, companyId, status, ...) are accepted
 * via passthrough since their shape is already covered by the legacy contract.
 */
export const approvalDetailV2Schema = z.object({
  version: z.literal(2),
  summary: z.string().trim().min(1),
  sideEffects: z.array(hydratedApprovalSideEffectSchema),
  refund: hydratedApprovalRefundDetailSchema.nullable(),
  reply: hydratedApprovalReplyDetailSchema.nullable(),
  rawPayload: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type ApprovalDetailV2Shape = z.infer<typeof approvalDetailV2Schema>;
