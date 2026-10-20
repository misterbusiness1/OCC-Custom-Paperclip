import { z } from "zod";
import { APPROVAL_COST_PERIODS, APPROVAL_STATUSES, APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

const decisionTextSchema = z.string().trim().min(1);

/**
 * Immutable source snapshot shown to the board alongside a recommendation.
 * `text` is verbatim plain text: clients must not summarize or render it as
 * markup. Paperclip comments are re-snapshotted server-side from `commentId`;
 * external sources remain explicitly requester-provided quotations.
 */
export const approvalOriginalRequestSchema = z.object({
  text: z.string().min(1),
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("paperclip_comment"),
      commentId: z.string().guid(),
      issueId: z.string().guid().optional(),
      sender: z.string().min(1).optional(),
      sentAt: z.string().datetime().optional(),
      reference: z.string().min(1).optional(),
      snapshotOrigin: z.literal("server").optional(),
    }),
    z.object({
      kind: z.literal("external"),
      channel: z.string().min(1).optional(),
      sender: z.string().min(1).optional(),
      sentAt: z.string().datetime().optional(),
      reference: z.string().min(1).optional(),
      snapshotOrigin: z.literal("requester").default("requester"),
    }),
  ]),
});

/**
 * What approving costs, as a number the board can sort and compare: an amount in a currency
 * (ISO 4217 code), optionally per billing period. Shown on the request and used to sort by cost.
 */
export const approvalCostSchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().trim().transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, "currency must be a three-letter ISO 4217 code, such as USD")),
  period: z.enum(APPROVAL_COST_PERIODS).nullish().transform((value) => value ?? undefined),
}).strict();

/**
 * `cost` on a board request: the typed object above, checked when the field is an object. A text
 * or a number (what agents wrote before the field was typed) is kept as it is and not read as a cost.
 */
const approvalCostFieldSchema = z.union([z.string(), z.number(), approvalCostSchema]);

/** The time by which the board must decide, as an ISO 8601 date-time with an offset. */
export const approvalDecideBySchema = z.string().datetime({ offset: true });

export const decisionReadyApprovalPayloadSchema = z.object({
  recommendedAction: decisionTextSchema,
  reasoning: decisionTextSchema,
  pros: z.array(decisionTextSchema).min(1),
  risks: z.array(decisionTextSchema).min(1),
  originalRequest: approvalOriginalRequestSchema.optional(),
  cost: approvalCostFieldSchema.optional(),
  decideBy: approvalDecideBySchema.optional(),
}).passthrough();

export const createApprovalInputSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
});

export const createApprovalSchema = createApprovalInputSchema.superRefine((value, ctx) => {
  if (value.type !== "request_board_approval") return;

  const result = decisionReadyApprovalPayloadSchema.safeParse(value.payload);
  if (result.success) return;

  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: "custom",
      message: issue.message,
      path: ["payload", ...issue.path],
    });
  }
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

/**
 * The `updatedAt` of the approval the caller decided on, as the API returned it.
 * Optional. When sent, the server answers 409 if the approval has changed since.
 */
const expectedApprovalUpdatedAtSchema = z.string().datetime({ offset: true }).optional();

/**
 * The `contentVersion` and `status` of the approval the caller decided on, as the API returned
 * them. Optional, and only used with `expectedUpdatedAt`: when both are sent, a newer version that
 * still asks the same thing (an unchanged resubmission) is decided instead of refused with 409.
 */
const expectedApprovalContentVersionSchema = z.string().regex(/^[0-9a-f]{32}$/).optional();
const expectedApprovalStatusSchema = z.enum(APPROVAL_STATUSES).optional();

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  expectedUpdatedAt: expectedApprovalUpdatedAtSchema,
  expectedContentVersion: expectedApprovalContentVersionSchema,
  expectedStatus: expectedApprovalStatusSchema,
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

/** Explicit board retirement is never the default decision/notification path. */
export const retireApprovalSchema = z.object({
  decisionNote: multilineTextSchema.refine((value) => value.trim().length > 0, "A retirement reason is required"),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

export type RetireApproval = z.infer<typeof retireApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  expectedUpdatedAt: expectedApprovalUpdatedAtSchema,
  expectedContentVersion: expectedApprovalContentVersionSchema,
  expectedStatus: expectedApprovalStatusSchema,
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
