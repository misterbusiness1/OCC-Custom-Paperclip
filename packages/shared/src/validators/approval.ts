import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
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

export const decisionReadyApprovalPayloadSchema = z.object({
  recommendedAction: decisionTextSchema,
  reasoning: decisionTextSchema,
  pros: z.array(decisionTextSchema).min(1),
  risks: z.array(decisionTextSchema).min(1),
  originalRequest: approvalOriginalRequestSchema.optional(),
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

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  expectedUpdatedAt: expectedApprovalUpdatedAtSchema,
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  expectedUpdatedAt: expectedApprovalUpdatedAtSchema,
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
