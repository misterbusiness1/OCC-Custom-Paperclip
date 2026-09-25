import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

const decisionTextSchema = z.string().trim().min(1);

export const decisionReadyApprovalPayloadSchema = z.object({
  recommendedAction: decisionTextSchema,
  reasoning: decisionTextSchema,
  pros: z.array(decisionTextSchema).min(1),
  risks: z.array(decisionTextSchema).min(1),
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
