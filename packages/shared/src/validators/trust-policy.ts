import { z } from "zod";
import { datetimeString } from "./zod-compat.js";
import {
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_PRESET_VERSION,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  TRUST_PRESETS,
} from "../trust-policy.js";

export const trustPresetSchema = z.enum(TRUST_PRESETS);

export const lowTrustOutputPromotionTargetSchema = z.object({
  type: z.literal("issue"),
  issueId: z.uuid(),
}).strict();

export const lowTrustBoundarySchema = z.object({
  mode: z.literal(LOW_TRUST_REVIEW_PRESET),
  companyId: z.uuid().optional(),
  projectIds: z.array(z.uuid()).optional(),
  rootIssueId: z.uuid().optional(),
  issueIds: z.array(z.uuid()).optional(),
  allowedAgentIds: z.array(z.uuid()).optional(),
  allowedSecretBindingIds: z.array(z.uuid()).optional(),
  allowedToolClasses: z.array(z.string().trim().min(1)).optional(),
  outputPromotionTarget: lowTrustOutputPromotionTargetSchema.optional(),
}).strict();

export const lowTrustReviewPresetPolicySchema = z.object({
  id: z.literal(LOW_TRUST_REVIEW_PRESET),
  version: z.literal(LOW_TRUST_REVIEW_PRESET_VERSION),
  rawOutputDisposition: z.literal(LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION),
}).strict();

export const trustAuthorizationPolicySchema = z.object({
  trustPreset: trustPresetSchema.optional(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  trustBoundary: lowTrustBoundarySchema.optional(),
}).catchall(z.unknown());

export const sourceTrustArtifactKindSchema = z.enum(["issue", "comment", "document", "work_product"]);

export const sourceTrustMetadataSchema = z.object({
  preset: trustPresetSchema,
  disposition: z.enum(["quarantined", "promoted"]),
  sourceIssueId: z.uuid().nullable().optional(),
  sourceRunId: z.uuid().nullable().optional(),
  sourceAgentId: z.uuid().nullable().optional(),
  promotedFrom: z.object({
    artifactKind: sourceTrustArtifactKindSchema,
    artifactId: z.uuid(),
    issueId: z.uuid().nullable().optional(),
  }).strict().nullable().optional(),
  promotedByActorType: z.enum(["agent", "user", "system"]).nullable().optional(),
  promotedByActorId: z.string().trim().min(1).nullable().optional(),
  promotedAt: datetimeString({ offset: true }).nullable().optional(),
}).strict();

export type TrustPresetInput = z.infer<typeof trustPresetSchema>;
export type LowTrustBoundaryInput = z.infer<typeof lowTrustBoundarySchema>;
export type TrustAuthorizationPolicyInput = z.infer<typeof trustAuthorizationPolicySchema>;
export type SourceTrustMetadataInput = z.infer<typeof sourceTrustMetadataSchema>;
