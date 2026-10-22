import { z } from "zod";

export const completedInboxArchiveBodySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  expectedCompletedAt: z.string().datetime({ offset: true }).optional(),
}).strict().default({});

export const completedInboxArchiveResponseSchema = z.union([
  z.object({ id: z.string(), archived: z.literal(false),
    reason: z.enum(["completion_changed", "already_archived"]) }),
  z.object({ issueId: z.string(), archivedAt: z.string().datetime(),
    archived: z.literal(true).optional() }).passthrough(),
]);
