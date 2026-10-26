import { z } from "zod";

const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const MAX_DEPLOYMENT_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
export const deploymentLeasePermitSchema = z.object({
  ownerToken: z.string().regex(/^[a-f0-9]{64}$/),
  expectedLeaseGeneration: generation,
  expectedBootId: z.string().uuid(),
}).strict();
export const deploymentLeaseAcquireSchema = z.object({
  expectedLeaseGeneration: generation,
  expectedBootId: z.string().uuid(),
  ttlMs: z.number().int().positive().max(MAX_DEPLOYMENT_LEASE_TTL_MS),
  takeOverExpired: z.boolean().default(false),
}).strict();
export const deploymentLeaseAdoptSchema = deploymentLeasePermitSchema.extend({ expectedOwnerBootId: z.string().uuid() }).strict();
export const deploymentLeaseRenewSchema = deploymentLeasePermitSchema.extend({
  ttlMs: z.number().int().positive().max(MAX_DEPLOYMENT_LEASE_TTL_MS),
}).strict();
export type DeploymentLeasePermit = z.infer<typeof deploymentLeasePermitSchema>;
export type DeploymentLeaseAcquire = z.infer<typeof deploymentLeaseAcquireSchema>;
export type DeploymentLeaseAdopt = z.infer<typeof deploymentLeaseAdoptSchema>;
export type DeploymentLeaseRenew = z.infer<typeof deploymentLeaseRenewSchema>;
